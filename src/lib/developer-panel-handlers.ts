import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, requireCapability } from "./admin-auth.js";
import {
  hashChallenge,
  newChallengeToken,
  type RecoveryClient,
} from "./admin-mfa-recovery.js";
import {
  defaultDeps,
  failure,
  INVALID,
  isUuid,
  mailSummary,
  NO_STORE,
  parseBody,
  reject,
  rpc,
  sendApprovedNotice,
  remindApprovedNotice,
  sendClosedNotice,
  type RecoveryDeps,
  type Row,
} from "./admin-mfa-recovery-handlers.js";
import { readPendingMfaReset, runMfaResetCleanup } from "./admin-mfa-reset.js";
import { DEVELOPER_APPROVAL_TOTP_WINDOW_SECONDS } from "./privileged-mfa.js";

// Developer Panel V1 — endpoints del rol DEVELOPER (capacidad `developer_panel`, exclusiva de ese rol).
//
//   GET  /api/admin/developer-mfa-cleanups    limpiezas de MFA pendientes/recientes.
//   POST /api/admin/developer-mfa-cleanups    reintenta TODAS las limpiezas pendientes (sin cuerpo; idempotente).
//   GET  /api/admin/developer-mfa-recoveries  solicitudes elegibles para aprobación excepcional + historial.
//   POST /api/admin/developer-mfa-recoveries  {op: approve | deny | resend_notice, recovery_id, reason?}
//
// Seguridad:
//   * El actor sale SOLO del JWT verificado (requireCapability: rol developer en admin_roles → capacidad
//     developer_panel → MFA reciente). Admin y moderator reciben 403: ningún rol hereda del otro.
//   * Aprobar, rechazar y reenviar el aviso exigen además un TOTP verificado hace ≤ 5 minutos
//     (timestamp `amr` del JWT), no solo aal2.
//   * La elegibilidad (único admin elegible), la titularidad, el estado y la vigencia se REVALIDAN en la
//     transacción de la base de datos bajo el lock compartido de roles; el servidor nunca confía en lo
//     que mostró la lista. Nadie aprueba su propia recuperación.
//   * NO existe ninguna operación de borrado de factores aquí. Aprobar solo cambia el estado de la
//     solicitud; el borrado exacto de la instantánea lo hace, tras el aviso entregado y la espera, el
//     titular con el mecanismo de la fase 2 (runRecoveryDeletion), sin cambios.
//   * Las lecturas no devuelven correos completos, ids de factores, hashes ni tokens.

type Rpc = Pick<RecoveryClient, "rpc">;

// Espera de seguridad tras la autotransferencia (la fuente es la base de datos: tabla
// admin_developer_settings; el valor por defecto sin configurar es de 24 h). El navegador solo la MUESTRA.
interface Cooldown {
  ready: boolean;
  ready_at: string | null;
  remaining_seconds: number;
  cooldown_minutes: number;
}

async function readCooldown(client: Rpc, actorId: string): Promise<Cooldown> {
  const out = await rpc(client, "admin_developer_cooldown", { p_actor_user_id: actorId });
  const { ready, readyAt, remainingSeconds, cooldownMinutes } = out;
  if (
    typeof ready !== "boolean" ||
    typeof remainingSeconds !== "number" ||
    typeof cooldownMinutes !== "number" ||
    !(readyAt === null || typeof readyAt === "string")
  ) {
    throw new Error("cooldown_shape");
  }
  return {
    ready,
    ready_at: readyAt as string | null,
    remaining_seconds: remainingSeconds,
    cooldown_minutes: cooldownMinutes,
  };
}

function cooldownBlocked(res: VercelResponse, cooldown: Cooldown): VercelResponse {
  return res.status(409).json({
    error: "Operación no permitida",
    code: "cooldown_active",
    ready_at: cooldown.ready_at,
    remaining_seconds: cooldown.remaining_seconds,
  });
}

async function rpcRows(
  client: Rpc,
  fn: string,
  actorId: string,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await client.rpc(fn, { p_actor_user_id: actorId });
  if (error) {
    const e = error as { code?: unknown; message?: unknown };
    if (e.code === "P0001" && e.message === "actor_not_developer") {
      throw new AdminAuthError("No autorizado", 403);
    }
    throw new Error("rpc_failed");
  }
  if (!Array.isArray(data)) throw new Error("rpc_shape");
  return data as Record<string, unknown>[];
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) ? v : null;

