import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, requireCapability } from "./admin-auth.js";
import {
  buildActivationPath,
  generateInvitationToken,
  hashInvitationToken,
} from "./admin-invitation-token.js";

// Bloque 9D — foundation server-side de invitaciones de equipo. Tres operaciones, todas
// exclusivamente para la capacidad `team_admin` (ADMIN + aal2, ver admin-auth.ts):
//
//   GET  /api/admin/team-invitations         lista metadata (nunca token/token_hash).
//   POST /api/admin/team-invitations         crea una invitación STANDARD ({ role }).
//   POST /api/admin/team-invitations-revoke  revoca una standard pendiente ({ id }).
//
// Diseño de escritura (compatible con los privilegios endurecidos de 9B):
//   - CREAR: INSERT directo con service_role (tiene INSERT). La base de datos es la autoridad:
//     admin_invitations_before_insert exige, bajo el lock compartido, que created_by SEA ADMIN
//     en ese instante y un estado inicial limpio. Solo se envían columnas de negocio; el
//     token_hash es lo único que se persiste del secreto.
//   - REVOCAR: RPC SECURITY DEFINER revoke_admin_invitation (migración 20260927120000), la
//     ÚNICA vía. Nunca UPDATE/DELETE directo (service_role no los tiene).
//   - LISTAR: SELECT de una lista BLANCA de columnas; cada fila se reconstruye campo a campo,
//     de modo que aunque una consulta futura trajera token_hash, jamás llegaría a la respuesta.
//
// El userId sale EXCLUSIVAMENTE de requireCapability (JWT verificado); nada del body se usa
// como identidad, rol de autorización ni tipo de invitación.

/** Roles invitables. developer NUNCA se concede por invitación (solo por cambio de rol). */
type InvitableRole = "admin" | "moderator";

/** Vigencia de una invitación standard (misma que la bootstrap). Fijada por el servidor. */
export const TEAM_INVITATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Máximo de filas devueltas por el listado (sin paginación en esta fase). */
export const TEAM_INVITATION_LIST_LIMIT = 200;

const LIST_COLUMNS =
  "id, role, invitation_type, created_at, expires_at, consumed_at, revoked_at";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Estado derivado (no se persiste): consumida > revocada > expirada > pendiente. */
export type TeamInvitationStatus = "pending" | "consumed" | "revoked" | "expired";

export interface TeamInvitationSummary {
  id: string;
  role: InvitableRole;
  invitation_type: "standard" | "bootstrap_admin";
  status: TeamInvitationStatus;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
}

const GENERIC_ERROR_BODY = { error: "Error interno" };
const FORBIDDEN_BODY = { error: "No autorizado" };
const INVALID_BODY = { error: "Solicitud inválida" };

/** Rechazos de negocio de revoke_admin_invitation (lista CERRADA; P0001 + message exacto).
 *  Cualquier otro error es infraestructura: 500 genérico. */
const REVOKE_NOT_FOUND = new Set(["invitation_not_found"]);
const REVOKE_NOT_REVOCABLE = new Set([
  "invitation_not_revocable",
  "invitation_already_consumed",
  "invitation_already_revoked",
  "invitation_expired",
]);
const REVOKE_ACTOR_REJECTED = new Set(["actor_not_admin"]);
const PLPGSQL_RAISE_EXCEPTION_CODE = "P0001";

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

function isInvitableRole(value: unknown): value is InvitableRole {
  return value === "admin" || value === "moderator";
}

function rpcErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === PLPGSQL_RAISE_EXCEPTION_CODE && typeof message === "string"
    ? message
    : null;
}

function isoOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

export function deriveInvitationStatus(
  row: { consumed_at: string | null; revoked_at: string | null; expires_at: string },
  now: number,
): TeamInvitationStatus {
  if (row.consumed_at !== null) return "consumed";
  if (row.revoked_at !== null) return "revoked";
  if (Date.parse(row.expires_at) < now) return "expired";
  return "pending";
}

/** Reconstruye una fila campo a campo desde una lista blanca; null si la forma no es la esperada. */
function toSummary(row: unknown, now: number): TeamInvitationSummary | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const createdAt = isoOrNull(r.created_at);
  const expiresAt = isoOrNull(r.expires_at);
  const consumedAt = isoOrNull(r.consumed_at);
  const revokedAt = isoOrNull(r.revoked_at);
  if (
    typeof r.id !== "string" ||
    !UUID_PATTERN.test(r.id) ||
    !isInvitableRole(r.role) ||
    (r.invitation_type !== "standard" && r.invitation_type !== "bootstrap_admin") ||
    typeof createdAt !== "string" ||
    typeof expiresAt !== "string" ||
    consumedAt === undefined ||
    revokedAt === undefined
  ) {
    return null;
  }
  return {
    id: r.id,
    role: r.role,
    invitation_type: r.invitation_type,
    status: deriveInvitationStatus(
      { consumed_at: consumedAt, revoked_at: revokedAt, expires_at: expiresAt },
      now,
    ),
    created_at: createdAt,
    expires_at: expiresAt,
    consumed_at: consumedAt,
    revoked_at: revokedAt,
  };
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
      res.status(err.status).json({ error: err.message });
    } else {
      res.status(500).json(GENERIC_ERROR_BODY);
    }
    return null;
  }
}

