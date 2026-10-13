import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  AdminAuthError,
  authErrorBody,
  getPrivilegedRoleForUser,
  identityHasRecentPassword,
  requireAuthenticated,
  requireCapability,
  type AuthenticatedIdentity,
  type PrivilegedRole,
} from "./admin-auth.js";
import {
  hashChallenge,
  isChallengeToken,
  newChallengeToken,
  parseFactorIds,
  runRecoveryDeletion,
  sendRecoveryMail,
  type MailOutcome,
  type RecoveryClient,
} from "./admin-mfa-recovery.js";
import {
  mapResendEvent,
  readMailConfig,
  verifyResendWebhook,
  type MailConfig,
} from "./mfa-recovery-mail.js";

// MFA fase 2 — endpoints de la recuperación de un autenticador perdido.
//
//   GET/POST /api/admin/mfa-recovery          titular (cualquier rol privilegiado, aal1 basta):
//        GET    estado de SU solicitud; POST {op: request|resend|verify|cancel|execute|complete}.
//   GET/POST /api/admin/mfa-recovery-admin    ADMIN con MFA reciente (team_admin): lista y
//        {op: approve|deny|cancel|resend_notice, recovery_id, reason?}.
//   POST     /api/admin/mfa-recovery-webhook  eventos firmados de Resend (entrega / fallo).
//
// Seguridad: el user_id del titular sale SIEMPRE del JWT verificado; el body nunca lo elige y la
// solicitud a ejecutar/cancelar se resuelve en servidor. Las operaciones del titular exigen además
// un inicio de sesión con CONTRASEÑA reciente (claim amr verificado). Las reglas de estado, aprobación
// (otro admin, nunca el titular), caducidad e instantánea viven en la base de datos. Ningún secreto
// (desafío, hash, token) se devuelve ni se registra; el desafío solo viaja en el correo al titular.

export const GENERIC_ERROR = { error: "Error interno" };
export const FORBIDDEN = { error: "No autorizado" };
export const INVALID = { error: "Solicitud inválida" };
export const NO_STORE = "no-store";

export interface RecoveryDeps {
  client: () => RecoveryClient;
  mail: () => MailConfig | null;
}

export function defaultDeps(): RecoveryDeps {
  return {
    client: () => {
      const url = process.env.VITE_SUPABASE_URL?.trim();
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
      if (!url || !key) throw new Error("Supabase no configurado");
      return createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    },
    mail: () => readMailConfig(),
  };
}

/** Motivo de rechazo de la base de datos → [HTTP, code]. Lista CERRADA: lo demás es 500. */
const REASONS: Record<string, [number, string]> = {
  not_privileged: [403, "forbidden"],
  forbidden: [403, "forbidden"],
  self_approval: [403, "forbidden"],
  email_unverified: [409, "email_unverified"],
  active_request: [409, "active_request"],
  rate_limited: [429, "rate_limited"],
  no_approver: [409, "no_approver"],
  no_request: [404, "no_request"],
  not_found: [404, "no_request"],
  expired: [410, "expired"],
  email_changed: [409, "email_changed"],
  role_changed: [409, "role_changed"],
  challenge_expired: [410, "challenge_expired"],
  locked: [423, "locked"],
  invalid: [400, "invalid_code"],
  too_soon: [429, "too_soon"],
  send_limit: [429, "send_limit"],
  not_pending: [409, "not_pending"],
  not_cancellable: [409, "not_cancellable"],
  reason_required: [400, "reason_required"],
  new_factor_required: [409, "new_factor_required"],
  too_many_factors: [409, "too_many_factors"],
  not_approved: [409, "not_approved"],
  waiting: [409, "waiting"],
  notice_pending: [409, "notice_pending"],
  notice_failed: [409, "notice_failed"],
  // Recordatorio del aviso de aprobación (máximo 3, 60 s entre ellos)
  reminder_limit: [429, "reminder_limit"],
  notice_not_delivered: [409, "notice_not_delivered"],
  // Developer Panel V1 (aprobación excepcional)
  peer_available: [409, "peer_available"],
  not_eligible: [409, "not_eligible"],
};

export function reject(res: VercelResponse, reason: unknown): VercelResponse {
  const hit = typeof reason === "string" ? REASONS[reason] : undefined;
  if (!hit) return res.status(500).json(GENERIC_ERROR);
  return res.status(hit[0]).json({ error: "Operación no permitida", code: hit[1] });
}

