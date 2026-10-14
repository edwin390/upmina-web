import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { requireAuthenticated, requireCapability } from "./admin-auth.js";
import {
  GENERIC_ERROR,
  NO_STORE,
  failure,
  isUuid,
  parseBody,
} from "./admin-mfa-recovery-handlers.js";
import {
  readAccountDeletionMailConfig,
  sendAccountDeletionEmail,
} from "./account-deletion-mail.js";
import {
  RUN_SIGNATURE_HEADER,
  RUN_TIMESTAMP_HEADER,
  defaultWorkerDeps,
  runAccountDeletionBatch,
  verifyRunRequest,
  type DeletionDb,
} from "./account-deletion-worker.js";
import type { MailConfig } from "./mfa-recovery-mail.js";

// DEL-2: endpoints de la eliminación irreversible de cuentas (despachados desde api/admin/[action].ts; sin función serverless nueva).
//
//   POST /api/admin/account-deletion-request   sesión → genera el token, guarda SOLO su hash y envía el correo. No bloquea ni borra nada.
//   POST /api/admin/account-deletion-preview   sesión + {token} → {state}. SOLO lectura: abrir el enlace nunca borra ni consume.
//   POST /api/admin/account-deletion-confirm   sesión + {token, confirm:true} → consume el token y bloquea la cuenta (RPC atómica).
//   POST /api/admin/account-deletion-run       interno, firmado por el despertador de la BD (HMAC de dominio propio, cuerpo vacío).
//   GET  /api/admin/account-deletion-alerts    Developer (developer_panel + MFA reciente) → alertas persistentes.
//   POST /api/admin/account-deletion-retry     Developer → reprograma una solicitud fallida/pendiente ({requestId}).
//
// Reglas comunes: la identidad sale SOLO del JWT verificado (el cuerpo nunca aporta usuario); respuestas sin caché y sin Referer; el
// token no se registra ni se devuelve; el gate de cuenta bloqueada vive en requireAuthenticated (aquí solo preview/confirm lo omiten
// para poder informar «ya en eliminación» a una cuenta ya bloqueada).

/** Caducidad del enlace de confirmación. Debe coincidir con el p_ttl_minutes que se pasa a account_deletion_request. */
export const DELETION_TOKEN_TTL_MINUTES = 30;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes en base64url

export interface DeletionHandlerDeps {
  db: () => DeletionDb;
  mail: () => MailConfig | null;
  /** Token de 256 bits. Inyectable solo para tests. */
  newToken: () => string;
  /** Reintento inmediato best-effort tras confirmar/reintentar. Nunca debe lanzar ni bloquear la respuesta. */
  kick: () => Promise<void>;
}

export function defaultDeletionDeps(
  env: NodeJS.ProcessEnv = process.env,
): DeletionHandlerDeps {
  return {
    db: () => {
      const url = env.VITE_SUPABASE_URL?.trim();
      const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
      if (!url || !key) throw new Error("deletion_not_configured");
      return createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      }) as unknown as DeletionDb;
    },
    mail: () => readAccountDeletionMailConfig(env),
    newToken: () => randomBytes(32).toString("base64url"),
    kick: async () => {
      try {
        await Promise.race([
          runAccountDeletionBatch(defaultWorkerDeps(env), { limit: 1, budgetMs: 6_000 }),
          new Promise((resolve) => setTimeout(resolve, 7_000)),
        ]);
      } catch {
        /* el despertador periódico lo reanuda */
      }
    },
  };
}

export const hashDeletionToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

function prepare(
  req: VercelRequest,
  res: VercelResponse,
  method: "GET" | "POST",
): boolean {
  res.setHeader("Cache-Control", NO_STORE);
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method !== method) {
    res.setHeader("Allow", method);
    res.status(405).json({ error: "Método no permitido" });
    return false;
  }
  return true;
}

function messageOf(error: { message?: string } | null): string {
  return typeof error?.message === "string" ? error.message : "";
}

type Row = Record<string, unknown>;
async function callRpc(db: DeletionDb, fn: string, args: Row) {
  const { data, error } = await db.rpc(fn, args);
  return { data: data as unknown, error };
}

