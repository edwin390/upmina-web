import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  AdminAuthError,
  authErrorBody,
  requireAuthenticated,
  requireCapability,
} from "./admin-auth.js";
import {
  APPEAL_PAYLOAD_KEYS,
  APPEAL_STATEMENT_VERSION,
  validateAppealForm,
  validateRemovalReason,
} from "./copyright-appeal.js";
import { multiLine, validateReviewNote } from "./copyright-claim.js";
import {
  isClaimUuid,
  type CopyrightActionResult,
  type CopyrightNoticeErrorClass,
  type CopyrightNoticeKind,
  type CopyrightStrikeApplyResult,
  parseStrikeApplyResult,
  parseStrikeState,
  STRIKE_REASON_MAX,
} from "./copyright-contract.js";
import { defaultCopyrightDeps, type CopyrightDeps } from "./copyright-handlers.js";
import {
  buildAppealLink,
  sendCopyrightNotice,
  type CopyrightMailInput,
} from "./copyright-mail.js";
import { readMailConfig, type MailConfig } from "./mfa-recovery-mail.js";

// COPY-1 fase 2B. Acciones dentro del dispatcher existente api/admin/[action].ts (sin función serverless nueva):
//   POST copyright-claim-remove          retira (OCULTA) la publicación de una reclamación en revisión y avisa al autor.
//   POST copyright-claim-notice          reintenta un aviso fallido (token nuevo para el aviso inicial).
//   POST copyright-claim-appeal-resolve  acepta (restaura si es seguro) o rechaza la apelación, con justificación.
//   POST copyright-claim-purge           eliminación definitiva MANUAL (la RPC repite todas las condiciones).
//   POST copyright-appeal-context        estado de la apelación para el AUTOR (sesión + token).
//   POST copyright-appeal-submit         presenta la apelación (sesión del autor original + token).
//   POST copyright-strike-state          elegibilidad, nivel siguiente, strike aplicado y estado de su aviso (solo lectura).
//   POST copyright-strike-apply          strike MANUAL, solo con la reclamación en `purged`; nivel y duración los calcula la BD.
//   POST copyright-strike-notice         reintenta el aviso (en inglés) de un strike cuyo envío falló.
// Las cuatro primeras exigen la capacidad `moderation` + MFA reciente. Nada se elimina por vencimiento, por cron ni por ningún
// proceso automático; el correo es siempre en inglés y un fallo del correo nunca deshace ni repite la decisión.

const GENERIC_ERROR = { error: "Error interno" };
const INVALID = { error: "Solicitud inválida" };
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface CopyrightRemovalDeps extends CopyrightDeps {
  /** Configuración de correo del servidor (null → los avisos quedan registrados como fallidos y reintentables). */
  mail: () => MailConfig | null;
  /** Token de apelación de 256 bits (base64url). Solo se guarda su SHA-256. */
  newToken: () => string;
  /** Plazo de apelación en minutos que decide el SERVIDOR (60 solo fuera de producción y con la variable de prueba). */
  windowMinutes: () => 60 | 1440;
}

/**
 * Plazo de apelación. Producción SIEMPRE usa 24 h: el plazo reducido de 1 h exige que el entorno sea EXPLÍCITAMENTE de pruebas
 * (VERCEL_ENV «preview» o «development») Y que la variable de prueba valga exactamente «60». Cualquier otra combinación,
 * incluida una ejecución sin VERCEL_ENV, devuelve 24 h (falla hacia el plazo largo).
 */
export function appealWindowMinutes(env: NodeJS.ProcessEnv = process.env): 60 | 1440 {
  const testEnvironment =
    env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "development";
  return testEnvironment && env.COPYRIGHT_TEST_WINDOW_MINUTES?.trim() === "60"
    ? 60
    : 1440;
}

/** Correo de Copyright: reutiliza el generador de la recuperación de MFA, pero el origen del enlace de apelación puede fijarse
 *  aparte con COPYRIGHT_APPEAL_APP_URL (https, sin ruta). Si está definida y no es válida, no se envía nada (fail closed). */