export type Row = Record<string, unknown>;

/** Llama a una RPC que devuelve jsonb. Cualquier error o forma inesperada lanza (→ 500). */
export async function rpc(
  client: Pick<RecoveryClient, "rpc">,
  fn: string,
  args: Record<string, unknown>,
): Promise<Row> {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    const e = error as { code?: unknown; message?: unknown };
    if (
      e.code === "P0001" &&
      (e.message === "actor_not_admin" || e.message === "actor_not_developer")
    ) {
      throw new AdminAuthError("No autorizado", 403);
    }
    throw new Error("rpc_failed");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("rpc_shape");
  return data as Row;
}

export function parseBody(req: VercelRequest): Row | null {
  let parsed: unknown = req.body;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Row)
    : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export function mailSummary(outcome: MailOutcome | null): {
  status: string;
  error_class?: string;
} {
  if (!outcome) return { status: "not_attempted" };
  if (outcome.status === "failed")
    return { status: "failed", error_class: outcome.errorClass };
  return { status: outcome.status };
}

export function failure(res: VercelResponse, err: unknown): VercelResponse {
  if (err instanceof AdminAuthError)
    return res.status(err.status).json(authErrorBody(err));
  return res.status(500).json(GENERIC_ERROR);
}

// ---------------------------------------------------------------------------------------------
// Cierre de la recuperación (reconciliación idempotente, SIEMPRE decidida en el servidor)
// ---------------------------------------------------------------------------------------------
interface FinishResult {
  ok: boolean;
  /** Motivo de la base cuando ok es false (p. ej. new_factor_required). */
  reason?: unknown;
  /** true si la solicitud YA estaba completada (no se repite ningún efecto). */
  already: boolean;
  mail: MailOutcome | null;
}

/**
 * Pide a la base que cierre la recuperación. La base decide con evidencia de Supabase Auth: la sesión
 * VERIFICADA del JWT debe estar en aal2 con un TOTP verificado del titular que no figure en ninguna
 * instantánea y se creara después de invalidar el anterior. Ninguna señal del navegador cuenta.
 * Idempotente: si ya está completada no repite eventos ni correos; el correo de finalización se envía
 * una sola vez (clave de idempotencia) y su fallo no revierte nada.
 */
async function finishRecovery(
  client: RecoveryClient,
  deps: RecoveryDeps,
  identity: Pick<AuthenticatedIdentity, "userId" | "sessionId">,
): Promise<FinishResult> {
  const out = await rpc(client, "admin_mfa_recovery_complete", {
    p_user_id: identity.userId,
    p_session_id: identity.sessionId ?? null,
  });
  if (out.ok !== true)
    return { ok: false, reason: out.reason, already: false, mail: null };
  const already = out.already === true;
  let mail: MailOutcome | null = null;
  const cfg = deps.mail();
  if (!already && cfg && isUuid(out.recoveryId) && typeof out.email === "string") {
    mail = await sendRecoveryMail(client, cfg.sender, {
      recoveryId: out.recoveryId,
      kind: "completed",
      baseKey: `recovery:${out.recoveryId}:completed`,
      to: out.email,
      spec: { kind: "completed" },
    });
  }
  return { ok: true, already, mail };
}

/**
 * Reconciliación al acceder a una zona privilegiada (la invoca GET /api/admin/access cuando la
 * sesión VERIFICADA es de un miembro con MFA reciente). Reutiliza finishRecovery: no hay un segundo
 * mecanismo de cierre. Nunca lanza ni altera la respuesta de quien la llama; sin recuperación
 * pendiente o sin evidencia, la base responde que no hay nada que cerrar.
 */
export async function reconcileRecoveryOnAccess(
  identity: Pick<AuthenticatedIdentity, "userId" | "sessionId">,
  deps: RecoveryDeps = defaultDeps(),
): Promise<void> {
  try {
    await finishRecovery(deps.client(), deps, identity);
  } catch {
    /* mejor esfuerzo: el acceso no depende de esto */
  }
}

// ---------------------------------------------------------------------------------------------
// Titular
// ---------------------------------------------------------------------------------------------
interface Member {
  identity: AuthenticatedIdentity;
  role: PrivilegedRole;
}

