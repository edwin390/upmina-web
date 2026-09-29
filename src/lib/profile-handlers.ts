import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, requireAuthenticated } from "./admin-auth.js";
import { checkBio, checkDisplayName } from "./profile-fields.js";
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

/** Reconstruye explícitamente con las columnas públicas: nada más sale de aquí. */
function publicProfileBody(data: unknown) {
  const row = data as Record<string, unknown>;
  return {
    profile: {
      username: row.username,
      display_name: row.display_name,
      bio: row.bio,
      avatar_path: row.avatar_path,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  };
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
  // `in` (y no `!check.ok`) estrecha la unión también sin strictNullChecks: una compilación
  // no estricta de api/profile.ts (tsconfig raíz sin compilerOptions) falla con `!check.ok`.
  if ("reason" in check) {
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

    return res.status(201).json(publicProfileBody(data));
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

// PATCH /api/profile (Bloque 7D.2; username añadido en 9J-1B): edita display_name, bio y/o
// username del perfil del usuario autenticado. Editar un perfil no es una acción privilegiada:
// AAL1 basta, sin admin_roles, MFA ni /api/admin/me — igual para el cambio de username: es
// identidad pública, no un privilegio.
//
// Contrato:
//   Request : PATCH, Bearer, body JSON con al menos una de las claves `display_name` / `bio`
//             (string | null) / `username` (string, NUNCA null). Cualquier otra clave, o {},
//             → 400 sin tocar la DB. Campo omitido = sin cambios; null/""/whitespace en
//             display_name o bio = NULL.
//   200     : { profile: {...} } (mismas seis columnas públicas que POST, sin user_id).
//             También se devuelve 200 si el ÚNICO cambio pedido era username y el valor
//             canónico coincide con el actual (no-op: no toca username_changed_at).
//   400 / 401 / 405 / 500 como antes; 404 si el usuario no tiene perfil.
//   409     : `code: "username_taken"` (unique_violation real) o `code: "cooldown_active"`
//             (+ `nextChangeAllowedAt` ISO 8601, para que la UI muestre cuándo podrá volver a
//             cambiarlo — nunca información sensible, solo esa fecha).
//   422     : `code: "invalid_username"` / `code: "username_reserved"` para username; mensajes
//             sin code para display_name/bio (comportamiento previo sin cambios) o por un CHECK
//             de la DB (23514, "Datos inválidos").
//
// El UPDATE de display_name/bio SIN username sigue siendo un único statement sin lectura
// previa, exactamente como antes (una fila inexistente = 0 filas = 404). Cambiar username SÍ
// necesita una lectura previa (username actual + username_changed_at): no hay forma de calcular
// el cooldown restante para el mensaje de error, ni de detectar el no-op de "mismo username",
// sin conocer el estado actual — esa lectura es el ÚNICO camino de este handler que hace un
// SELECT antes del UPDATE, y solo se ejecuta cuando el body pide cambiar username.

const ALLOWED_PATCH_KEYS: readonly string[] = ["display_name", "bio", "username"];

/** 30 días exactos, en milisegundos — mismo valor que decide el servidor para el cooldown y
 *  para "cuándo podrás volver a cambiarlo" en el error: nunca se deriva del reloj del cliente. */
const USERNAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

const hasOwn = (obj: object, key: string) =>
  Object.prototype.hasOwnProperty.call(obj, key);

function classifyUpdateError(
  error: unknown,
): "check_violation" | "conflict" | "unexpected" {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "23514") return "check_violation";
  if (code === "23505") return "conflict";
  return "unexpected";
}

interface CurrentUsernameRow {
  username: string;
  username_changed_at: string | null;
}

export async function handleProfileUpdate(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "PATCH") {
    res.setHeader("Allow", "PATCH");
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
  if (
    !body ||
    keys.length === 0 ||
    keys.some((key) => !ALLOWED_PATCH_KEYS.includes(key))
  ) {
    return res.status(400).json({ error: "Solicitud inválida" });
  }
  for (const key of ALLOWED_PATCH_KEYS) {
    if (!hasOwn(body, key)) continue;
    // username nunca es nullable (a diferencia de display_name/bio, que usan null = "borrar"):
    // no existe un perfil sin username, así que null aquí es simplemente una forma inválida.
    const allowsNull = key !== "username";
    const value = body[key];
    if (typeof value !== "string" && !(allowsNull && value === null)) {
      return res.status(400).json({ error: "Solicitud inválida" });
    }
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

    // Objeto UPDATE construido desde cero: solo las claves permitidas presentes, y solo si
    // representan un cambio real.
    const changes: {
      display_name?: string | null;
      bio?: string | null;
      username?: string;
    } = {};
    if (hasOwn(body, "display_name")) {
      const check = checkDisplayName(body.display_name as string | null);
      if (!check.ok) return res.status(422).json({ error: "Display name inválido" });
      changes.display_name = check.value;
    }
    if (hasOwn(body, "bio")) {
      const check = checkBio(body.bio as string | null);
      if (!check.ok) return res.status(422).json({ error: "Bio inválida" });
      changes.bio = check.value;
    }

    let noOpProfile: CurrentUsernameRow | null = null;
    if (hasOwn(body, "username")) {
      const check = checkUsername(body.username);
      if ("reason" in check) {
        return res.status(422).json({
          error:
            check.reason === "reserved" ? "Username no disponible" : "Username inválido",
          code: check.reason === "reserved" ? "username_reserved" : "invalid_username",
        });
      }

      const { data: current, error: readError } = await client
        .from("profiles")
        .select("username, username_changed_at")
        .eq("user_id", userId)
        .maybeSingle();
      if (readError) return res.status(500).json(GENERIC_ERROR_BODY);
      if (!current) return res.status(404).json({ error: "Perfil no encontrado" });
      const currentRow = current as CurrentUsernameRow;

      if (check.username === currentRow.username) {
        // Mismo username canónico: no-op explícito (nunca toca username_changed_at, nunca
        // consume/reinicia el cooldown). Si no hay ningún otro cambio en el body, se responde
        // con el estado actual sin tocar la DB en absoluto.
        noOpProfile = currentRow;
      } else if (currentRow.username_changed_at !== null) {
        const changedAtMs = new Date(currentRow.username_changed_at).getTime();
        const nextAllowedMs = changedAtMs + USERNAME_CHANGE_COOLDOWN_MS;
        // Reloj del SERVIDOR (Date.now()), nunca un valor del cliente: el body no puede influir
        // en esta comprobación de ninguna forma.
        if (Date.now() < nextAllowedMs) {
          return res.status(409).json({
            error: "Todavía no puedes cambiar tu username",
            code: "cooldown_active",
            nextChangeAllowedAt: new Date(nextAllowedMs).toISOString(),
          });
        }
        changes.username = check.username;
      } else {
        changes.username = check.username;
      }
    }

    if (Object.keys(changes).length === 0) {
      // Solo pudo llegar aquí un cambio de username no-op (mismo valor canónico) sin ningún
      // otro campo: éxito sin tocar la DB, nunca un 400 ni un 422 por "nada que cambiar".
      if (noOpProfile) {
        const { data, error } = await client
          .from("profiles")
          .select(PUBLIC_COLUMNS)
          .eq("user_id", userId)
          .maybeSingle();
        if (error) return res.status(500).json(GENERIC_ERROR_BODY);
        if (!data) return res.status(404).json({ error: "Perfil no encontrado" });
        return res.status(200).json(publicProfileBody(data));
      }
      return res.status(400).json({ error: "Solicitud inválida" });
    }

    const isUsernameChange = hasOwn(changes, "username");
    const { data, error } = await client
      .from("profiles")
      .update(
        isUsernameChange
          ? { ...changes, username_changed_at: new Date().toISOString() }
          : changes,
      )
      .eq("user_id", userId)
      .select(PUBLIC_COLUMNS)
      .maybeSingle();

    if (error) {
      const kind = classifyUpdateError(error);
      if (kind === "check_violation") {
        return res.status(422).json({ error: "Datos inválidos" });
      }
      if (isUsernameChange && kind === "conflict") {
        return res
          .status(409)
          .json({ error: "Username no disponible", code: "username_taken" });
      }
      return res.status(500).json(GENERIC_ERROR_BODY);
    }
    if (!data) return res.status(404).json({ error: "Perfil no encontrado" });

    return res.status(200).json(publicProfileBody(data));
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

/** Router interno de /api/profile: POST = onboarding, PATCH = edición. */
export function handleProfile(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> | VercelResponse {
  if (req.method === "POST") return handleProfileCreate(req, res);
  if (req.method === "PATCH") return handleProfileUpdate(req, res);
  res.setHeader("Allow", "POST, PATCH");
  return res.status(405).json({ error: "Método no permitido" });
}
