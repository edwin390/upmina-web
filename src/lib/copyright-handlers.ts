import { createHmac } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, authErrorBody, requireCapability } from "./admin-auth.js";
import {
  CLAIM_PAYLOAD_KEYS,
  validateClaimForm,
  validateReviewNote,
} from "./copyright-claim.js";
import {
  CLAIM_SCOPES,
  NOTE_REQUIRED_ACTIONS,
  REVIEW_ACTIONS,
  decodeClaimCursor,
  encodeClaimCursor,
  isClaimUuid,
  parseClaimDetail,
  parseClaimSummary,
  parseReviewResult,
  type CopyrightClaimScope,
  type CopyrightReviewAction,
} from "./copyright-contract.js";
import { canonicalClient, clientAddress } from "./password-recovery-handlers.js";

// COPY-1 fase 2A. Cuatro acciones dentro del dispatcher existente api/admin/[action].ts (sin función serverless nueva):
//   POST /api/admin/copyright-claim-create   PÚBLICA (titulares sin cuenta). Sin sesión, sin rol, sin MFA: valida, limita y crea.
//   GET  /api/admin/copyright-claims         cola (capacidad `moderation` + MFA reciente).
//   GET  /api/admin/copyright-claim?id=      detalle (idem).
//   POST /api/admin/copyright-claim-review   cambia el estado de la RECLAMACIÓN (idem). NO retira, restaura ni elimina nada.
// Todo pasa por RPC SECURITY DEFINER; las tablas son privadas. No se registra ningún dato del reclamante (ni se envía correo).

const GENERIC_ERROR = { error: "Error interno" };
const INVALID = { error: "Solicitud inválida" };
const MAX_BODY_CHARS = 30_000;

export interface CopyrightDeps {
  /** Cliente service_role (SOLO para las RPC de copyright). null si falta configuración. */
  client: () => SupabaseClient | null;
  /** Material de clave del HMAC de IP, red y correo. null si falta configuración. */
  ipSecret: () => string | null;
}

export function defaultCopyrightDeps(
  env: NodeJS.ProcessEnv = process.env,
): CopyrightDeps {
  const url = env.VITE_SUPABASE_URL?.trim();
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return {
    client: () =>
      url && serviceKey
        ? createClient(url, serviceKey, {
            auth: { persistSession: false, autoRefreshToken: false },
          })
        : null,
    // Solo como material de clave de un HMAC con etiqueta de contexto: no se imprime ni sale del servidor.
    ipSecret: () => serviceKey || null,
  };
}