async function authorizeMember(req: VercelRequest): Promise<Member> {
  const identity = await requireAuthenticated(req);
  const role = await getPrivilegedRoleForUser(identity.userId);
  if (role === null) throw new AdminAuthError("No autorizado", 403);
  return { identity, role };
}

export async function handleAdminMfaRecovery(
  req: VercelRequest,
  res: VercelResponse,
  deps: RecoveryDeps = defaultDeps(),
): Promise<VercelResponse> {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Método no permitido" });
  }
  res.setHeader("Cache-Control", NO_STORE);
  try {
    const { identity, role } = await authorizeMember(req);
    const userId = identity.userId;
    const client = deps.client();
    const recentLogin = identityHasRecentPassword(identity);

    if (req.method === "GET") {
      let current = await rpc(client, "admin_mfa_recovery_current", {
        p_user_id: userId,
      });
      if (current.status === "factors_deleted") {
        // Reconciliación al consultar el estado: si el TOTP nuevo ya está verificado en ESTA sesión
        // (según la base), la recuperación se cierra aquí. Un fallo o «todavía no» deja el estado
        // como está; nunca se marca completada sin evidencia.
        try {
          const done = await finishRecovery(client, deps, identity);
          if (done.ok) {
            current = await rpc(client, "admin_mfa_recovery_current", {
              p_user_id: userId,
            });
          }
        } catch {
          /* se mantiene factors_deleted */
        }
      }
      return res.status(200).json({
        ...current,
        role,
        recentLogin,
        aal: identity.aal,
        mailConfigured: deps.mail() !== null,
      });
    }

    const body = parseBody(req);
    const op = body?.op;
    if (typeof op !== "string") return res.status(400).json(INVALID);

    // Credenciales recientes: obligatorias en toda operación que avance el proceso.
    if (["request", "resend", "verify", "execute"].includes(op) && !recentLogin) {
      return res
        .status(403)
        .json({ error: "No autorizado", code: "recent_login_required" });
    }

    switch (op) {
      case "request":
      case "resend": {
        const cfg = deps.mail();
        if (!cfg)
          return res
            .status(503)
            .json({ error: "Servicio no disponible", code: "mail_unavailable" });
        const token = newChallengeToken();
        const out = await rpc(
          client,
          op === "request" ? "admin_mfa_recovery_create" : "admin_mfa_recovery_resend",
          { p_user_id: userId, p_challenge_hash: hashChallenge(token) },
        );
        if (out.ok !== true) return reject(res, out.reason);
        if (
          !isUuid(out.recoveryId) ||
          typeof out.email !== "string" ||
          !Number.isInteger(out.sends)
        ) {
          return res.status(500).json(GENERIC_ERROR);
        }
        const mail = await sendRecoveryMail(client, cfg.sender, {
          recoveryId: out.recoveryId,
          kind: "challenge",
          baseKey: `recovery:${out.recoveryId}:challenge:${out.sends}`,
          to: out.email,
          spec: {
            kind: "challenge",
            link: `${cfg.appUrl}/admin/mfa/recovery#c=${token}`,
            expiresMinutes: 15,
          },
        });
        return res.status(200).json({
          recovery_id: out.recoveryId,
          status: "pending_email",
          mail: mailSummary(mail),
        });
      }

      case "verify": {
        if (!isChallengeToken(body?.token))
          return res.status(400).json({ ...INVALID, code: "invalid_code" });
        const out = await rpc(client, "admin_mfa_recovery_verify", {
          p_user_id: userId,
          p_challenge_hash: hashChallenge(body.token as string),
        });
        if (out.ok !== true) return reject(res, out.reason);
        return res.status(200).json({ status: "pending_approval" });
      }

      case "cancel": {
        const current = await rpc(client, "admin_mfa_recovery_current", {
          p_user_id: userId,
        });
        if (!isUuid(current.recoveryId)) return reject(res, "no_request");
        const out = await rpc(client, "admin_mfa_recovery_cancel", {
          p_recovery_id: current.recoveryId,
          p_actor_user_id: userId,
        });
        if (out.ok !== true) return reject(res, out.reason);
        const cfg = deps.mail();
        const mail =
          cfg && typeof out.email === "string"
            ? await sendRecoveryMail(client, cfg.sender, {
                recoveryId: current.recoveryId,
                kind: "closed",
                baseKey: `recovery:${current.recoveryId}:closed`,
                to: out.email,
                spec: { kind: "closed", reason: "cancelled" },
              })
            : null;
        return res.status(200).json({ status: "cancelled", mail: mailSummary(mail) });
      }

      case "execute": {
        const current = await rpc(client, "admin_mfa_recovery_current", {
          p_user_id: userId,
        });
        if (!isUuid(current.recoveryId)) return reject(res, "no_request");
        const begin = await rpc(client, "admin_mfa_recovery_begin_execute", {
          p_user_id: userId,
          p_recovery_id: current.recoveryId,
        });
        if (begin.ok !== true) return reject(res, begin.reason);
        if (begin.already === true)
          return res.status(200).json({ status: "factors_deleted" });
        const factorIds = parseFactorIds(begin.factorIds);
        if (!factorIds) return res.status(500).json(GENERIC_ERROR);
        const outcome = await runRecoveryDeletion(client, userId, {
          recoveryId: current.recoveryId,
          factorIds,
        });
        // Un fallo parcial NO es un error de la solicitud: queda «executing» y se puede reintentar.
        return res
          .status(200)
          .json(
            outcome.status === "factors_deleted"
              ? { status: "factors_deleted", factors_deleted: outcome.factorsDeleted }
              : { status: "executing", error_class: outcome.errorClass },
          );
      }

      case "complete": {
        // Se conserva por compatibilidad (la interfaz ya no la usa): misma reconciliación del servidor.
        const done = await finishRecovery(client, deps, identity);
        if (!done.ok) return reject(res, done.reason);
        return res
          .status(200)
          .json({ status: "completed", mail: mailSummary(done.mail) });
      }

      default:
        return res.status(400).json(INVALID);
    }
  } catch (err) {
    return failure(res, err);
  }
}

