import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, requireAuthenticated } from "./admin-auth.js";
import { checkUsername } from "./profile-username.js";

// Handler HTTP de POST /api/profile (Bloque 7C.1): crea el perfil público inicial del
// usuario autenticado eligiendo SOLO su username. Crear un perfil es únicamente crear
// identidad pública: no concede roles (admin_roles sigue siendo la única fuente de
// privilegios), no exige MFA/aal2 y no consulta /api/admin/me.
//
// Contrato:
//   Request : POST, `Authorization: Bearer <access token>`, body JSON exactamente
//             { "username": string }. Cualquier otro campo → 400.
//   201     : { profile: { username, display_name, bio, avatar_path, created_at,
//             updated_at } } (sin user_id).
//   400     : body ausente/no objeto/campos distintos de `username`/username no string.
//   401     : sin Bearer, JWT inválido (semántica de requireAuthenticated), o el usuario
//             ya no existe en auth.users (violación de FK).
//   405     : método distinto de POST (con Allow: POST).
//   409     : cualquier unique_violation (23505): el usuario ya tiene perfil o el
//             username está en uso; una única respuesta genérica para ambos.
//   422     : JSON bien formado pero username con formato inválido o reservado.
//   500     : error inesperado; mensaje genérico, nunca detalles de Postgres.
//
// El user_id del INSERT sale EXCLUSIVAMENTE de requireAuthenticated (JWT verificado),
// jamás del body. No hay pre-check de unicidad: el INSERT es la única comprobación y la
// base de datos decide (sin ventana TOCTOU); las violaciones se traducen solo por SQLSTATE.

const PUBLIC_COLUMNS = "username, display_name, bio, avatar_path, created_at, updated_at";

const GENERIC_ERROR_BODY = { error: "Error interno" };

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

type InsertFailure = "conflict" | "no_such_user" | "unexpected";

/** Clasifica un error de PostgREST/Postgres SOLO por su SQLSTATE (`code`). Nunca se
 *  inspecciona message/details/hint ni nombres de constraint: 23505 (unique_violation)
 *  es siempre "conflicto", sea por user_id (PK) o por username (UNIQUE), y el cliente
 *  recibe la misma respuesta. */
function classifyInsertError(error: unknown): InsertFailure {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "23505") return "conflict";
  if (code === "23503") return "no_such_user";
  return "unexpected";
}

export async function handleProfileCreate(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }

  let userId: string;
  try {
    ({ userId } = await requireAuthenticated(req));
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json(GENERIC_ERROR_BODY);
  }

  const body = parseJsonBody(req);
  const keys = body ? Object.keys(body) : [];
  if (!body || keys.length !== 1 || keys[0] !== "username") {
    return res.status(400).json({ error: "Solicitud inválida" });
  }
  if (typeof body.username !== "string") {
    return res.status(400).json({ error: "Solicitud inválida" });
  }

  const check = checkUsername(body.username);
  if (!check.ok) {
    return res.status(422).json({
      error: check.reason === "reserved" ? "Username no disponible" : "Username inválido",
    });
  }

  const url = process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }

  try {
    const client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client
      .from("profiles")
      .insert({ user_id: userId, username: check.username })
      .select(PUBLIC_COLUMNS)
      .single();

    if (error) {
      switch (classifyInsertError(error)) {
        case "conflict":
          return res.status(409).json({ error: "Username no disponible" });
        case "no_such_user":
          return res.status(401).json({ error: "No autenticado" });
        default:
          return res.status(500).json(GENERIC_ERROR_BODY);
      }
    }
    if (!data) return res.status(500).json(GENERIC_ERROR_BODY);

    // Se reconstruye explícitamente con las columnas públicas: nada más sale de aquí.
    const row = data as Record<string, unknown>;
    return res.status(201).json({
      profile: {
        username: row.username,
        display_name: row.display_name,
        bio: row.bio,
        avatar_path: row.avatar_path,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    });
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}
