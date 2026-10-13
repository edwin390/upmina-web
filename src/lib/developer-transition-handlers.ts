import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireCapability } from "./admin-auth.js";
import {
  defaultDeps,
  failure,
  INVALID,
  isUuid,
  NO_STORE,
  parseBody,
  rpc,
  type RecoveryDeps,
} from "./admin-mfa-recovery-handlers.js";
import { cleanupAfterRemoval } from "./admin-team-members.js";
import { DEVELOPER_APPROVAL_TOTP_WINDOW_SECONDS } from "./privileged-mfa.js";

// Developer Panel V1 — transición Admin → Developer (autotransferencia) y restauración.
//
//   GET  /api/admin/team-developer-transfer   ¿puede este Admin transferirse? (solo lectura; sin motivos técnicos).
//   POST /api/admin/team-developer-transfer   {acknowledge: true}  el Admin se transfiere A SÍ MISMO.
//   POST /api/admin/team-developer-restore    {user_id, role: "admin"|"moderator"}  otro Admin devuelve a un
//                                             Developer a Admin o Moderator.
//   POST /api/admin/team-developer-remove     {user_id}  otro Admin retira el acceso al equipo de un Developer. La base
//                                             confirma la retirada y registra la limpieza MFA en la MISMA transacción
//                                             (admin_mfa_resets, fase 1); después se invalidan sus factores con el flujo
//                                             existente. La cuenta personal se conserva.
//
// Seguridad:
//   * El actor sale SOLO del JWT verificado (requireCapability: rol admin en admin_roles → capacidad
//     team_admin → MFA reciente). Developer, moderator y usuarios reciben 403.
//   * Transferirse y restaurar exigen además un TOTP verificado hace ≤ 5 minutos (timestamp `amr`).
//   * La transferencia NO recibe objetivo: la función de base de datos solo transfiere al propio actor, de modo
//     que no existe ningún permiso genérico para asignar Developer. La aceptación explícita
//     de la pérdida de acceso Admin es obligatoria en el cuerpo.
//   * Otro Admin elegible, ausencia de recuperaciones activas, lock de roles y último Admin se comprueban y
//     garantizan en la base de datos, en la misma transacción.
//   * `restore` solo acepta `admin` o `moderator` como rol nuevo: nunca `developer`.

/** Motivo de rechazo de la base de datos → [HTTP, code]. Lista CERRADA: lo demás es 500. */
const REASONS: Record<string, [number, string]> = {
  no_eligible_peer: [409, "no_eligible_peer"],
  recovery_in_progress: [409, "recovery_in_progress"],
  not_developer: [409, "not_developer"],
  not_found: [404, "not_found"],
  mfa_not_enrolled: [409, "mfa_not_enrolled"],
  approval_in_progress: [409, "approval_in_progress"],
  mfa_cleanup_pending: [409, "mfa_cleanup_pending"],
  recovery_depends_on_developer: [409, "recovery_depends_on_developer"],
};

function rejectTransition(res: VercelResponse, reason: unknown): VercelResponse {
  const hit = typeof reason === "string" ? REASONS[reason] : undefined;
  if (!hit) return res.status(500).json({ error: "Error interno" });
  return res.status(hit[0]).json({ error: "Operación no permitida", code: hit[1] });
}