function parseBody(req: VercelRequest): Record<string, unknown> | null {
  let parsed: unknown = req.body;
  if (typeof parsed === "string") {
    if (parsed.length > MAX_BODY_CHARS) return null;
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function rpcBusinessError(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === "P0001" && typeof message === "string" ? message : null;
}

const hmac = (secret: string, label: string, value: string) =>
  createHmac("sha256", secret)
    .update(`upmina:copyright:${label}:v1:${value}`)
    .digest("hex");

/** Digests HMAC (64 hex) de la IP, de su red y del correo; «unknown» si la IP no se puede determinar. */
export function claimKeys(
  req: VercelRequest,
  secret: string,
  email: string,
): { ip: string; net: string; email: string } {
  const address = clientAddress(req);
  const canonical = address ? canonicalClient(address) : null;
  return {
    ip: canonical ? hmac(secret, "ip", canonical.ip) : "unknown",
    net: canonical ? hmac(secret, "net", canonical.net) : "unknown",
    email: hmac(secret, "email", email),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// PÚBLICA: crear una reclamación
// ---------------------------------------------------------------------------------------------------------------------
export async function handleCopyrightClaimCreate(
  req: VercelRequest,
  res: VercelResponse,
  deps: CopyrightDeps = defaultCopyrightDeps(),
): Promise<VercelResponse> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }
  // Un formulario de otro sitio no puede enviar JSON sin preflight: exigir el tipo frena envíos cruzados triviales.
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json"))
    return res.status(415).json({ error: "Tipo de contenido no admitido" });

  const body = parseBody(req);
  if (!body) return res.status(400).json(INVALID);
  const allowed = new Set([...CLAIM_PAYLOAD_KEYS, "website"]);
  if (Object.keys(body).some((key) => !allowed.has(key)))
    return res.status(400).json(INVALID);

  // Señuelo anti-bots: un campo oculto que una persona nunca rellena. Se responde como si todo fuera bien, sin crear nada.
  if (body.website !== undefined && body.website !== "") {
    return res.status(201).json({ status: "received" });
  }

  const checked = validateClaimForm({
    claimantName: body.claimantName,
    claimantEmail: body.claimantEmail,
    organization: body.organization,
    relationship: body.relationship,
    workDescription: body.workDescription,
    infringementDescription: body.infringementDescription,
    evidenceUrls: body.evidenceUrls,
    postUrl: body.postUrl,
    signature: body.signature,
    statementsAccepted: body.statementsAccepted,
  });
  // El servidor no confía en lo que diga el cliente sobre el identificador de la publicación ni sobre la versión de textos.
  if (checked.ok === false)
    return res.status(400).json({ ...INVALID, fields: Object.keys(checked.errors) });
  if (body.statementVersion !== checked.payload.statementVersion)
    return res.status(400).json({ ...INVALID, fields: ["statementVersion"] });
  if (body.postId !== checked.payload.postId) return res.status(400).json(INVALID);

  const client = deps.client();
  const secret = deps.ipSecret();
  if (!client || !secret) return res.status(503).json(GENERIC_ERROR);

  try {
    const keys = claimKeys(req, secret, checked.payload.claimantEmail);
    const { data, error } = await client.rpc("copyright_claim_create", {
      p_ip: keys.ip,
      p_net: keys.net,
      p_email_key: keys.email,
      p_input: checked.payload,
    });
    if (error) {
      const business = rpcBusinessError(error);
      if (business === "invalid_input" || business === "invalid_argument")
        return res.status(400).json(INVALID);
      return res.status(502).json(GENERIC_ERROR);
    }
    const out =
      data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    if (out?.status === "rate_limited") {
      const raw = Number(out.retryAfterSeconds);
      const retryAfterSeconds = Number.isFinite(raw)
        ? Math.min(86_400, Math.max(1, Math.ceil(raw)))
        : 60;
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ status: "rate_limited", retryAfterSeconds });
    }
    if (
      out?.status === "received" &&
      typeof out.reference === "string" &&
      /^CPY-\d{4}-\d{6}$/.test(out.reference)
    )
      return res.status(201).json({ status: "received", reference: out.reference });
    return res.status(502).json(GENERIC_ERROR);
  } catch {
    return res.status(502).json(GENERIC_ERROR);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// MODERACIÓN: cola, detalle y revisión
// ---------------------------------------------------------------------------------------------------------------------
async function authorizeModerator(
  req: VercelRequest,
  res: VercelResponse,
): Promise<string | null> {
  try {
    const { userId } = await requireCapability(req, "moderation");
    return userId;
  } catch (err) {
    if (err instanceof AdminAuthError) res.status(err.status).json(authErrorBody(err));
    else res.status(500).json(GENERIC_ERROR);
    return null;
  }
}

const REVIEW_ERRORS: Record<string, number> = {
  actor_not_moderator: 403,
  claim_not_found: 404,
  version_conflict: 409,
  invalid_transition: 409,
  note_required: 400,
  invalid_argument: 400,
};

function respondRpcError(res: VercelResponse, error: unknown): VercelResponse {
  const business = rpcBusinessError(error);
  if (business && Object.prototype.hasOwnProperty.call(REVIEW_ERRORS, business))
    return res
      .status(REVIEW_ERRORS[business]!)
      .json({ error: "No se pudo completar la acción", code: business });
  return res.status(500).json(GENERIC_ERROR);
}

const single = (v: unknown): string | undefined | null =>
  v === undefined ? undefined : typeof v === "string" ? v : null;

export async function handleCopyrightClaims(
  req: VercelRequest,
  res: VercelResponse,
  deps: CopyrightDeps = defaultCopyrightDeps(),
): Promise<VercelResponse> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }
  const actor = await authorizeModerator(req, res);
  if (!actor) return res;

  const scopeRaw = single(req.query.scope);
  const cursorRaw = single(req.query.cursor);
  if (scopeRaw === null || cursorRaw === null) return res.status(400).json(INVALID);
  const scope = (scopeRaw ?? "open") as CopyrightClaimScope;
  if (!(CLAIM_SCOPES as readonly string[]).includes(scope))
    return res.status(400).json(INVALID);
  const cursor = cursorRaw === undefined ? null : decodeClaimCursor(cursorRaw);
  if (cursorRaw !== undefined && !cursor) return res.status(400).json(INVALID);

  const client = deps.client();
  if (!client) return res.status(500).json(GENERIC_ERROR);
  try {
    const { data, error } = await client.rpc("copyright_claims_read", {
      p_actor_user_id: actor,
      p_scope: scope,
      p_before_created: cursor?.createdAt ?? null,
      p_before_id: cursor?.id ?? null,
      p_claim_id: null,
    });
    if (error) return respondRpcError(res, error);
    const out = (data ?? {}) as { items?: unknown; next?: unknown };
    if (!Array.isArray(out.items) || out.items.length > 25)
      return res.status(500).json(GENERIC_ERROR);
    const next = out.next as { createdAt?: unknown; id?: unknown } | null;
    const nextCursor =
      next && typeof next.createdAt === "string" && isClaimUuid(next.id)
        ? encodeClaimCursor({ createdAt: next.createdAt, id: next.id })
        : null;
    return res.status(200).json({
      claims: out.items.map(parseClaimSummary),
      nextCursor,
    });
  } catch {
    return res.status(500).json(GENERIC_ERROR);
  }
}

