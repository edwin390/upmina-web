import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Persistencia de la conexión de Instagram en Supabase (tabla social_connections, fila
// provider = 'instagram'; ver supabase/migrations). SOLO servidor: usa la service_role key,
// que omite RLS. Es independiente de src/lib/supabase.ts (cliente del navegador) y de
// tiktok-connection.ts, que no se toca.
//
// Este módulo solo LEE y resuelve el token. Guardar la conexión, el OAuth y la renovación
// llegarán en lotes posteriores.
//
// Regla de seguridad: los tokens solo viajan entre Meta, esta capa y la tabla. Nunca se
// registran, ni se incluyen en errores o respuestas. Los errores de Supabase se reducen a
// un código saneado.

const TABLE = "social_connections";
const PROVIDER = "instagram";

/** Margen antes de la caducidad real para no usar un token a punto de expirar. */
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;

export class InstagramStorageError extends Error {
  constructor(
    message: string,
    /** Status HTTP con el que respondería una función: 503 sin configuración, 500 resto. */
    readonly status: number,
    /** Código de Postgres/PostgREST (p. ej. `42501`), solo si tiene forma de código. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "InstagramStorageError";
  }
}

/** La fila guardada no tiene la forma esperada: nunca se usa ni se sustituye por el env. */
export class InstagramConnectionFormatError extends InstagramStorageError {
  constructor() {
    super("Conexión de Instagram guardada con formato inválido", 500);
    this.name = "InstagramConnectionFormatError";
  }
}

export type InstagramConnectionErrorReason = "missing_token" | "expired";

const CONNECTION_ERROR_MESSAGES: Record<InstagramConnectionErrorReason, string> = {
  missing_token: "Falta la variable de entorno de Instagram: INSTAGRAM_ACCESS_TOKEN",
  expired: "La conexión de Instagram guardada ha caducado: hace falta reconectar",
};

/** No hay un token de Instagram utilizable. Responde 503; el mensaje no lleva secretos. */
export class InstagramConnectionError extends Error {
  readonly status = 503;
  constructor(readonly reason: InstagramConnectionErrorReason) {
    super(CONNECTION_ERROR_MESSAGES[reason]);
    this.name = "InstagramConnectionError";
  }
}

/** Cliente admin de Supabase; 503 si falta la URL o la service_role key. */
function getSupabaseAdmin(): SupabaseClient {
  // La URL es pública (la misma del cliente web); la service_role key es secreta.
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) {
    throw new InstagramStorageError(
      "Faltan VITE_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY",
      503,
    );
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9_.-]{1,64}$/i.test(value)
    ? value
    : undefined;
}

function storageError(operation: string, err: unknown): InstagramStorageError {
  // Nunca se propaga `message`/`details` del error original: podrían citar valores.
  const code = safeCode((err as { code?: unknown } | null)?.code);
  return new InstagramStorageError(`Error de almacenamiento (${operation})`, 500, code);
}

/** Conexión guardada. Contiene el token: solo para código servidor, jamás serializar. */
export interface InstagramConnection {
  providerUserId: string;
  accessToken: string;
  /** ISO 8601, absoluto. */
  accessTokenExpiresAt: string;
  scope: string;
}

interface ConnectionRow {
  provider?: unknown;
  provider_user_id?: unknown;
  access_token?: unknown;
  access_token_expires_at?: unknown;
  scope?: unknown;
}

/**
 * Devuelve la conexión de Instagram guardada, o `null` si aún no se autorizó ninguna cuenta.
 * Solo se consulta `provider = 'instagram'`: una fila de otra red nunca se interpreta como
 * conexión de Instagram. No lee las columnas de refresh (Instagram no las usa).
 */
export async function getInstagramConnection(): Promise<InstagramConnection | null> {
  const client = getSupabaseAdmin();

  let data: ConnectionRow | null;
  let error: unknown;
  try {
    ({ data, error } = await client
      .from(TABLE)
      .select("provider, provider_user_id, access_token, access_token_expires_at, scope")
      .eq("provider", PROVIDER)
      .maybeSingle<ConnectionRow>());
  } catch (err) {
    throw storageError("get", err);
  }
  if (error) throw storageError("get", error);
  if (!data) return null;

  const { provider, provider_user_id, access_token, access_token_expires_at } = data;
  if (
    provider !== PROVIDER ||
    typeof provider_user_id !== "string" ||
    !provider_user_id ||
    typeof access_token !== "string" ||
    !access_token ||
    typeof access_token_expires_at !== "string" ||
    Number.isNaN(Date.parse(access_token_expires_at))
  ) {
    throw new InstagramConnectionFormatError();
  }

  return {
    providerUserId: provider_user_id,
    accessToken: access_token,
    accessTokenExpiresAt: access_token_expires_at,
    scope: typeof data.scope === "string" ? data.scope : "",
  };
}

/**
 * Token de respaldo TEMPORAL (INSTAGRAM_ACCESS_TOKEN) mientras no exista la conexión OAuth
 * persistida. Se eliminará en un lote posterior, junto con los fallbacks de más abajo.
 */
function getEnvFallbackToken(): string | undefined {
  return process.env.INSTAGRAM_ACCESS_TOKEN?.trim() || undefined;
}

/**
 * Access token de Instagram listo para llamar a Meta (solo servidor).
 * - Fila de Instagram con más de 60 s de vigencia → su token.
 * - Fila con el token caducado o a ≤ 60 s de caducar → `InstagramConnectionError("expired")`
 *   (503), SIN fallback: no se sirve en silencio el token de otra cuenta si ya hay una
 *   conexión guardada.
 * - Fila con formato inválido → error 500, tampoco hay fallback.
 * - Sin fila, Supabase sin configurar o error al leerlo (registrado de forma saneada) →
 *   fallback TEMPORAL a INSTAGRAM_ACCESS_TOKEN.
 * - Sin nada de lo anterior → `InstagramConnectionError("missing_token")` (503), o el
 *   error de almacenamiento si fue un fallo de lectura.
 */
export async function getUsableInstagramAccessToken(
  now: number = Date.now(),
): Promise<string> {
  let connection: InstagramConnection | null;
  try {
    connection = await getInstagramConnection();
  } catch (err) {
    if (
      !(err instanceof InstagramStorageError) ||
      err instanceof InstagramConnectionFormatError
    ) {
      throw err;
    }
    // 503 = Supabase sin configurar (caso normal hoy): fallback silencioso. Cualquier otro
    // fallo de lectura se registra (sin secretos) antes de usar el fallback temporal.
    const fallback = getEnvFallbackToken();
    if (err.status !== 503)
      logInstagramStorageError("instagram-connection", err, !!fallback);
    if (fallback) return fallback;
    if (err.status === 503) throw new InstagramConnectionError("missing_token");
    throw err;
  }

  if (!connection) {
    const fallback = getEnvFallbackToken();
    if (!fallback) throw new InstagramConnectionError("missing_token");
    return fallback;
  }

  const expiresAt = Date.parse(connection.accessTokenExpiresAt);
  if (expiresAt - ACCESS_TOKEN_EXPIRY_SKEW_MS <= now) {
    throw new InstagramConnectionError("expired");
  }
  return connection.accessToken;
}

/** Registra solo mensaje genérico y código saneado. */
export function logInstagramStorageError(
  handler: string,
  err: unknown,
  usingFallback = false,
): void {
  if (!(err instanceof InstagramStorageError)) {
    console.error(`[${handler}] error de almacenamiento inesperado`);
    return;
  }
  console.error(
    `[${handler}] ${err.message}${err.code ? ` (code=${err.code})` : ""}${
      usingFallback ? "; usando INSTAGRAM_ACCESS_TOKEN" : ""
    }`,
  );
}