// ---------------------------------------------------------------------------------------------
// Limpiezas de MFA (solo lectura)
// ---------------------------------------------------------------------------------------------
export interface DeveloperCleanup {
  status: "pending" | "completed";
  previous_role: string;
  requested_at: string;
  completed_at: string | null;
  attempts: number;
  last_attempt_at: string | null;
  last_error_class: string | null;
  factor_count: number;
  factors_deleted: number | null;
  username: string | null;
  email_masked: string | null;
}

function toCleanup(r: Record<string, unknown>): DeveloperCleanup | null {
  const status = r.out_status;
  const attempts = int(r.out_attempts);
  const factorCount = int(r.out_factor_count);
  const requestedAt = str(r.out_requested_at);
  const previousRole = str(r.out_old_role);
  if (
    (status !== "pending" && status !== "completed") ||
    attempts === null ||
    factorCount === null ||
    requestedAt === null ||
    previousRole === null
  ) {
    return null;
  }
  return {
    status,
    previous_role: previousRole,
    requested_at: requestedAt,
    completed_at: str(r.out_completed_at),
    attempts,
    last_attempt_at: str(r.out_last_attempt_at),
    last_error_class: str(r.out_last_error_class),
    factor_count: factorCount,
    factors_deleted: int(r.out_factors_deleted),
    username: str(r.out_username),
    email_masked: str(r.out_email_masked),
  };
}

export async function handleDeveloperMfaCleanups(
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
    const { userId } = await requireCapability(req, "developer_panel");
    if (req.method === "POST") {
      // Los ids salen de la base de datos (función restringida a developer), nunca del cliente; cada
      // limpieza borra solo los factores de su instantánea y un factor ausente cuenta como resuelto.
      const client = deps.client();
      const ids = await rpcRows(
        client,
        "admin_mfa_cleanup_pending_ids_for_developer",
        userId,
      );
      let completed = 0;
      let pending = 0;
      for (const row of ids) {
        const target = row.out_user_id;
        if (!isUuid(target)) throw new Error("list_shape");
        const snapshot = await readPendingMfaReset(client, target);
        if (!snapshot) continue;
        const outcome = await runMfaResetCleanup(client, target, snapshot);
        if (outcome.status === "completed") completed += 1;
        else pending += 1;
      }
      return res.status(200).json({ retried: completed + pending, completed, pending });
    }
    const rows = await rpcRows(deps.client(), "admin_mfa_cleanups_for_developer", userId);
    const cleanups: DeveloperCleanup[] = [];
    for (const raw of rows) {
      const item = toCleanup(raw);
      if (!item) throw new Error("list_shape");
      cleanups.push(item);
    }
    return res.status(200).json({ cleanups });
  } catch (err) {
    return failure(res, err);
  }
}

// ---------------------------------------------------------------------------------------------
// Recuperaciones excepcionales
// ---------------------------------------------------------------------------------------------
function toRecovery(r: Record<string, unknown>): Row | null {
  if (!isUuid(r.out_id) || typeof r.out_status !== "string") return null;
  return {
    id: r.out_id,
    username: str(r.out_username),
    role: str(r.out_role),
    status: r.out_status,
    requested_at: str(r.out_requested_at),
    email_verified_at: str(r.out_email_verified_at),
    expires_at: str(r.out_expires_at),
    approved_at: str(r.out_approved_at),
    approval_kind: str(r.out_approval_kind),
    approver_role: str(r.out_approver_role),
    approver_username: str(r.out_approver_username),
    notice_state: str(r.out_notice_state),
    readiness: str(r.out_readiness),
    eligible: r.out_eligible === true,
    closed_reason: str(r.out_closed_reason),
  };
}

async function recoveryList(client: Rpc, actorId: string): Promise<Row[]> {
  const rows = await rpcRows(client, "admin_mfa_recoveries_exceptional", actorId);
  const items: Row[] = [];
  for (const raw of rows) {
    const item = toRecovery(raw);
    if (!item) throw new Error("list_shape");
    items.push(item);
  }
  return items;
}

