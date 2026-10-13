import type { SupabaseClient } from "@supabase/supabase-js";

// MFA fase 1 (migración 20261031140000): invalidar los factores TOTP de quien pierde su ÚLTIMO rol
// privilegiado y exigir un autenticador NUEVO si vuelve a ser invitado.
//
// Reglas de seguridad de este módulo:
//   * El borrado ocurre SIEMPRE después de que la retirada del rol esté confirmada (la marca nace en
//     la misma transacción que la retirada). Un fallo aquí nunca revierte ni «reabre» la retirada.
//   * Se borran EXACTAMENTE los ids de la instantánea guardada al retirar el rol. Nunca se lista y
//     borra «todo lo que haya», así un reintento tardío no puede eliminar un factor configurado
//     después de la retirada.
//   * Idempotente: un factor que ya no existe (404) cuenta como resuelto; repetirlo no tiene efectos.
//   * Los errores solo se registran como CLASE (sin mensajes de Supabase, sin secretos).
//   * Sin listar factores de terceros: solo se consulta la lista del propio usuario afectado para
//     confirmar que ninguno de los ids de la instantánea sigue presente.

type RpcClient = Pick<SupabaseClient, "rpc">;
export type MfaAdminClient = Pick<SupabaseClient, "auth" | "rpc">;

export interface PendingMfaReset {
  resetId: string;
  factorIds: string[];
}

export type MfaCleanupOutcome =
  | { status: "completed"; factorsDeleted: number }
  | { status: "pending"; errorClass: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 404 || code === "mfa_factor_not_found";
}

/** Limpieza pendiente de un usuario (solo ids de su instantánea), o null si no hay ninguna.
 *  Un fallo de lectura se propaga: nunca se interpreta como «no hay nada pendiente». */
export async function readPendingMfaReset(
  client: RpcClient,
  userId: string,
): Promise<PendingMfaReset | null> {
  const { data, error } = await client.rpc("admin_mfa_pending_reset", {
    p_user_id: userId,
  });
  if (error) throw new Error("pending_reset_read_failed");
  if (!Array.isArray(data) || data.length === 0) return null;
  const row = data[0] as { out_reset_id?: unknown; out_factor_ids?: unknown };
  if (
    typeof row.out_reset_id !== "string" ||
    !UUID.test(row.out_reset_id) ||
    !Array.isArray(row.out_factor_ids) ||
    !row.out_factor_ids.every((id) => typeof id === "string" && UUID.test(id))
  ) {
    throw new Error("pending_reset_shape");
  }
  return { resetId: row.out_reset_id, factorIds: row.out_factor_ids as string[] };
}

async function recordFailure(
  client: RpcClient,
  resetId: string,
  errorClass: string,
): Promise<MfaCleanupOutcome> {
  try {
    await client.rpc("admin_mfa_reset_record", {
      p_reset_id: resetId,
      p_ok: false,
      p_factors_deleted: null,
      p_error_class: errorClass,
    });
  } catch {
    /* el registro del fallo es de mejor esfuerzo: la limpieza sigue pendiente igualmente */
  }
  return { status: "pending", errorClass };
}

/**
 * Ejecuta (o reintenta) la limpieza de una instantánea. Seguro de repetir y de ejecutar en
 * paralelo: borrar un factor ya borrado es un no-op y la finalización en BD es idempotente.
 */
export async function runMfaResetCleanup(
  client: MfaAdminClient,
  userId: string,
  reset: PendingMfaReset,
): Promise<MfaCleanupOutcome> {
  let deleted = 0;
  try {
    for (const factorId of reset.factorIds) {
      const { error } = await client.auth.admin.mfa.deleteFactor({
        id: factorId,
        userId,
      });
      if (!error) {
        deleted += 1;
        continue;
      }
      if (isNotFound(error)) continue; // ya no existe: resuelto
      return await recordFailure(client, reset.resetId, "auth_delete_failed");
    }

    // Confirmación: NINGUNO de los ids de la instantánea sigue presente. Los factores nuevos del
    // usuario (ids distintos) se ignoran a propósito.
    const { data, error } = await client.auth.admin.mfa.listFactors({ userId });
    if (error || !data)
      return await recordFailure(client, reset.resetId, "auth_list_failed");
    if (data.factors.some((f) => reset.factorIds.includes(f.id))) {
      return await recordFailure(client, reset.resetId, "factor_still_present");
    }
  } catch {
    return await recordFailure(client, reset.resetId, "auth_unavailable");
  }

  try {
    const { error } = await client.rpc("admin_mfa_reset_record", {
      p_reset_id: reset.resetId,
      p_ok: true,
      p_factors_deleted: deleted,
      p_error_class: null,
    });
    if (error) return { status: "pending", errorClass: "record_failed" };
  } catch {
    // Los factores ya no existen pero no se pudo registrar: sigue «pendiente» y el reintento es
    // inocuo (todo devolverá 404 y se registrará con 0 borrados).
    return { status: "pending", errorClass: "record_failed" };
  }
  return { status: "completed", factorsDeleted: deleted };
}

export interface MfaActivationGate {
  ok: boolean;
  /** Solo si ok es false: 403 reenrolar, 503 limpieza pendiente, 500 fallo de infraestructura. */
  status?: 403 | 500 | 503;
  code?: "mfa_reenroll_required" | "mfa_cleanup_pending";
}

interface ActivationCheck {
  allowed: boolean;
  reason: string;
  resetId?: string;
}

async function readActivationCheck(
  client: RpcClient,
  userId: string,
  sessionId: string | undefined,
): Promise<ActivationCheck | null> {
  const { data, error } = await client.rpc("admin_mfa_activation_check", {
    p_user_id: userId,
    p_session_id: sessionId ?? null,
  });
  if (error || !data || typeof data !== "object") return null;
  const r = data as Record<string, unknown>;
  if (typeof r.allowed !== "boolean" || typeof r.reason !== "string") return null;
  return { allowed: r.allowed, reason: r.reason };
}

/**
 * Puerta previa a consumir una invitación. Falla CERRADO ante cualquier error o forma inesperada.
 *  - sin antecedentes de retirada → pasa (primera invitación: comportamiento normal);
 *  - limpieza pendiente → la reintenta aquí (solo los ids de SU instantánea); si no se resuelve, 503;
 *  - con antecedentes → la sesión debe acreditar un factor NUEVO verificado (BD), si no, 403 y la
 *    persona debe configurar un autenticador nuevo.
 */
export async function evaluateMfaActivationGate(
  client: MfaAdminClient,
  userId: string,
  sessionId: string | undefined,
): Promise<MfaActivationGate> {
  try {
    let check = await readActivationCheck(client, userId, sessionId);
    if (!check) return { ok: false, status: 500 };

    if (!check.allowed && check.reason === "mfa_cleanup_pending") {
      const pending = await readPendingMfaReset(client, userId);
      if (pending) {
        const outcome = await runMfaResetCleanup(client, userId, pending);
        if (outcome.status !== "completed") {
          return { ok: false, status: 503, code: "mfa_cleanup_pending" };
        }
      }
      check = await readActivationCheck(client, userId, sessionId);
      if (!check) return { ok: false, status: 500 };
    }

    if (check.allowed) return { ok: true };
    if (check.reason === "mfa_reenroll_required") {
      return { ok: false, status: 403, code: "mfa_reenroll_required" };
    }
    if (check.reason === "mfa_cleanup_pending") {
      return { ok: false, status: 503, code: "mfa_cleanup_pending" };
    }
    return { ok: false, status: 500 };
  } catch {
    return { ok: false, status: 500 };
  }
}