// ---------------------------------------------------------------------------------------------
// Avisos al titular (compartidos por Admin y Developer: un solo camino de envío e idempotencia)
// ---------------------------------------------------------------------------------------------
/** Aviso de cierre (rechazo / cancelación). Clave de idempotencia: una vez por solicitud y motivo. */
export function sendClosedNotice(
  client: RecoveryClient,
  cfg: MailConfig,
  params: { recoveryId: string; email: string; reason: "denied" | "cancelled" },
): Promise<MailOutcome> {
  return sendRecoveryMail(client, cfg.sender, {
    recoveryId: params.recoveryId,
    kind: "closed",
    baseKey: `recovery:${params.recoveryId}:closed`,
    to: params.email,
    spec: { kind: "closed", reason: params.reason },
  });
}

/**
 * Aviso de aprobación con el enlace de cancelación. El token es de un solo uso y ligado a ESTA
 * solicitud (solo su hash se guarda); cada reenvío rota el token y usa otra clave de idempotencia.
 * `exceptional` solo cambia el TEXTO (autorizado por un Developer): enlace, token y envío son los mismos.
 */
export function sendApprovedNotice(
  client: RecoveryClient,
  cfg: MailConfig,
  params: {
    recoveryId: string;
    email: string;
    token: string;
    rotation: number;
    exceptional?: boolean;
  },
): Promise<MailOutcome> {
  return sendRecoveryMail(client, cfg.sender, {
    recoveryId: params.recoveryId,
    kind: "approved",
    baseKey: `recovery:${params.recoveryId}:approved:${params.rotation}`,
    to: params.email,
    spec: {
      kind: "approved",
      waitMinutes: 15,
      cancelLink: `${cfg.appUrl}/admin/mfa/recovery/cancel#t=${params.token}`,
      ...(params.exceptional ? { exceptional: true } : {}),
    },
  });
}

/**
 * Recordatorio del aviso de aprobación YA ENTREGADO (compartido por Admin y Developer). Es un correo independiente
 * (tipo `reminder`): la base lo autoriza y lo reserva bajo el bloqueo de la solicitud (solo `approved` con aviso
 * entregado, máximo 3, mínimo 60 s entre envíos) y NO rota el enlace de cancelación, NO cambia el estado de la
 * solicitud y NO reinicia la espera de 15 minutos (esa espera solo mira el aviso de tipo `approved`). El enlace de
 * cancelación original no se reenvía: el recordatorio explica cómo cancelar desde la cuenta.
 */
