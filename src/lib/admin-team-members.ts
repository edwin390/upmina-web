import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, authErrorBody, requireCapability } from "./admin-auth.js";
import {
  readPendingMfaReset,
  runMfaResetCleanup,
  type MfaAdminClient,
  type MfaCleanupOutcome,
} from "./admin-mfa-reset.js";

// Bloque 9F — gestión de miembros del equipo. Tres operaciones, todas exclusivamente para la
// capacidad `team_admin` (ADMIN + aal2, ver admin-auth.ts):
//
//   GET  /api/admin/team-members         lista los miembros privilegiados (con email, solo aquí).
//   POST /api/admin/team-members-role    cambia el rol de OTRO miembro ({ user_id, role }).
//   POST /api/admin/team-members-remove  quita el acceso privilegiado de OTRO miembro ({ user_id }) y,
//                                        tras confirmar la retirada, invalida sus factores TOTP
//                                        (MFA fase 1, ver admin-mfa-reset.ts).
//   GET  /api/admin/team-members-mfa-cleanups  limpiezas de MFA pendientes (solo ADMIN).
//   POST /api/admin/team-members-mfa-cleanup   reintenta una limpieza pendiente ({ user_id }).
//
// Toda la escritura y la lectura de identidad pasan por RPC SECURITY DEFINER (migración
// 20260928120000): list_admin_team_members, change_admin_member_role y remove_admin_member. El
// handler NO reimplementa sus reglas (actor ADMIN bajo el lock, actor <> target, último ADMIN,
// auditoría, revocación de invitaciones pendientes): solo autoriza, valida la forma del body y
// traduce una lista CERRADA de errores. El actor sale EXCLUSIVAMENTE de requireCapability (JWT
// verificado); ningún dato del body se usa como identidad del actor.
//
// Privacidad: el email solo viaja en la respuesta del listado (Cache-Control: no-store). Nunca se
// registra en logs ni se incluye en un mensaje de error.

type MemberRole = "admin" | "moderator" | "developer";