export function readCopyrightMailConfig(
  env: NodeJS.ProcessEnv = process.env,
): MailConfig | null {
  const base = readMailConfig(env);
  const own = env.COPYRIGHT_APPEAL_APP_URL?.trim().replace(/\/+$/, "");
  if (!base || own === undefined || own === "") return base;
  return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(own) ? { ...base, appUrl: own } : null;
}

export function defaultRemovalDeps(
  env: NodeJS.ProcessEnv = process.env,
): CopyrightRemovalDeps {
  return {
    ...defaultCopyrightDeps(env),
    mail: () => readCopyrightMailConfig(env),
    newToken: () => randomBytes(32).toString("base64url"),
    windowMinutes: () => appealWindowMinutes(env),
  };
}

export const hashAppealToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

function parseBody(req: VercelRequest): Record<string, unknown> | null {
  let parsed: unknown = req.body;
  if (typeof parsed === "string") {
    if (parsed.length > 30_000) return null;
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

function businessError(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === "P0001" && typeof message === "string" ? message : null;
}

const MODERATION_ERRORS: Record<string, number> = {
  actor_not_moderator: 403,
  claim_not_found: 404,
  version_conflict: 409,
  invalid_transition: 409,
  confirmation_mismatch: 409,
  post_not_found: 409,
  post_state_conflict: 409,
  post_version_conflict: 409,
  restore_unsafe: 409,
  purge_blocked: 409,
  claim_not_purged: 409,
  author_unavailable: 409,
  self_strike_forbidden: 409,
  strike_already_issued: 409,
  level_changed: 409,
  reason_required: 400,
  note_required: 400,
  invalid_argument: 400,
};

function respondModerationError(res: VercelResponse, error: unknown): VercelResponse {
  const code = businessError(error);
  if (code && Object.prototype.hasOwnProperty.call(MODERATION_ERRORS, code))
    return res
      .status(MODERATION_ERRORS[code]!)
      .json({ error: "No se pudo completar la acción", code });
  return res.status(500).json(GENERIC_ERROR);
}

async function authorizeModerator(
  req: VercelRequest,
  res: VercelResponse,
): Promise<string | null> {
  try {
    return (await requireCapability(req, "moderation")).userId;
  } catch (err) {
    if (err instanceof AdminAuthError) res.status(err.status).json(authErrorBody(err));
    else res.status(500).json(GENERIC_ERROR);
    return null;
  }
}

function prelude(req: VercelRequest, res: VercelResponse): boolean {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Método no permitido" });
    return false;
  }
  return true;
}

const positiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1;
const confirmation = (v: unknown): v is string =>
  typeof v === "string" && /^CPY-\d{4}-\d{6}$/.test(v);

interface NoticeContext {
  authorEmail: string | null;
  reason: string;
  windowMinutes: number;
  resolutionNote?: string | null;
}
function readNotice(value: unknown): NoticeContext | null {
  const n = value as Record<string, unknown> | null;
  if (!n || typeof n !== "object") return null;
  if (typeof n.reason !== "string" || typeof n.windowMinutes !== "number") return null;
  return {
    authorEmail: typeof n.authorEmail === "string" ? n.authorEmail : null,
    reason: n.reason,
    windowMinutes: n.windowMinutes,
    resolutionNote: typeof n.resolutionNote === "string" ? n.resolutionNote : null,
  };
}

/**
 * Envía el aviso y REGISTRA su resultado (enviado o fallido). Un fallo del envío no deshace nada: la decisión ya está tomada y el
 * aviso queda pendiente de reenvío. Si el propio registro falla, el aviso se considera «failed» (la moderación puede reintentar).
 */
async function deliverNotice(
  client: SupabaseClient,
  deps: CopyrightRemovalDeps,
  actor: string,
  claim: { id: string; reference: string; version: number },
  kind: CopyrightNoticeKind,
  notice: NoticeContext,
  token: string | null,
): Promise<{ notice: "sent" | "failed"; noticeError: CopyrightNoticeErrorClass | null }> {
  const config = deps.mail();
  const input: CopyrightMailInput = {
    kind,
    reference: claim.reference,
    reason: notice.reason,
    windowMinutes: notice.windowMinutes,
    resolutionNote: notice.resolutionNote ?? null,
    ...(kind === "removal" && token && config
      ? { appealLink: buildAppealLink(config.appUrl, token) }
      : {}),
  };
  const outcome = await sendCopyrightNotice(config, {
    to: notice.authorEmail,
    idempotencyKey: `copyright:${claim.id}:${kind}:v${claim.version}`,
    input,
  });
  const errorClass: CopyrightNoticeErrorClass | null =
    outcome.ok === false ? outcome.errorClass : null;
  try {
    const { error } = await client.rpc("copyright_claim_notice_record", {
      p_actor_user_id: actor,
      p_claim_id: claim.id,
      p_kind: kind,
      p_ok: outcome.ok,
      p_error_class: errorClass,
    });
    if (error)
      return { notice: "failed", noticeError: errorClass ?? "provider_unavailable" };
  } catch {
    return { notice: "failed", noticeError: errorClass ?? "provider_unavailable" };
  }
  return outcome.ok
    ? { notice: "sent", noticeError: null }
    : { notice: "failed", noticeError: errorClass };
}

function actionBody(
  claim: Record<string, unknown>,
  extra: Partial<CopyrightActionResult>,
): CopyrightActionResult {
  return {
    id: claim.id as string,
    reference: claim.reference as string,
    status: claim.status as CopyrightActionResult["status"],
    version: claim.version as number,
    updatedAt: claim.updatedAt as string,
    notice: "none",
    noticeError: null,
    assetsMarked: null,
    assetsRetained: null,
    postDeleted: null,
    ...extra,
  };
}

// --------------------------------------------------------------------------------------------------------------------------------
export async function handleCopyrightClaimRemove(
  req: VercelRequest,
  res: VercelResponse,
  deps: CopyrightRemovalDeps = defaultRemovalDeps(),
): Promise<VercelResponse> {
  if (!prelude(req, res)) return res;
  const actor = await authorizeModerator(req, res);
  if (!actor) return res;
  const body = parseBody(req);
  if (!body) return res.status(400).json(INVALID);
  const allowed = new Set([
    "id",
    "expectedVersion",
    "expectedPostVersion",
    "confirmReference",
    "reason",
  ]);
  if (Object.keys(body).some((k) => !allowed.has(k)))
    return res.status(400).json(INVALID);
  const { id, expectedVersion, expectedPostVersion, confirmReference, reason } = body;
  if (
    !isClaimUuid(id) ||
    !positiveInt(expectedVersion) ||
    !positiveInt(expectedPostVersion) ||
    !confirmation(confirmReference)
  )
    return res.status(400).json(INVALID);
  const checked = validateRemovalReason(reason);
  if (!checked.ok) return res.status(400).json({ ...INVALID, code: "invalid_reason" });

  const client = deps.client();
  if (!client) return res.status(500).json(GENERIC_ERROR);
  const token = deps.newToken();
  try {
    const { data, error } = await client.rpc("copyright_claim_remove", {
      p_actor_user_id: actor,
      p_claim_id: id,
      p_expected_version: expectedVersion,
      p_expected_post_version: expectedPostVersion,
      p_confirm_reference: confirmReference,
      p_reason: checked.reason,
      p_token_hash: hashAppealToken(token),
      // El plazo lo decide el servidor: el cliente no puede elegirlo.
      p_window_minutes: deps.windowMinutes(),
    });
    if (error) return respondModerationError(res, error);
    const out = data as Record<string, unknown>;
    const notice = readNotice(out.notice);
    if (!notice) return res.status(500).json(GENERIC_ERROR);
    const delivered = await deliverNotice(
      client,
      deps,
      actor,
      { id, reference: out.reference as string, version: out.version as number },
      "removal",
      notice,
      token,
    );
    return res.status(200).json({ claim: actionBody(out, delivered) });
  } catch {
    return res.status(500).json(GENERIC_ERROR);
  }
}

// --------------------------------------------------------------------------------------------------------------------------------
export async function handleCopyrightClaimNotice(
  req: VercelRequest,
  res: VercelResponse,
  deps: CopyrightRemovalDeps = defaultRemovalDeps(),
): Promise<VercelResponse> {
  if (!prelude(req, res)) return res;
  const actor = await authorizeModerator(req, res);
  if (!actor) return res;
  const body = parseBody(req);
  if (!body) return res.status(400).json(INVALID);
  if (Object.keys(body).some((k) => k !== "id" && k !== "kind"))
    return res.status(400).json(INVALID);
  const { id, kind } = body;
  if (
    !isClaimUuid(id) ||
    (kind !== "removal" && kind !== "appeal_accepted" && kind !== "appeal_rejected")
  )
    return res.status(400).json(INVALID);

  const client = deps.client();
  if (!client) return res.status(500).json(GENERIC_ERROR);
  // Aviso inicial: se reemite el token (el anterior deja de valer). Los avisos de resolución no llevan enlace.
  const token = kind === "removal" ? deps.newToken() : null;
  try {
    const { data, error } = await client.rpc("copyright_claim_notice_context", {
      p_actor_user_id: actor,
      p_claim_id: id,
      p_kind: kind,
      p_token_hash: token ? hashAppealToken(token) : null,
    });
    if (error) return respondModerationError(res, error);
    const out = data as Record<string, unknown>;
    const notice = readNotice(out.notice);
    if (!notice) return res.status(500).json(GENERIC_ERROR);
    const delivered = await deliverNotice(
      client,
      deps,
      actor,
      { id, reference: out.reference as string, version: out.version as number },
      kind,
      notice,
      token,
    );
    return res.status(200).json({ claim: actionBody(out, delivered) });
  } catch {
    return res.status(500).json(GENERIC_ERROR);
  }
}

// --------------------------------------------------------------------------------------------------------------------------------
export async function handleCopyrightAppealResolve(
  req: VercelRequest,
  res: VercelResponse,
  deps: CopyrightRemovalDeps = defaultRemovalDeps(),
): Promise<VercelResponse> {
  if (!prelude(req, res)) return res;
  const actor = await authorizeModerator(req, res);
  if (!actor) return res;
  const body = parseBody(req);
  if (!body) return res.status(400).json(INVALID);
  if (
    Object.keys(body).some(
      (k) => !["id", "expectedVersion", "decision", "note"].includes(k),
    )
  )
    return res.status(400).json(INVALID);
  const { id, expectedVersion, decision, note } = body;
  if (
    !isClaimUuid(id) ||
    !positiveInt(expectedVersion) ||
    (decision !== "accept" && decision !== "reject")
  )
    return res.status(400).json(INVALID);
  if (
    note === undefined ||
    note === null ||
    (typeof note === "string" && note.trim() === "")
  )
    return res.status(400).json({ ...INVALID, code: "note_required" });
  const checked = validateReviewNote(note);
  if (!checked.ok) return res.status(400).json({ ...INVALID, code: "invalid_note" });

  const client = deps.client();
  if (!client) return res.status(500).json(GENERIC_ERROR);
  try {
    const { data, error } = await client.rpc("copyright_appeal_resolve", {
      p_actor_user_id: actor,
      p_claim_id: id,
      p_expected_version: expectedVersion,
      p_decision: decision,
      p_note: checked.note,
    });
    if (error) return respondModerationError(res, error);
    const out = data as Record<string, unknown>;
    const notice = readNotice(out.notice);
    if (!notice) return res.status(500).json(GENERIC_ERROR);
    const delivered = await deliverNotice(
      client,
      deps,
      actor,
      { id, reference: out.reference as string, version: out.version as number },
      decision === "accept" ? "appeal_accepted" : "appeal_rejected",
      notice,
      null,
    );
    return res.status(200).json({ claim: actionBody(out, delivered) });
  } catch {
    return res.status(500).json(GENERIC_ERROR);
  }
}

// --------------------------------------------------------------------------------------------------------------------------------
export async function handleCopyrightClaimPurge(
  req: VercelRequest,
  res: VercelResponse,
  deps: CopyrightRemovalDeps = defaultRemovalDeps(),
): Promise<VercelResponse> {
  if (!prelude(req, res)) return res;
  const actor = await authorizeModerator(req, res);
  if (!actor) return res;
  const body = parseBody(req);
  if (!body) return res.status(400).json(INVALID);
  if (
    Object.keys(body).some(
      (k) => !["id", "expectedVersion", "confirmReference", "note"].includes(k),
    )
  )
    return res.status(400).json(INVALID);
  const { id, expectedVersion, confirmReference, note } = body;
  if (
    !isClaimUuid(id) ||
    !positiveInt(expectedVersion) ||
    !confirmation(confirmReference)
  )
    return res.status(400).json(INVALID);
  if (
    note === undefined ||
    note === null ||
    (typeof note === "string" && note.trim() === "")
  )
    return res.status(400).json({ ...INVALID, code: "note_required" });
  const checked = validateReviewNote(note);
  if (!checked.ok) return res.status(400).json({ ...INVALID, code: "invalid_note" });

  const client = deps.client();
  if (!client) return res.status(500).json(GENERIC_ERROR);
  try {
    // La RPC repite TODAS las condiciones bajo lock: el estado del botón en la interfaz no autoriza nada.
    const { data, error } = await client.rpc("copyright_claim_purge", {
      p_actor_user_id: actor,
      p_claim_id: id,
      p_expected_version: expectedVersion,
      p_confirm_reference: confirmReference,
      p_note: checked.note,
    });
    if (error) return respondModerationError(res, error);
    const out = data as Record<string, unknown>;
    return res.status(200).json({
      claim: actionBody(out, {
        assetsMarked: out.assetsMarked as number,
        assetsRetained: out.assetsRetained as number,
        postDeleted: out.postDeleted as boolean,
      }),
    });
  } catch {
    return res.status(500).json(GENERIC_ERROR);
  }
}

// --------------------------------------------------------------------------------------------------------------------------------
// Autor: sesión (cualquier cuenta autenticada; la RPC exige que sea la autora original) + token del enlace.
const APPEAL_ERRORS: Record<string, [number, string]> = {
  appeal_not_available: [404, "appeal_not_available"],
  appeal_already_submitted: [409, "appeal_already_submitted"],
  appeal_window_closed: [409, "appeal_window_closed"],
  invalid_input: [400, "invalid_input"],
};

async function authenticateAuthor(
  req: VercelRequest,
  res: VercelResponse,
): Promise<string | null> {
  try {
    return (await requireAuthenticated(req)).userId;
  } catch (err) {
    if (err instanceof AdminAuthError) res.status(err.status).json(authErrorBody(err));
    else res.status(500).json(GENERIC_ERROR);
    return null;
  }
}

function respondAppealError(res: VercelResponse, error: unknown): VercelResponse {
  const code = businessError(error);
  if (code && Object.prototype.hasOwnProperty.call(APPEAL_ERRORS, code)) {
    const [status, name] = APPEAL_ERRORS[code]!;
    return res
      .status(status)
      .json({ error: "No se pudo completar la acción", code: name });
  }
  return res.status(500).json(GENERIC_ERROR);
}

export interface AppealContextBody {
  reference: string;
  state: "open" | "submitted" | "closed" | "expired";
  reason: string;
  removedAt: string;
  appealDeadline: string | null;
  appealStatus: "pending" | "accepted" | "rejected" | null;
}

export async function handleCopyrightAppealContext(
  req: VercelRequest,
  res: VercelResponse,
  deps: CopyrightRemovalDeps = defaultRemovalDeps(),
): Promise<VercelResponse> {
  if (!prelude(req, res)) return res;
  const user = await authenticateAuthor(req, res);
  if (!user) return res;
  const body = parseBody(req);
  if (!body || Object.keys(body).some((k) => k !== "token"))
    return res.status(400).json(INVALID);
  if (typeof body.token !== "string" || !TOKEN_RE.test(body.token))
    return res.status(404).json({ error: "No encontrado", code: "appeal_not_available" });
  const client = deps.client();
  if (!client) return res.status(500).json(GENERIC_ERROR);
  try {
    const { data, error } = await client.rpc("copyright_appeal_context", {
      p_user_id: user,
      p_token_hash: hashAppealToken(body.token),
    });
    if (error) return respondAppealError(res, error);
    const o = data as Record<string, unknown>;
    const states = ["open", "submitted", "closed", "expired"];
    if (
      typeof o.reference !== "string" ||
      !states.includes(o.state as string) ||
      typeof o.reason !== "string" ||
      typeof o.removedAt !== "string"
    )
      return res.status(500).json(GENERIC_ERROR);
    const appeal: AppealContextBody = {
      reference: o.reference,
      state: o.state as AppealContextBody["state"],
      reason: o.reason,
      removedAt: o.removedAt,
      appealDeadline: typeof o.appealDeadline === "string" ? o.appealDeadline : null,
      appealStatus:
        o.appealStatus === "pending" ||
        o.appealStatus === "accepted" ||
        o.appealStatus === "rejected"
          ? o.appealStatus
          : null,
    };
    return res.status(200).json({ appeal });
  } catch {
    return res.status(500).json(GENERIC_ERROR);
  }
}

export async function handleCopyrightAppealSubmit(
  req: VercelRequest,
  res: VercelResponse,
  deps: CopyrightRemovalDeps = defaultRemovalDeps(),
): Promise<VercelResponse> {
  if (!prelude(req, res)) return res;
  const user = await authenticateAuthor(req, res);
  if (!user) return res;
  const body = parseBody(req);
  if (!body || Object.keys(body).some((k) => k !== "token" && k !== "appeal"))
    return res.status(400).json(INVALID);
  if (typeof body.token !== "string" || !TOKEN_RE.test(body.token))
    return res.status(404).json({ error: "No encontrado", code: "appeal_not_available" });
  const raw = body.appeal as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return res.status(400).json(INVALID);
  if (Object.keys(raw).some((k) => !APPEAL_PAYLOAD_KEYS.includes(k)))
    return res.status(400).json(INVALID);
  const checked = validateAppealForm({
    contactName: raw.contactName,
    contactEmail: raw.contactEmail,
    reason: raw.reason,
    explanation: raw.explanation,
    evidenceText: raw.evidenceText,
    evidenceUrls: raw.evidenceUrls,
    statementAccepted: raw.statementAccepted,
  });
  if (checked.ok === false)
    return res.status(400).json({ ...INVALID, fields: Object.keys(checked.errors) });
  if (raw.statementVersion !== APPEAL_STATEMENT_VERSION)
    return res.status(400).json({ ...INVALID, fields: ["statementVersion"] });

  const client = deps.client();
  if (!client) return res.status(500).json(GENERIC_ERROR);
  try {
    // El cuerpo enviado a la RPC es el NORMALIZADO por el servidor, nunca el crudo del navegador.
    const { data, error } = await client.rpc("copyright_appeal_submit", {
      p_user_id: user,
      p_token_hash: hashAppealToken(body.token),
      p_input: checked.payload,
    });
    if (error) return respondAppealError(res, error);
    const o = data as Record<string, unknown>;
    if (typeof o.reference !== "string") return res.status(500).json(GENERIC_ERROR);
    return res
      .status(201)
      .json({ appeal: { reference: o.reference, state: "submitted" } });
  } catch {
    return res.status(500).json(GENERIC_ERROR);
  }
}

// --------------------------------------------------------------------------------------------------------------------------------
// Strikes manuales de Copyright. Reutilizan el sistema de strikes de Community (RPC copyright_strike_*): nunca se aplican solos.
export async function handleCopyrightStrikeState(
  req: VercelRequest,
  res: VercelResponse,
  deps: CopyrightRemovalDeps = defaultRemovalDeps(),
): Promise<VercelResponse> {
  if (!prelude(req, res)) return res;
  const actor = await authorizeModerator(req, res);
  if (!actor) return res;
  const body = parseBody(req);
  if (!body || Object.keys(body).some((k) => k !== "id") || !isClaimUuid(body.id))
    return res.status(400).json(INVALID);
  const client = deps.client();
  if (!client) return res.status(500).json(GENERIC_ERROR);
  try {
    const { data, error } = await client.rpc("copyright_strike_state", {
      p_actor_user_id: actor,
      p_claim_id: body.id,
    });
    if (error) return respondModerationError(res, error);
    return res.status(200).json({ state: parseStrikeState(data) });
  } catch {
    return res.status(500).json(GENERIC_ERROR);
  }
}

/** Envía el aviso del strike y registra el resultado. Nunca lanza ni deshace el strike; un aviso ya enviado no se repite. */
async function deliverStrikeNotice(
  client: SupabaseClient,
  deps: CopyrightRemovalDeps,
  actor: string,
  claimId: string,
): Promise<{ notice: "sent" | "failed"; noticeError: CopyrightNoticeErrorClass | null }> {
  try {
    const ctx = await client.rpc("copyright_strike_notice_context", {
      p_actor_user_id: actor,
      p_claim_id: claimId,
    });
    if (ctx.error) {
      // «invalid_transition»: el aviso ya se había enviado (o no hay strike): no se repite nada.
      if (businessError(ctx.error) === "invalid_transition")
        return { notice: "sent", noticeError: null };
      return { notice: "failed", noticeError: "provider_unavailable" };
    }
    const out = ctx.data as Record<string, unknown>;
    const strike = out.strike as Record<string, unknown> | null;
    const level = strike?.level;
    if (
      !strike ||
      (level !== 1 && level !== 2 && level !== 3) ||
      typeof strike.reason !== "string"
    )
      return { notice: "failed", noticeError: "invalid_response" };
    const outcome = await sendCopyrightNotice(deps.mail(), {
      to: typeof strike.authorEmail === "string" ? strike.authorEmail : null,
      idempotencyKey: `copyright:${claimId}:strike`,
      input: {
        kind: "strike",
        reference: out.reference as string,
        reason: strike.reason,
        windowMinutes: 0,
        strike: {
          level,
          permanent: strike.permanent === true,
          endsAt: typeof strike.endsAt === "string" ? strike.endsAt : null,
        },
      },
    });
    const errorClass: CopyrightNoticeErrorClass | null =
      outcome.ok === false ? outcome.errorClass : null;
    const rec = await client.rpc("copyright_strike_notice_record", {
      p_actor_user_id: actor,
      p_claim_id: claimId,
      p_ok: outcome.ok,
      p_error_class: errorClass,
    });
    if (rec.error)
      return { notice: "failed", noticeError: errorClass ?? "provider_unavailable" };
    return outcome.ok
      ? { notice: "sent", noticeError: null }
      : { notice: "failed", noticeError: errorClass };
  } catch {
    return { notice: "failed", noticeError: "provider_unavailable" };
  }
}

export async function handleCopyrightStrikeApply(
  req: VercelRequest,
  res: VercelResponse,
  deps: CopyrightRemovalDeps = defaultRemovalDeps(),
): Promise<VercelResponse> {
  if (!prelude(req, res)) return res;
  const actor = await authorizeModerator(req, res);
  if (!actor) return res;
  const body = parseBody(req);
  if (
    !body ||
    Object.keys(body).some((k) => !["id", "reason", "expectedLevel"].includes(k))
  )
    return res.status(400).json(INVALID);
  const reason = multiLine(body.reason, 1, STRIKE_REASON_MAX);
  const expected = body.expectedLevel;
  if (
    !isClaimUuid(body.id) ||
    "error" in reason ||
    (expected !== undefined && expected !== 1 && expected !== 2 && expected !== 3)
  )
    return res.status(400).json(INVALID);
  const client = deps.client();
  if (!client) return res.status(500).json(GENERIC_ERROR);
  try {
    const { data, error } = await client.rpc("copyright_strike_apply", {
      p_actor_user_id: actor,
      p_claim_id: body.id,
      p_reason: reason.value,
      p_expected_level: expected ?? null,
    });
    if (error) return respondModerationError(res, error);
    const applied = data as Record<string, unknown>;
    const delivered = await deliverStrikeNotice(client, deps, actor, body.id);
    const strike: CopyrightStrikeApplyResult = parseStrikeApplyResult({
      ...applied,
      ...delivered,
    });
    return res.status(200).json({ strike });
  } catch {
    return res.status(500).json(GENERIC_ERROR);
  }
}

export async function handleCopyrightStrikeNotice(
  req: VercelRequest,
  res: VercelResponse,
  deps: CopyrightRemovalDeps = defaultRemovalDeps(),
): Promise<VercelResponse> {
  if (!prelude(req, res)) return res;
  const actor = await authorizeModerator(req, res);
  if (!actor) return res;
  const body = parseBody(req);
  if (!body || Object.keys(body).some((k) => k !== "id") || !isClaimUuid(body.id))
    return res.status(400).json(INVALID);
  const client = deps.client();
  if (!client) return res.status(500).json(GENERIC_ERROR);
  return res.status(200).json(await deliverStrikeNotice(client, deps, actor, body.id));
}