export async function handleCopyrightClaim(
  req: VercelRequest,
  res: VercelResponse,
  deps: CopyrightDeps = defaultCopyrightDeps(),
): Promise<VercelResponse> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }
  const actor = await authorizeModerator(req, res);
  if (!actor) return res;
  const id = single(req.query.id);
  if (!isClaimUuid(id)) return res.status(400).json(INVALID);

  const client = deps.client();
  if (!client) return res.status(500).json(GENERIC_ERROR);
  try {
    const { data, error } = await client.rpc("copyright_claims_read", {
      p_actor_user_id: actor,
      p_scope: "open",
      p_before_created: null,
      p_before_id: null,
      p_claim_id: id,
    });
    if (error) return respondRpcError(res, error);
    const item = (data as { item?: unknown } | null)?.item;
    return res.status(200).json({ claim: parseClaimDetail(item) });
  } catch {
    return res.status(500).json(GENERIC_ERROR);
  }
}

export async function handleCopyrightClaimReview(
  req: VercelRequest,
  res: VercelResponse,
  deps: CopyrightDeps = defaultCopyrightDeps(),
): Promise<VercelResponse> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }
  const actor = await authorizeModerator(req, res);
  if (!actor) return res;

  const body = parseBody(req);
  if (!body) return res.status(400).json(INVALID);
  const allowed = new Set(["id", "action", "expectedVersion", "note"]);
  if (Object.keys(body).some((key) => !allowed.has(key)))
    return res.status(400).json(INVALID);
  const { id, action, expectedVersion, note } = body;
  if (
    !isClaimUuid(id) ||
    typeof action !== "string" ||
    !(REVIEW_ACTIONS as readonly string[]).includes(action) ||
    typeof expectedVersion !== "number" ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 1
  )
    return res.status(400).json(INVALID);
  let cleanNote: string | null = null;
  if (note !== undefined && note !== null) {
    const checked = validateReviewNote(note);
    if (!checked.ok) return res.status(400).json({ ...INVALID, code: "invalid_note" });
    cleanNote = checked.note;
  }
  if (
    cleanNote === null &&
    NOTE_REQUIRED_ACTIONS.includes(action as CopyrightReviewAction)
  )
    return res.status(400).json({ ...INVALID, code: "note_required" });

  const client = deps.client();
  if (!client) return res.status(500).json(GENERIC_ERROR);
  try {
    const { data, error } = await client.rpc("copyright_claim_review", {
      p_actor_user_id: actor,
      p_claim_id: id,
      p_action: action,
      p_expected_version: expectedVersion,
      p_note: cleanNote,
    });
    if (error) return respondRpcError(res, error);
    return res.status(200).json({ claim: parseReviewResult(data) });
  } catch {
    return res.status(500).json(GENERIC_ERROR);
  }
}
