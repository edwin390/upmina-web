import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { safeCode, type TikTokTokenSet } from "./tiktok-shared.js";

// Persistencia de la conexión OAuth de TikTok en Supabase (tabla social_connections,
// ver supabase/migrations). SOLO servidor: usa la service_role key, que omite RLS.
// Es independiente de src/lib/supabase.ts, que es el cliente del navegador (anon key).
//
// Regla de seguridad: los tokens solo viajan entre TikTok, esta capa y la tabla. Nunca
// se registran, ni se incluyen en errores o respuestas. Los errores de Supabase se
// reducen a un código saneado.

const TABLE = "social_connections";
const PROVIDER = "tiktok";

export class TikTokStorageError extends Error {
  constructor(
    message: string,
    /** Status HTTP con el que respondería una función: 503 sin configuración, 500 resto. */
    readonly status: number,
    /** Código de Postgres/PostgREST (p. ej. `42501`), solo si tiene forma de código. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "TikTokStorageError";
  }
}

/** Cliente admin de Supabase; 503 si falta la URL o la service_role key. */
function getSupabaseAdmin(): SupabaseClient {
  // La URL es pública (la misma del cliente web); la service_role key es secreta.
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) {
    throw new TikTokStorageError(
      "Faltan VITE_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY",
      503,
    );
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Falla con 503 si Supabase no está configurado; permite comprobarlo sin tocar la red. */
export function assertTikTokStorageConfigured(): void {
  getSupabaseAdmin();
}

function storageError(operation: string, err: unknown): TikTokStorageError {
  // Nunca se propaga `message`/`details` del error original: podrían citar valores.
  const code = safeCode((err as { code?: unknown } | null)?.code);
  return new TikTokStorageError(`Error de almacenamiento (${operation})`, 500, code);
}

export interface SavedTikTokConnection {
  openId: string;
  /** ISO 8601 UTC, absoluto. */
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
}

/**
 * Guarda (upsert por proveedor) la conexión TikTok. Como solo hay una cuenta autorizada
 * para el sitio, la restricción única en `provider` hace que re-autorizar actualice la
 * fila existente. `created_at` no se envía, así que se conserva; `updated_at` se refresca.
 * Devuelve solo metadatos: nunca los tokens.
 */
export async function saveTikTokConnection(
  tokens: TikTokTokenSet,
  now: number = Date.now(),
): Promise<SavedTikTokConnection> {
  const client = getSupabaseAdmin();
  const accessTokenExpiresAt = new Date(now + tokens.expiresIn * 1000).toISOString();
  const refreshTokenExpiresAt = new Date(
    now + tokens.refreshExpiresIn * 1000,
  ).toISOString();

  let error: unknown;
  try {
    ({ error } = await client.from(TABLE).upsert(
      {
        provider: PROVIDER,
        provider_user_id: tokens.openId,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        access_token_expires_at: accessTokenExpiresAt,
        refresh_token_expires_at: refreshTokenExpiresAt,
        scope: tokens.scope,
        updated_at: new Date(now).toISOString(),
      },
      { onConflict: "provider" },
    ));
  } catch (err) {
    throw storageError("save", err);
  }
  if (error) throw storageError("save", error);

  return { openId: tokens.openId, accessTokenExpiresAt, refreshTokenExpiresAt };
}

/** Conexión guardada. Contiene tokens: solo para código servidor, jamás serializar. */
export interface TikTokConnection {
  openId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  scope: string;
}

interface ConnectionRow {
  provider_user_id?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  access_token_expires_at?: unknown;
  refresh_token_expires_at?: unknown;
  scope?: unknown;
}

/** Devuelve la conexión TikTok guardada, o `null` si aún no se autorizó ninguna cuenta. */
export async function getTikTokConnection(): Promise<TikTokConnection | null> {
  const client = getSupabaseAdmin();

  let data: ConnectionRow | null;
  let error: unknown;
  try {
    ({ data, error } = await client
      .from(TABLE)
      .select(
        "provider_user_id, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, scope",
      )
      .eq("provider", PROVIDER)
      .maybeSingle<ConnectionRow>());
  } catch (err) {
    throw storageError("get", err);
  }
  if (error) throw storageError("get", error);
  if (!data) return null;

  const { provider_user_id, access_token, refresh_token } = data;
  const { access_token_expires_at, refresh_token_expires_at } = data;
  if (
    typeof provider_user_id !== "string" ||
    typeof access_token !== "string" ||
    typeof refresh_token !== "string" ||
    typeof access_token_expires_at !== "string" ||
    typeof refresh_token_expires_at !== "string"
  ) {
    throw new TikTokStorageError("Conexión guardada con formato inválido", 500);
  }

  return {
    openId: provider_user_id,
    accessToken: access_token,
    refreshToken: refresh_token,
    accessTokenExpiresAt: access_token_expires_at,
    refreshTokenExpiresAt: refresh_token_expires_at,
    scope: typeof data.scope === "string" ? data.scope : "",
  };
}

/** Registra solo mensaje genérico y código saneado. */
export function logTikTokStorageError(handler: string, err: unknown): void {
  if (!(err instanceof TikTokStorageError)) {
    console.error(`[${handler}] error de almacenamiento inesperado`);
    return;
  }
  console.error(`[${handler}] ${err.message}${err.code ? ` (code=${err.code})` : ""}`);
}