// ---------------------------------------------------------------------------------------------
// Solicitud
// ---------------------------------------------------------------------------------------------
export async function handleAccountDeletionRequest(
  req: VercelRequest,
  res: VercelResponse,
  deps: DeletionHandlerDeps = defaultDeletionDeps(),
): Promise<VercelResponse> {
  if (!prepare(req, res, "POST")) return res;
  try {
    const { userId } = await requireAuthenticated(req);
    // La petición NO aporta nada: ni usuario ni correo. Cualquier cuerpo con claves se rechaza.
    const body = req.body === undefined || req.body === "" ? {} : parseBody(req);
    if (!body || Object.keys(body).length > 0)
      return res.status(400).json({ error: "Solicitud inválida" });

    // Fail-closed: sin correo configurado NO se crea ninguna solicitud (nadie podría confirmarla).
    const mail = deps.mail();
    if (!mail) return res.status(503).json({ error: "Servicio no disponible" });

    const token = deps.newToken();
    const db = deps.db();
    const { data, error } = await callRpc(db, "account_deletion_request", {
      p_user_id: userId,
      p_token_hash: hashDeletionToken(token),
      p_ttl_minutes: DELETION_TOKEN_TTL_MINUTES,
    });
    if (error) {
      const m = messageOf(error);
      if (m.includes("privileged_account_requires_procedure"))
        return res
          .status(403)
          .json({ error: "Operación no permitida", code: "privileged_account" });
      if (m.includes("request_too_soon") || m.includes("too_many_requests"))
        return res
          .status(429)
          .json({ error: "Demasiadas solicitudes", code: "rate_limited" });
      if (m.includes("account_deletion_in_progress"))
        return res
          .status(409)
          .json({ error: "Operación no permitida", code: "already_deleting" });
      if (m.includes("no_email") || m.includes("user_not_found"))
        return res.status(400).json({ error: "Solicitud inválida" });
      return res.status(500).json(GENERIC_ERROR);
    }
    const row = data as { requestId?: unknown; email?: unknown } | null;
    if (!row || !isUuid(row.requestId) || typeof row.email !== "string")
      return res.status(500).json(GENERIC_ERROR);

    const sent = await sendAccountDeletionEmail(mail, {
      to: row.email,
      token,
      expiresInMinutes: DELETION_TOKEN_TTL_MINUTES,
      idempotencyKey: `account-deletion:${row.requestId}`,
    });
    // Si el correo no salió, el token nunca existió fuera del servidor: nadie puede confirmarla. La solicitud queda pendiente y
    // caduca sola (o la sustituye la siguiente). Se informa el fallo sin crear ningún estado a medias.
    if (!sent.ok)
      return res
        .status(502)
        .json({ error: "No se pudo enviar el correo", code: "mail_failed" });
    return res
      .status(200)
      .json({ ok: true, expiresInMinutes: DELETION_TOKEN_TTL_MINUTES });
  } catch (err) {
    return failure(res, err);
  }
}

// ---------------------------------------------------------------------------------------------
// Vista previa (solo lectura) y confirmación
// ---------------------------------------------------------------------------------------------
function readToken(body: Row | null): string | null {
  return body && typeof body.token === "string" && TOKEN_RE.test(body.token)
    ? body.token
    : null;
}

export async function handleAccountDeletionPreview(
  req: VercelRequest,
  res: VercelResponse,
  deps: DeletionHandlerDeps = defaultDeletionDeps(),
): Promise<VercelResponse> {
  if (!prepare(req, res, "POST")) return res;
  try {
    const { userId } = await requireAuthenticated(req, { allowDeletingAccount: true });
    const token = readToken(parseBody(req));
    if (!token) return res.status(400).json({ error: "Solicitud inválida" });
    const { data, error } = await callRpc(deps.db(), "account_deletion_preview", {
      p_user_id: userId,
      p_token_hash: hashDeletionToken(token),
    });
    const state = (data as { state?: unknown } | null)?.state;
    if (
      error ||
      !["valid", "expired", "invalid", "already_deleting"].includes(String(state))
    )
      return res.status(500).json(GENERIC_ERROR);
    return res.status(200).json({ state });
  } catch (err) {
    return failure(res, err);
  }
}

export async function handleAccountDeletionConfirm(
  req: VercelRequest,
  res: VercelResponse,
  deps: DeletionHandlerDeps = defaultDeletionDeps(),
): Promise<VercelResponse> {
  if (!prepare(req, res, "POST")) return res;
  try {
    const { userId } = await requireAuthenticated(req, { allowDeletingAccount: true });
    const body = parseBody(req);
    const token = readToken(body);
    // Acción explícita: el literal `confirm: true` (la pantalla solo lo envía tras la confirmación final del usuario).
    if (!token || body?.confirm !== true)
      return res.status(400).json({ error: "Solicitud inválida" });
    const db = deps.db();
    const { data, error } = await callRpc(db, "account_deletion_confirm", {
      p_user_id: userId,
      p_token_hash: hashDeletionToken(token),
    });
    if (error) return res.status(500).json(GENERIC_ERROR);
    const outcome = (data as { outcome?: unknown } | null)?.outcome;
    switch (outcome) {
      case "confirmed":
      case "already_deleting": {
        // Nunca se responde éxito sin comprobar que la barrera DURABLE existe.
        const gate = await callRpc(db, "account_deletion_gate", { p_user_id: userId });
        if (gate.error || (gate.data as { blocked?: unknown } | null)?.blocked !== true)
          return res.status(500).json(GENERIC_ERROR);
        if (outcome === "confirmed") await deps.kick();
        return res
          .status(outcome === "confirmed" ? 202 : 200)
          .json({ status: outcome === "confirmed" ? "accepted" : "already_deleting" });
      }
      case "invalid_token":
        return res
          .status(400)
          .json({ error: "Solicitud inválida", code: "invalid_token" });
      case "expired":
        return res.status(410).json({ error: "El enlace ha caducado", code: "expired" });
      case "privileged_account":
        return res
          .status(403)
          .json({ error: "Operación no permitida", code: "privileged_account" });
      default:
        return res.status(400).json({ error: "Solicitud inválida" });
    }
  } catch (err) {
    return failure(res, err);
  }
}