async function listInvitations(req: VercelRequest, res: VercelResponse) {
  if ((await authorizeTeamAdmin(req, res)) === null) return res;

  try {
    const client = getServiceClient();
    const { data, error } = await client
      .from("admin_invitations")
      .select(LIST_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(TEAM_INVITATION_LIST_LIMIT);
    if (error || !Array.isArray(data)) {
      return res.status(500).json(GENERIC_ERROR_BODY);
    }
    const now = Date.now();
    const invitations: TeamInvitationSummary[] = [];
    for (const row of data) {
      const summary = toSummary(row, now);
      if (!summary) return res.status(500).json(GENERIC_ERROR_BODY);
      invitations.push(summary);
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ invitations });
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

async function createInvitation(req: VercelRequest, res: VercelResponse) {
  const actorId = await authorizeTeamAdmin(req, res);
  if (actorId === null) return res;

  // Solo se lee `role`. invitation_type, created_by, expires_at, token_hash, etc. que el cliente
  // envíe se ignoran por completo: nunca se leen esas propiedades.
  const body = parseJsonBody(req);
  if (!body || !isInvitableRole(body.role)) {
    return res.status(400).json(INVALID_BODY);
  }
  const role = body.role;

  const token = generateInvitationToken();
  const now = Date.now();
  const expiresAt = new Date(now + TEAM_INVITATION_EXPIRY_MS).toISOString();

  try {
    const client = getServiceClient();
    const { data, error } = await client
      .from("admin_invitations")
      .insert({
        token_hash: hashInvitationToken(token),
        role,
        invitation_type: "standard",
        created_by: actorId,
        expires_at: expiresAt,
      })
      .select(LIST_COLUMNS)
      .single();

    if (error) {
      // El trigger admin_invitations_before_insert rechaza (23000) si el creador ya no es ADMIN
      // (degradado entre la autorización y el INSERT): es un 403, no infraestructura.
      const { code, message } = error as { code?: unknown; message?: unknown };
      if (code === "23000" && message === "invitation_creator_not_admin") {
        return res.status(403).json(FORBIDDEN_BODY);
      }
      return res.status(500).json(GENERIC_ERROR_BODY);
    }

    const summary = toSummary(data, now);
    if (!summary || summary.invitation_type !== "standard" || summary.role !== role) {
      return res.status(500).json(GENERIC_ERROR_BODY);
    }

    // El token en claro se devuelve UNA sola vez, aquí. Nunca se persiste, se lista ni se registra.
    res.setHeader("Cache-Control", "no-store");
    return res.status(201).json({
      invitation: summary,
      token,
      activation_path: buildActivationPath(token),
    });
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

export async function handleAdminTeamInvitations(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method === "GET") return listInvitations(req, res);
  if (req.method === "POST") return createInvitation(req, res);
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Método no permitido" });
}

export async function handleAdminTeamInvitationRevoke(
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
  const id = body?.id;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    return res.status(400).json(INVALID_BODY);
  }

  try {
    const client = getServiceClient();
    const { data, error } = await client.rpc("revoke_admin_invitation", {
      p_invitation_id: id,
      p_actor_user_id: actorId,
    });

    if (error) {
      const message = rpcErrorMessage(error);
      if (message !== null) {
        if (REVOKE_NOT_FOUND.has(message)) {
          return res.status(404).json({ error: "No encontrado" });
        }
        if (REVOKE_NOT_REVOCABLE.has(message)) {
          // consumida / ya revocada / expirada / no standard: misma respuesta (sin oráculo).
          return res.status(409).json({ error: "La invitación ya no se puede revocar" });
        }
        if (REVOKE_ACTOR_REJECTED.has(message)) {
          return res.status(403).json(FORBIDDEN_BODY);
        }
      }
      return res.status(500).json(GENERIC_ERROR_BODY);
    }

    const revokedAt = Array.isArray(data) ? data[0]?.out_revoked_at : undefined;
    if (typeof revokedAt !== "string" || Number.isNaN(Date.parse(revokedAt))) {
      return res.status(500).json(GENERIC_ERROR_BODY);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ id, status: "revoked", revoked_at: revokedAt });
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}