const ROLES: readonly MemberRole[] = ["admin", "moderator", "developer"];
// Roles que un ADMIN puede asignar. Developer NO está: lo asigna solo el operador (Developer Panel V1);
// la base de datos lo rechaza además con developer_protected.
const ASSIGNABLE_ROLES: readonly MemberRole[] = ["admin", "moderator"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TeamMemberSummary {
  user_id: string;
  role: MemberRole;
  granted_at: string;
  username: string | null;
  display_name: string | null;
  email: string | null;
  is_self: boolean;
}

const GENERIC_ERROR_BODY = { error: "Error interno" };
const FORBIDDEN_BODY = { error: "No autorizado" };
const INVALID_BODY = { error: "Solicitud inválida" };
const NOT_FOUND_BODY = { error: "No encontrado" };
const NOT_ALLOWED_BODY = { error: "Operación no permitida" };

/** Rechazos de negocio reconocidos (lista CERRADA; P0001 + message exacto). El resto es 500. */
const ACTOR_REJECTED = new Set(["actor_not_admin"]);
const MEMBER_NOT_FOUND = new Set(["member_not_found"]);
const OPERATION_NOT_ALLOWED = new Set([
  "self_change_not_allowed",
  "role_unchanged",
  "developer_protected",
]);
const PLPGSQL_RAISE_EXCEPTION_CODE = "P0001";
// Guard del último ADMIN (9B): SQLSTATE 23001 con este message. Se traduce, nunca se neutraliza.
const LAST_ADMIN_CODE = "23001";
const LAST_ADMIN_MESSAGE = "last_admin_protected";

function getServiceClient() {
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase no configurado");
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function parseJsonBody(req: VercelRequest): Record<string, unknown> | null {
  const raw = req.body;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function stringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/** Reconstruye una fila del listado campo a campo desde una lista blanca; null si la forma falla. */
function toMember(row: unknown): TeamMemberSummary | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const username = stringOrNull(r.out_username);
  const displayName = stringOrNull(r.out_display_name);
  const email = stringOrNull(r.out_email);
  if (
    !isUuid(r.out_user_id) ||
    !isMemberRole(r.out_role) ||
    !isIsoTimestamp(r.out_granted_at) ||
    username === undefined ||
    displayName === undefined ||
    email === undefined ||
    typeof r.out_is_self !== "boolean"
  ) {
    return null;
  }
  return {
    user_id: r.out_user_id,
    role: r.out_role,
    granted_at: r.out_granted_at,
    username,
    display_name: displayName,
    email,
    is_self: r.out_is_self,
  };
}

function rpcErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === PLPGSQL_RAISE_EXCEPTION_CODE && typeof message === "string"
    ? message
    : null;
}

/** Traduce un error de RPC a una respuesta pública. Todo lo no reconocido es 500 genérico. */
function respondRpcError(res: VercelResponse, error: unknown): VercelResponse {
  const message = rpcErrorMessage(error);
  if (message !== null) {
    if (ACTOR_REJECTED.has(message)) return res.status(403).json(FORBIDDEN_BODY);
    if (MEMBER_NOT_FOUND.has(message)) return res.status(404).json(NOT_FOUND_BODY);
    if (OPERATION_NOT_ALLOWED.has(message)) return res.status(409).json(NOT_ALLOWED_BODY);
  }
  const { code, message: rawMessage } = (error ?? {}) as {
    code?: unknown;
    message?: unknown;
  };
  if (code === LAST_ADMIN_CODE && rawMessage === LAST_ADMIN_MESSAGE) {
    return res.status(409).json(NOT_ALLOWED_BODY);
  }
  return res.status(500).json(GENERIC_ERROR_BODY);
}

/** Autoriza con team_admin y devuelve el userId verificado, o responde y devuelve null. */
async function authorizeTeamAdmin(
  req: VercelRequest,
  res: VercelResponse,
): Promise<string | null> {
  try {
    const { userId } = await requireCapability(req, "team_admin");
    return userId;
  } catch (err) {
    if (err instanceof AdminAuthError) {
      res.status(err.status).json(authErrorBody(err));
    } else {
      res.status(500).json(GENERIC_ERROR_BODY);
    }
    return null;
  }
}

export async function handleAdminTeamMembers(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const actorId = await authorizeTeamAdmin(req, res);
  if (actorId === null) return res;

  try {
    const client = getServiceClient();
    const { data, error } = await client.rpc("list_admin_team_members", {
      p_actor_user_id: actorId,
    });
    if (error) return respondRpcError(res, error);
    if (!Array.isArray(data)) return res.status(500).json(GENERIC_ERROR_BODY);

    const members: TeamMemberSummary[] = [];
    for (const row of data) {
      const member = toMember(row);
      if (!member) return res.status(500).json(GENERIC_ERROR_BODY);
      members.push(member);
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ members });
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

export async function handleAdminTeamMemberRole(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const actorId = await authorizeTeamAdmin(req, res);
  if (actorId === null) return res;

  // Solo se leen `user_id` y `role`: cualquier otra propiedad del body se ignora por completo.
  const body = parseJsonBody(req);
  const targetId = body?.user_id;
  const role = body?.role;
  if (
    !isUuid(targetId) ||
    typeof role !== "string" ||
    !(ASSIGNABLE_ROLES as readonly string[]).includes(role)
  ) {
    return res.status(400).json(INVALID_BODY);
  }

  try {
    const client = getServiceClient();
    const { data, error } = await client.rpc("change_admin_member_role", {
      p_actor_user_id: actorId,
      p_target_user_id: targetId,
      p_new_role: role,
    });
    if (error) return respondRpcError(res, error);

    const row = Array.isArray(data) ? data[0] : undefined;
    if (
      !row ||
      !isMemberRole(row.out_old_role) ||
      row.out_new_role !== role ||
      !isIsoTimestamp(row.out_changed_at) ||
      !Number.isInteger(row.out_revoked_invitations)
    ) {
      return res.status(500).json(GENERIC_ERROR_BODY);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      user_id: targetId,
      role,
      previous_role: row.out_old_role,
      changed_at: row.out_changed_at,
      revoked_invitations: row.out_revoked_invitations,
    });
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

export async function handleAdminTeamMemberRemove(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const actorId = await authorizeTeamAdmin(req, res);
  if (actorId === null) return res;

  const body = parseJsonBody(req);
  const targetId = body?.user_id;
  if (!isUuid(targetId)) {
    return res.status(400).json(INVALID_BODY);
  }

  try {
    const client = getServiceClient();
    // Retirada + marca de limpieza MFA en UNA transacción. remove_admin_member ya no es invocable
    // directamente: ninguna retirada puede omitir la marca.
    const { data, error } = await client.rpc("admin_remove_member_with_mfa_reset", {
      p_actor_user_id: actorId,
      p_target_user_id: targetId,
    });
    if (error) return respondRpcError(res, error);

    const row = Array.isArray(data) ? data[0] : undefined;
    if (
      !row ||
      !isMemberRole(row.out_old_role) ||
      !isIsoTimestamp(row.out_removed_at) ||
      !Number.isInteger(row.out_revoked_invitations)
    ) {
      return res.status(500).json(GENERIC_ERROR_BODY);
    }

    // A partir de aquí el rol YA está retirado y confirmado: nada de lo que falle con el MFA puede
    // convertir esta respuesta en un error de la retirada.
    const mfaReset = await cleanupAfterRemoval(
      client,
      targetId,
      row.out_mfa_factor_count,
    );

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      user_id: targetId,
      previous_role: row.out_old_role,
      removed_at: row.out_removed_at,
      revoked_invitations: row.out_revoked_invitations,
      mfa_reset: mfaReset,
    });
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

export interface MfaResetSummary {
  status: "not_needed" | "completed" | "pending";
  factors_deleted?: number;
  error_class?: string;
}

function summarize(outcome: MfaCleanupOutcome): MfaResetSummary {
  return outcome.status === "completed"
    ? { status: "completed", factors_deleted: outcome.factorsDeleted }
    : { status: "pending", error_class: outcome.errorClass };
}

/** Limpieza de MFA inmediatamente después de retirar el rol. Nunca lanza: cualquier problema deja
 *  la limpieza pendiente (recuperable por reintento o al reinvitar). */
export async function cleanupAfterRemoval(
  client: MfaAdminClient,
  targetId: string,
  factorCount: unknown,
): Promise<MfaResetSummary> {
  if (factorCount === 0) return { status: "not_needed" };
  try {
    const pending = await readPendingMfaReset(client, targetId);
    if (!pending) return { status: "completed", factors_deleted: 0 };
    return summarize(await runMfaResetCleanup(client, targetId, pending));
  } catch {
    return { status: "pending", error_class: "cleanup_unavailable" };
  }
}

interface MfaCleanupRow {
  user_id: string;
  previous_role: MemberRole;
  requested_at: string;
  attempts: number;
  last_error_class: string | null;
  factor_count: number;
  username: string | null;
  email: string | null;
}

function toCleanup(row: unknown): MfaCleanupRow | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const username = stringOrNull(r.out_username);
  const email = stringOrNull(r.out_email);
  const lastError = stringOrNull(r.out_last_error_class);
  if (
    !isUuid(r.out_user_id) ||
    !isMemberRole(r.out_old_role) ||
    !isIsoTimestamp(r.out_requested_at) ||
    !Number.isInteger(r.out_attempts) ||
    !Number.isInteger(r.out_factor_count) ||
    username === undefined ||
    email === undefined ||
    lastError === undefined
  ) {
    return null;
  }
  return {
    user_id: r.out_user_id,
    previous_role: r.out_old_role,
    requested_at: r.out_requested_at,
    attempts: r.out_attempts as number,
    last_error_class: lastError,
    factor_count: r.out_factor_count as number,
    username,
    email,
  };
}

export async function handleAdminTeamMfaCleanups(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const actorId = await authorizeTeamAdmin(req, res);
  if (actorId === null) return res;

  try {
    const client = getServiceClient();
    const { data, error } = await client.rpc("admin_mfa_cleanups_pending", {
      p_actor_user_id: actorId,
    });
    if (error) return respondRpcError(res, error);
    if (!Array.isArray(data)) return res.status(500).json(GENERIC_ERROR_BODY);
    const cleanups: MfaCleanupRow[] = [];
    for (const row of data) {
      const parsed = toCleanup(row);
      if (!parsed) return res.status(500).json(GENERIC_ERROR_BODY);
      cleanups.push(parsed);
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ cleanups });
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

export async function handleAdminTeamMfaCleanupRetry(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }

  // Misma autorización que la retirada: ADMIN con MFA reciente. El actor sale solo del JWT.
  const actorId = await authorizeTeamAdmin(req, res);
  if (actorId === null) return res;

  const body = parseJsonBody(req);
  const targetId = body?.user_id;
  if (!isUuid(targetId)) {
    return res.status(400).json(INVALID_BODY);
  }

  try {
    const client = getServiceClient();
    // Solo hay algo que reintentar si la BD tiene una limpieza PENDIENTE para esa persona; sus ids
    // son los de la instantánea original, nunca los que envíe el cliente.
    const pending = await readPendingMfaReset(client, targetId);
    if (!pending) return res.status(404).json(NOT_FOUND_BODY);
    const outcome = await runMfaResetCleanup(client, targetId, pending);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ user_id: targetId, mfa_reset: summarize(outcome) });
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}