export async function remindApprovedNotice(
  client: RecoveryClient,
  cfg: MailConfig | null,
  recoveryId: string,
  actorId: string,
  res: VercelResponse,
): Promise<VercelResponse> {
  // Sin correo configurado no se reserva ningún recordatorio (no consumir el máximo sin poder enviar).
  if (!cfg) {
    return res
      .status(503)
      .json({ error: "Servicio no disponible", code: "mail_unavailable" });
  }
  // El actor (quien pide el recordatorio) sale del JWT verificado y queda registrado en la auditoría de la solicitud.
  const out = await rpc(client, "admin_mfa_recovery_reminder_start", {
    p_recovery_id: recoveryId,
    p_actor_user_id: actorId,
  });
  if (out.ok !== true) return reject(res, out.reason);
  const mail =
    typeof out.email === "string" && typeof out.baseKey === "string"
      ? await sendRecoveryMail(client, cfg.sender, {
          recoveryId,
          kind: "reminder",
          baseKey: out.baseKey,
          to: out.email,
          spec: {
            kind: "reminder",
            waitMinutes: 15,
            recoveryPageUrl: `${cfg.appUrl}/admin/mfa/recovery`,
          },
        })
      : null;
  return res.status(200).json({ status: "approved", reminder: mailSummary(mail) });
}

// ---------------------------------------------------------------------------------------------
// ADMIN
// ---------------------------------------------------------------------------------------------
function toListItem(raw: unknown): Row | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Row;
  if (!isUuid(r.out_id) || !isUuid(r.out_user_id) || typeof r.out_status !== "string")
    return null;
  return {
    id: r.out_id,
    user_id: r.out_user_id,
    username: typeof r.out_username === "string" ? r.out_username : null,
    role: r.out_role,
    status: r.out_status,
    requested_at: r.out_requested_at,
    email_verified_at: r.out_email_verified_at ?? null,
    expires_at: r.out_expires_at,
    approved_at: r.out_approved_at ?? null,
    notice_state: typeof r.out_notice_state === "string" ? r.out_notice_state : null,
    readiness: r.out_readiness,
  };
}

async function adminList(client: RecoveryClient, actorId: string): Promise<Row[]> {
  const { data, error } = await client.rpc("admin_mfa_recoveries_pending", {
    p_actor_user_id: actorId,
  });
  if (error || !Array.isArray(data)) throw new Error("list_failed");
  const items: Row[] = [];
  for (const raw of data) {
    const item = toListItem(raw);
    if (!item) throw new Error("list_shape");
    items.push(item);
  }
  return items;
}