export async function handleDeveloperMfaRecoveries(
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
    // Lectura: Developer con MFA reciente. Decidir (POST): además TOTP verificado hace ≤ 5 minutos.
    const { userId: actorId } = await requireCapability(
      req,
      "developer_panel",
      req.method === "POST"
        ? { totpWindowSeconds: DEVELOPER_APPROVAL_TOTP_WINDOW_SECONDS }
        : {},
    );
    const client = deps.client();

    if (req.method === "GET") {
      return res.status(200).json({
        recoveries: await recoveryList(client, actorId),
        cooldown: await readCooldown(client, actorId),
      });
    }

    const body = parseBody(req);
    const op = body?.op;
    const recoveryId = body?.recovery_id;
    if (typeof op !== "string" || !isUuid(recoveryId)) {
      return res.status(400).json(INVALID);
    }
    const cfg = deps.mail();

    // Mismo envío que el flujo normal; solo cambia el texto (autorizado por un Developer).
    const sendApproved = async (email: unknown, token: string, rotation: unknown) =>
      cfg &&
      typeof email === "string" &&
      typeof rotation === "number" &&
      Number.isInteger(rotation)
        ? sendApprovedNotice(client, cfg, {
            recoveryId,
            email,
            token,
            rotation,
            exceptional: true,
          })
        : null;

    switch (op) {
      case "approve": {
        // Espera de seguridad: se comprueba AQUÍ y, de forma autoritativa, dentro de la función SQL que
        // aprueba (clock_timestamp()); ninguna de las dos usa un dato del cliente.
        const cooldown = await readCooldown(client, actorId);
        if (!cooldown.ready) return cooldownBlocked(res, cooldown);
        const cancelToken = newChallengeToken();
        const out = await rpc(client, "admin_mfa_recovery_approve_exceptional", {
          p_recovery_id: recoveryId,
          p_actor_user_id: actorId,
          p_cancel_hash: hashChallenge(cancelToken),
        });
        if (out.reason === "cooldown_active") {
          return cooldownBlocked(res, await readCooldown(client, actorId));
        }
        if (out.ok !== true) return reject(res, out.reason);
        // El aviso NO bloquea la aprobación, pero sin entrega confirmada la ejecución no se habilita.
        return res.status(200).json({
          status: "approved",
          approval_kind: "exceptional",
          notice: mailSummary(
            await sendApproved(out.email, cancelToken, out.cancelRotation),
          ),
        });
      }
      case "deny": {
        const reason = typeof body?.reason === "string" ? body.reason : "";
        const out = await rpc(client, "admin_mfa_recovery_deny_exceptional", {
          p_recovery_id: recoveryId,
          p_actor_user_id: actorId,
          p_reason: reason,
        });
        if (out.ok !== true) return reject(res, out.reason);
        const notice =
          cfg && typeof out.email === "string"
            ? await sendClosedNotice(client, cfg, {
                recoveryId,
                email: out.email,
                reason: "denied",
              })
            : null;
        return res.status(200).json({ status: "denied", notice: mailSummary(notice) });
      }
      case "resend_notice": {
        // Solo la aprobación EXCEPCIONAL de la lista autorizada y mientras el aviso no esté entregado.
        const target = (await recoveryList(client, actorId)).find(
          (i) =>
            i.id === recoveryId &&
            i.status === "approved" &&
            i.approval_kind === "exceptional",
        );
        if (!target) return reject(res, "not_found");
        // Aviso ya entregado: recordatorio independiente (sin enlace, sin cambiar estado ni espera).
        if (target.notice_state === "delivered") {
          return remindApprovedNotice(client, cfg, recoveryId, actorId, res);
        }
        const cancelToken = newChallengeToken();
        const out = await rpc(client, "admin_mfa_recovery_set_cancel", {
          p_recovery_id: recoveryId,
          p_cancel_hash: hashChallenge(cancelToken),
        });
        if (out.ok !== true) {
          return reject(
            res,
            out.reason === "already_delivered" ? "not_pending" : out.reason,
          );
        }
        return res.status(200).json({
          status: "approved",
          approval_kind: "exceptional",
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