export async function handleAdminTeamDeveloperTransfer(
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
    if (req.method === "GET") {
      const { userId } = await requireCapability(req, "team_admin");
      const out = await rpc(deps.client(), "admin_transfer_status", {
        p_actor_user_id: userId,
      });
      const reason = out.reason;
      if (
        typeof out.eligible !== "boolean" ||
        (reason !== "ok" &&
          reason !== "no_eligible_peer" &&
          reason !== "recovery_in_progress")
      ) {
        throw new Error("status_shape");
      }
      return res.status(200).json({ eligible: out.eligible, reason });
    }

    // POST: TOTP verificado hace ≤ 5 min. El actor es SIEMPRE el del JWT; el cuerpo nunca elige a nadie.
    const { userId } = await requireCapability(req, "team_admin", {
      totpWindowSeconds: DEVELOPER_APPROVAL_TOTP_WINDOW_SECONDS,
    });
    const body = parseBody(req);
    if (body?.acknowledge !== true) {
      return res
        .status(400)
        .json({ error: "Solicitud inválida", code: "acknowledge_required" });
    }
    const out = await rpc(deps.client(), "admin_transfer_self_to_developer", {
      p_actor_user_id: userId,
    });
    if (out.ok !== true) return rejectTransition(res, out.reason);
    return res.status(200).json({
      status: "transferred",
      role: "developer",
      cooldown_ready_at:
        typeof out.cooldownReadyAt === "string" ? out.cooldownReadyAt : null,
    });
  } catch (err) {
    return failure(res, err);
  }
}

export async function handleAdminTeamDeveloperRestore(
  req: VercelRequest,
  res: VercelResponse,
  deps: RecoveryDeps = defaultDeps(),
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }
  res.setHeader("Cache-Control", NO_STORE);
  try {
    const { userId } = await requireCapability(req, "team_admin", {
      totpWindowSeconds: DEVELOPER_APPROVAL_TOTP_WINDOW_SECONDS,
    });
    const body = parseBody(req);
    const targetId = body?.user_id;
    const role = body?.role;
    if (!isUuid(targetId) || (role !== "admin" && role !== "moderator")) {
      return res.status(400).json(INVALID);
    }
    if (targetId === userId) {
      return res
        .status(409)
        .json({ error: "Operación no permitida", code: "not_allowed" });
    }
    const out = await rpc(deps.client(), "admin_restore_developer", {
      p_actor_user_id: userId,
      p_target_user_id: targetId,
      p_new_role: role,
    });
    if (out.ok !== true) return rejectTransition(res, out.reason);
    return res.status(200).json({ status: "restored", user_id: targetId, role });
  } catch (err) {
    return failure(res, err);
  }
}

export async function handleAdminTeamDeveloperRemove(
  req: VercelRequest,
  res: VercelResponse,
  deps: RecoveryDeps = defaultDeps(),
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }
  res.setHeader("Cache-Control", NO_STORE);
  try {
    // Mismas garantías que la restauración: Admin con team_admin y TOTP verificado hace ≤ 5 min. El actor es
    // SIEMPRE el del JWT; el cuerpo solo nombra al objetivo.
    const { userId } = await requireCapability(req, "team_admin", {
      totpWindowSeconds: DEVELOPER_APPROVAL_TOTP_WINDOW_SECONDS,
    });
    const body = parseBody(req);
    const targetId = body?.user_id;
    if (!isUuid(targetId)) return res.status(400).json(INVALID);
    if (targetId === userId) {
      return res
        .status(409)
        .json({ error: "Operación no permitida", code: "not_allowed" });
    }
    const out = await rpc(deps.client(), "admin_remove_developer", {
      p_actor_user_id: userId,
      p_target_user_id: targetId,
    });
    if (out.ok !== true) return rejectTransition(res, out.reason);
    // A partir de aquí el rol YA está retirado y confirmado, con la marca de limpieza MFA en la misma transacción:
    // nada de lo que falle con el MFA puede devolver privilegios ni convertir esta respuesta en un error de la
    // retirada. cleanupAfterRemoval nunca lanza; si falla deja la limpieza PENDIENTE (reintento en «Autenticadores
    // pendientes de restablecer» o al reinvitar). Solo informa «completed» cuando la base lo registró.
    const mfaReset = await cleanupAfterRemoval(
      deps.client(),
      targetId,
      out.mfaFactorCount,
    );
    return res.status(200).json({
      status: "removed",
      user_id: targetId,
      last_developer: out.lastDeveloper === true,
      mfa_reset: mfaReset,
    });
  } catch (err) {
    return failure(res, err);
  }
}