export async function handleAdminMfaRecoveryAdmin(
  req: VercelRequest,
  res: VercelResponse,
  deps: RecoveryDeps = defaultDeps(),
): Promise<VercelResponse> {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Método no permitido" });
  }
  res.setHeader("Cache-Control", NO_STORE);
  try {
    // ADMIN (team_admin) + MFA reciente. Moderator/developer reciben 403 aquí.
    const { userId: actorId } = await requireCapability(req, "team_admin");
    const client = deps.client();

    if (req.method === "GET") {
      return res.status(200).json({ recoveries: await adminList(client, actorId) });
    }

    const body = parseBody(req);
    const op = body?.op;
    const recoveryId = body?.recovery_id;
    if (typeof op !== "string" || !isUuid(recoveryId))
      return res.status(400).json(INVALID);
    const cfg = deps.mail();

    const sendClosed = async (email: unknown, reason: "denied" | "cancelled") =>
      cfg && typeof email === "string"
        ? sendClosedNotice(client, cfg, { recoveryId, email, reason })
        : null;
    const sendApproved = async (email: unknown, token: string, rotation: unknown) =>
      cfg &&
      typeof email === "string" &&
      typeof rotation === "number" &&
      Number.isInteger(rotation)
        ? sendApprovedNotice(client, cfg, { recoveryId, email, token, rotation })
        : null;

    switch (op) {
      case "approve": {
        const cancelToken = newChallengeToken();
        const out = await rpc(client, "admin_mfa_recovery_approve", {
          p_recovery_id: recoveryId,
          p_actor_user_id: actorId,
          p_cancel_hash: hashChallenge(cancelToken),
        });
        if (out.ok !== true) return reject(res, out.reason);
        // El aviso NO bloquea la aprobación, pero sin entrega confirmada la ejecución no se habilita.
        return res.status(200).json({
          status: "approved",
          notice: mailSummary(
            await sendApproved(out.email, cancelToken, out.cancelRotation),
          ),
        });
      }
      case "deny": {
        const reason = typeof body?.reason === "string" ? body.reason : "";
        const out = await rpc(client, "admin_mfa_recovery_deny", {
          p_recovery_id: recoveryId,
          p_actor_user_id: actorId,
          p_reason: reason,
        });
        if (out.ok !== true) return reject(res, out.reason);
        return res.status(200).json({
          status: "denied",
          notice: mailSummary(await sendClosed(out.email, "denied")),
        });
      }
      case "cancel": {
        const out = await rpc(client, "admin_mfa_recovery_cancel", {
          p_recovery_id: recoveryId,
          p_actor_user_id: actorId,
        });
        if (out.ok !== true) return reject(res, out.reason);
        return res.status(200).json({
          status: "cancelled",
          notice: mailSummary(await sendClosed(out.email, "cancelled")),
        });
      }
      case "resend_notice": {
        // Solo para una aprobada de la lista autorizada; el correo se lee con la API oficial de Auth.
        const target = (await adminList(client, actorId)).find(
          (i) => i.id === recoveryId && i.status === "approved",
        );
        if (!target) return reject(res, "not_found");
        // Un aviso ya ENTREGADO conserva su enlace de cancelación: no se rota ni se reenvía. En su lugar se envía un
        // recordatorio independiente (sin enlace) que no cambia el estado ni la espera.
        if (target.notice_state === "delivered") {
          return remindApprovedNotice(client, cfg, recoveryId, actorId, res);
        }
        const cancelToken = newChallengeToken();
        const out = await rpc(client, "admin_mfa_recovery_set_cancel", {
          p_recovery_id: recoveryId,
          p_cancel_hash: hashChallenge(cancelToken),
        });
        if (out.ok !== true)
          return reject(
            res,
            out.reason === "already_delivered" ? "not_pending" : out.reason,
          );
        return res.status(200).json({
          status: "approved",
          notice: mailSummary(
            await sendApproved(out.email, cancelToken, out.cancelRotation),
          ),
        });
      }
      default:
        return res.status(400).json(INVALID);
    }
  } catch (err) {
    return failure(res, err);
  }
}

// ---------------------------------------------------------------------------------------------
// Webhook del proveedor
// ---------------------------------------------------------------------------------------------
function header(req: VercelRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Lee el flujo de la petición. En el runtime de Vercel el cuerpo ya fue leído para construir
 *  `req.body`, pero el flujo se REPONE (los listeners de «data»/«end» reciben los bytes originales).
 *  Si el flujo ya se consumió sin reposición, 'end' nunca llega y vence el tiempo. */
function collectStream(req: VercelRequest, timeoutMs: number): Promise<string | null> {
  const stream = req as unknown as {
    on?: (event: string, cb: (arg?: unknown) => void) => unknown;
  };
  if (typeof stream.on !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let finished = false;
    const finish = (value: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    stream.on!("data", (chunk) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))),
    );
    stream.on!("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    stream.on!("error", () => finish(null));
  });
}

/**
 * Cuerpo ORIGINAL de la petición para verificar la firma. Orden: (1) los bytes del flujo, sin tocar
 * `req.body` (el análisis de JSON de Vercel reordena/normaliza); (2) si no hay flujo utilizable, un
 * cuerpo en texto/Buffer; (3) en último lugar, la reserialización del JSON ya analizado, que puede NO
 * coincidir byte a byte y entonces la firma falla (cerrado: nunca autoriza algo que no esté firmado).
 */
async function readRawBody(req: VercelRequest): Promise<string> {
  const streamed = await collectStream(req, 2000);
  if (streamed !== null && streamed.length > 0) return streamed;
  const parsed = req.body;
  if (typeof parsed === "string") return parsed;
  if (Buffer.isBuffer(parsed)) return parsed.toString("utf8");
  return JSON.stringify(parsed ?? null);
}