// ---------------------------------------------------------------------------------------------
// Ejecutor (interno, firmado)
// ---------------------------------------------------------------------------------------------
function header(req: VercelRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export async function handleAccountDeletionRun(
  req: VercelRequest,
  res: VercelResponse,
  run: () => Promise<unknown> = () => runAccountDeletionBatch(defaultWorkerDeps()),
): Promise<VercelResponse> {
  if (!prepare(req, res, "POST")) return res;
  const secret = process.env.ACCOUNT_DELETION_SHARED_SECRET?.trim();
  if (!secret) return res.status(500).json(GENERIC_ERROR); // sin secreto no hay ejecutor (fail-closed)
  if (
    !verifyRunRequest(secret, {
      timestamp: header(req, RUN_TIMESTAMP_HEADER),
      signature: header(req, RUN_SIGNATURE_HEADER),
      nowSeconds: Math.floor(Date.now() / 1000),
    })
  )
    return res.status(401).json({ error: "No autorizado" });
  const body: unknown = req.body;
  const emptyBody =
    body === undefined ||
    body === null ||
    body === "" ||
    (typeof body === "object" &&
      !Array.isArray(body) &&
      Object.keys(body as object).length === 0);
  const extraQuery = Object.keys(req.query ?? {}).some((k) => k !== "action");
  if (!emptyBody || extraQuery)
    return res.status(400).json({ error: "Solicitud inválida" });
  try {
    return res.status(200).json(await run()); // solo recuentos
  } catch {
    console.error("[account-deletion] run failed");
    return res.status(500).json(GENERIC_ERROR);
  }
}

// ---------------------------------------------------------------------------------------------
// Developer: alertas y reintento manual
// ---------------------------------------------------------------------------------------------
export async function handleAccountDeletionAlerts(
  req: VercelRequest,
  res: VercelResponse,
  deps: DeletionHandlerDeps = defaultDeletionDeps(),
): Promise<VercelResponse> {
  if (!prepare(req, res, "GET")) return res;
  try {
    const { userId } = await requireCapability(req, "developer_panel");
    const { data, error } = await callRpc(deps.db(), "account_deletion_alerts", {
      p_actor_user_id: userId,
    });
    if (error) {
      return messageOf(error).includes("actor_not_developer")
        ? res.status(403).json({ error: "No autorizado" })
        : res.status(500).json(GENERIC_ERROR);
    }
    if (!Array.isArray(data)) return res.status(500).json(GENERIC_ERROR);
    return res.status(200).json({ alerts: data });
  } catch (err) {
    return failure(res, err);
  }
}

export async function handleAccountDeletionRetry(
  req: VercelRequest,
  res: VercelResponse,
  deps: DeletionHandlerDeps = defaultDeletionDeps(),
): Promise<VercelResponse> {
  if (!prepare(req, res, "POST")) return res;
  try {
    const { userId } = await requireCapability(req, "developer_panel");
    const body = parseBody(req);
    if (!body || !isUuid(body.requestId) || Object.keys(body).length !== 1)
      return res.status(400).json({ error: "Solicitud inválida" });
    const { data, error } = await callRpc(deps.db(), "account_deletion_developer_retry", {
      p_actor_user_id: userId,
      p_request_id: body.requestId,
    });
    if (error) {
      const m = messageOf(error);
      if (m.includes("actor_not_developer"))
        return res.status(403).json({ error: "No autorizado" });
      if (m.includes("request_not_found"))
        return res.status(404).json({ error: "No encontrado" });
      if (m.includes("already_completed") || m.includes("retry_not_applicable"))
        return res.status(409).json({
          error: "Operación no permitida",
          code: m.includes("already_completed")
            ? "already_completed"
            : "retry_not_applicable",
        });
      return res.status(500).json(GENERIC_ERROR);
    }
    // El reintento solo reprograma; el ejecutor (mismo código que el automático) lo recoge. Aquí se intenta despertarlo ya.
    await deps.kick();
    return res.status(200).json(data ?? { ok: true });
  } catch (err) {
    return failure(res, err);
  }
}
