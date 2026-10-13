import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildRecoveryEmail,
  type MailSender,
  type RecoveryMailKind,
} from "./mfa-recovery-mail.js";

// MFA fase 2 — lógica compartida de la recuperación de un autenticador perdido (SOLO servidor).
// Las reglas de negocio (estados, aprobación, caducidad, instantánea) viven en la base de datos
// (migración 20261031150000); aquí solo: desafío criptográfico, envío de avisos con registro de
// estado y borrado EXACTO de la instantánea de factores.

export type RecoveryClient = Pick<SupabaseClient, "auth" | "rpc">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Desafío de 256 bits (base64url, 43 caracteres). Solo su SHA-256 llega a la base de datos. */
export function newChallengeToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isChallengeToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function hashChallenge(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Avisos por correo
// ---------------------------------------------------------------------------------------------
export type MailOutcome =
  | { status: "accepted" }
  | { status: "already_sent" }
  | { status: "failed"; errorClass: string };

/**
 * Envía (una sola vez por clave) un correo de la recuperación y registra su estado. NUNCA lanza.
 * «accepted» significa que el proveedor lo aceptó, no que se entregó: la entrega solo la confirma el
 * webhook firmado. Si el registro previo falla no se envía nada (no se afirma un aviso sin rastro).
 */
export async function sendRecoveryMail(
  client: Pick<SupabaseClient, "rpc">,
  sender: MailSender,
  args: {
    recoveryId: string;
    kind: "challenge" | "approved" | "closed" | "completed" | "reminder";
    baseKey: string;
    to: string;
    spec: RecoveryMailKind;
  },
): Promise<MailOutcome> {
  try {
    const { data, error } = await client.rpc("admin_mfa_recovery_mail_start", {
      p_recovery_id: args.recoveryId,
      p_kind: args.kind,
      p_base_key: args.baseKey,
    });
    if (error || !data || typeof data !== "object") {
      return { status: "failed", errorClass: "mail_log_unavailable" };
    }
    const start = data as { shouldSend?: unknown; providerKey?: unknown };
    if (start.shouldSend !== true) return { status: "already_sent" };
    if (typeof start.providerKey !== "string") {
      return { status: "failed", errorClass: "mail_log_unavailable" };
    }
    const built = buildRecoveryEmail(args.spec);
    const result = await sender.send({
      to: args.to,
      subject: built.subject,
      text: built.text,
      html: built.html,
      idempotencyKey: start.providerKey,
    });
    await client.rpc("admin_mfa_recovery_mail_result", {
      p_base_key: args.baseKey,
      p_accepted: result.ok,
      p_provider_message_id: result.ok ? (result.providerMessageId ?? null) : null,
      p_error_class: result.ok ? null : (result.errorClass ?? "unknown"),
    });
    return result.ok
      ? { status: "accepted" }
      : { status: "failed", errorClass: result.errorClass ?? "unknown" };
  } catch {
    return { status: "failed", errorClass: "mail_unavailable" };
  }
}

// ---------------------------------------------------------------------------------------------
// Invalidación del autenticador perdido (mismo patrón que la fase 1)
// ---------------------------------------------------------------------------------------------
export type RecoveryExecutionOutcome =
  | { status: "factors_deleted"; factorsDeleted: number }
  | { status: "failed"; errorClass: string };

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 404 || code === "mfa_factor_not_found";
}

async function recordFailure(
  client: Pick<SupabaseClient, "rpc">,
  recoveryId: string,
  errorClass: string,
): Promise<RecoveryExecutionOutcome> {
  try {
    await client.rpc("admin_mfa_recovery_record_execution", {
      p_recovery_id: recoveryId,
      p_ok: false,
      p_factors_deleted: null,
      p_error_class: errorClass,
    });
  } catch {
    /* mejor esfuerzo: el reintento sigue disponible */
  }
  return { status: "failed", errorClass };
}

/**
 * Borra EXACTAMENTE los ids de la instantánea (nunca «todos los factores que liste Auth»), con la
 * API oficial de administración de Supabase Auth. Idempotente: 404 = ya resuelto. Confirma con
 * listFactors que ninguno de esos ids sigue presente; los factores nuevos (otros ids) se ignoran, así
 * que un reintento tardío no puede eliminar el autenticador recién configurado.
 */
export async function runRecoveryDeletion(
  client: RecoveryClient,
  userId: string,
  recovery: { recoveryId: string; factorIds: string[] },
): Promise<RecoveryExecutionOutcome> {
  let deleted = 0;
  try {
    for (const factorId of recovery.factorIds) {
      // Una cancelación (p. ej. por el enlace del correo) posterior a begin_execute detiene lo que
      // falte por borrar. Sin registrar fallo: la solicitud ya está cerrada.
      const allowed = await client.rpc("admin_mfa_recovery_execution_allowed", {
        p_recovery_id: recovery.recoveryId,
      });
      if (allowed.error) {
        return await recordFailure(client, recovery.recoveryId, "state_check_failed");
      }
      if (allowed.data !== true)
        return { status: "failed", errorClass: "recovery_closed" };
      const { error } = await client.auth.admin.mfa.deleteFactor({
        id: factorId,
        userId,
      });
      if (!error) {
        deleted += 1;
        continue;
      }
      if (isNotFound(error)) continue;
      return await recordFailure(client, recovery.recoveryId, "auth_delete_failed");
    }
    const { data, error } = await client.auth.admin.mfa.listFactors({ userId });
    if (error || !data)
      return await recordFailure(client, recovery.recoveryId, "auth_list_failed");
    if (data.factors.some((f) => recovery.factorIds.includes(f.id))) {
      return await recordFailure(client, recovery.recoveryId, "factor_still_present");
    }
  } catch {
    return await recordFailure(client, recovery.recoveryId, "auth_unavailable");
  }
  try {
    const { error } = await client.rpc("admin_mfa_recovery_record_execution", {
      p_recovery_id: recovery.recoveryId,
      p_ok: true,
      p_factors_deleted: deleted,
      p_error_class: null,
    });
    if (error) return { status: "failed", errorClass: "record_failed" };
  } catch {
    return { status: "failed", errorClass: "record_failed" };
  }
  return { status: "factors_deleted", factorsDeleted: deleted };
}

export function parseFactorIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((v) => typeof v === "string" && UUID.test(v))
    ? (value as string[])
    : null;
}