/**
 * Eventos firmados de Resend. Sin firma válida → 401 y NINGÚN cambio de estado (el aviso nunca llega
 * a «delivered» y la ejecución sigue bloqueada: falla cerrado). La verificación necesita el cuerpo
 * EXACTO: se usa el cuerpo en bruto si el runtime lo conserva; si solo hay JSON ya analizado se
 * reserializa, lo que puede no coincidir byte a byte (a validar en la prueba real con Resend).
 */
export async function handleAdminMfaRecoveryWebhook(
  req: VercelRequest,
  res: VercelResponse,
  deps: RecoveryDeps = defaultDeps(),
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) return res.status(503).json({ error: "Servicio no disponible" });
  const rawBody = await readRawBody(req);
  const valid = verifyResendWebhook({
    secret,
    id: header(req, "svix-id"),
    timestamp: header(req, "svix-timestamp"),
    signature: header(req, "svix-signature"),
    body: rawBody,
  });
  if (!valid) return res.status(401).json(FORBIDDEN);

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json(INVALID);
  }
  const type = (payload as { type?: unknown } | null)?.type;
  const emailId = (payload as { data?: { email_id?: unknown } } | null)?.data?.email_id;
  const event = mapResendEvent(type);
  if (
    !event ||
    typeof emailId !== "string" ||
    emailId.length === 0 ||
    emailId.length > 120
  ) {
    return res.status(200).json({ ok: true, ignored: true });
  }
  try {
    const { data, error } = await deps.client().rpc("admin_mfa_recovery_mail_event", {
      p_provider_message_id: emailId,
      p_event: event,
    });
    if (error) return res.status(500).json(GENERIC_ERROR); // Resend reintentará
    // El evento puede llegar ANTES de que se registre el id del envío (carrera): se pide reintento.
    if (data === "unknown_message")
      return res.status(503).json({ error: "Servicio no disponible" });
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(500).json(GENERIC_ERROR);
  }
}

// ---------------------------------------------------------------------------------------------
// Cancelación desde el enlace del correo de aprobación (SIN sesión, SIN TOTP)
// ---------------------------------------------------------------------------------------------
/**
 * POST /api/admin/mfa-recovery-cancel {op: "check" | "cancel", token}. Solo puede CANCELAR: no
 * aprueba, no ejecuta y no toca roles. `check` no modifica nada (lo usa la pantalla de confirmación) y
 * la cancelación real exige un POST explícito con op «cancel»: un GET (o un escáner de enlaces del
 * correo, que además no ejecuta el JavaScript de la página) nunca cancela. Cualquier enlace inválido,
 * usado, caducado o de una solicitud ya cerrada recibe la MISMA respuesta (404), sin revelar nada.
 */
export async function handleAdminMfaRecoveryCancel(
  req: VercelRequest,
  res: VercelResponse,
  deps: RecoveryDeps = defaultDeps(),
): Promise<VercelResponse> {
  res.setHeader("Cache-Control", NO_STORE);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }
  const body = parseBody(req);
  const op = body?.op;
  if ((op !== "check" && op !== "cancel") || !isChallengeToken(body?.token)) {
    return res.status(400).json({ error: "Solicitud inválida", code: "invalid_link" });
  }
  const invalid = () =>
    res.status(404).json({ error: "Enlace no válido", code: "invalid_link" });
  try {
    const client = deps.client();
    const hash = hashChallenge(body!.token as string);
    if (op === "check") {
      const { data, error } = await client.rpc("admin_mfa_recovery_cancel_check", {
        p_cancel_hash: hash,
      });
      if (error) return res.status(500).json(GENERIC_ERROR);
      return data === true ? res.status(200).json({ valid: true }) : invalid();
    }
    const out = await rpc(client, "admin_mfa_recovery_cancel_by_token", {
      p_cancel_hash: hash,
    });
    if (out.ok !== true) return invalid();
    const cfg = deps.mail();
    if (cfg && isUuid(out.recoveryId) && typeof out.email === "string") {
      await sendRecoveryMail(client, cfg.sender, {
        recoveryId: out.recoveryId,
        kind: "closed",
        baseKey: `recovery:${out.recoveryId}:closed`,
        to: out.email,
        spec: { kind: "closed", reason: "cancelled" },
      });
    }
    return res.status(200).json({ status: "cancelled" });
  } catch {
    return res.status(500).json(GENERIC_ERROR);
  }
}
