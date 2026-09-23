import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  TikTokOAuthError,
  getTikTokCredentials,
  refreshTikTokTokens,
  safeCode,
  type TikTokTokenSet,
} from "./tiktok-shared.js";

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

// ---------- refresh ----------

export type TikTokConnectionErrorReason =
  | "missing"
  | "refresh_token_expired"
  | "reauthorization_required"
  | "refresh_in_progress";

const CONNECTION_ERROR_MESSAGES: Record<TikTokConnectionErrorReason, string> = {
  missing: "No hay conexión de TikTok guardada",
  refresh_token_expired:
    "El refresh token de TikTok ha caducado: hace falta reautorizar TikTok desde el panel de administración",
  reauthorization_required:
    "TikTok rechazó el refresh token (invalid_grant): hace falta reautorizar TikTok desde el panel de administración",
  refresh_in_progress: "Otra petición está refrescando la conexión de TikTok",
};

/**
 * La conexión guardada no permite llamar a TikTok. `reason` la hace distinguible en logs
 * y código; el cliente solo recibe un mensaje genérico. `refresh_token_expired` y
 * `reauthorization_required` significan que hay que volver a autorizar TikTok desde el panel de administración.
 */
export class TikTokConnectionError extends Error {
  readonly status = 503;
  constructor(readonly reason: TikTokConnectionErrorReason) {
    super(CONNECTION_ERROR_MESSAGES[reason]);
    this.name = "TikTokConnectionError";
  }
}

/** Margen antes de la caducidad real para no usar un token a punto de expirar. */
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;
/** Vigencia del lease de refresh: cubre un refresh normal y caduca solo si la función muere. */
const REFRESH_LEASE_MS = 30_000;
/** Espera máxima a que otra petición termine su refresh: 6 × 500 ms. */
const REFRESH_WAIT_ATTEMPTS = 6;
const REFRESH_WAIT_INTERVAL_MS = 500;
const REFRESH_SAVE_ATTEMPTS = 2;

/**
 * Adquiere de forma ATÓMICA el lease de refresh: un único UPDATE condicionado a que el
 * refresh token siga siendo el esperado y a que nadie tenga un lease vigente. Devuelve
 * true solo si esta petición se llevó la fila.
 */
export async function acquireTikTokRefreshLease(
  refreshToken: string,
  now: number = Date.now(),
): Promise<boolean> {
  const client = getSupabaseAdmin();
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await client
      .from(TABLE)
      .update({ refresh_lock_until: new Date(now + REFRESH_LEASE_MS).toISOString() })
      .eq("provider", PROVIDER)
      .eq("refresh_token", refreshToken)
      .or(
        `refresh_lock_until.is.null,refresh_lock_until.lt.${new Date(now).toISOString()}`,
      )
      .select("provider"));
  } catch (err) {
    throw storageError("lease", err);
  }
  if (error) throw storageError("lease", error);
  return Array.isArray(data) && data.length > 0;
}

/** Libera el lease (best effort: si falla, caduca solo). */
async function releaseTikTokRefreshLease(refreshToken: string): Promise<void> {
  try {
    await getSupabaseAdmin()
      .from(TABLE)
      .update({ refresh_lock_until: null })
      .eq("provider", PROVIDER)
      .eq("refresh_token", refreshToken);
  } catch {
    // Se ignora: el lease caduca solo.
  }
}

/**
 * Guarda el token set NUEVO completo tras un refresh (access, refresh y ambas
 * expiraciones) y limpia el lease. Es una escritura condicionada al refresh token que se
 * usó: si otra autorización lo cambió entretanto no se sobrescribe nada y devuelve false.
 */
async function saveRefreshedTikTokConnection(
  tokens: TikTokTokenSet,
  previousRefreshToken: string,
  now: number,
): Promise<boolean> {
  const client = getSupabaseAdmin();
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await client
      .from(TABLE)
      .update({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        access_token_expires_at: new Date(now + tokens.expiresIn * 1000).toISOString(),
        refresh_token_expires_at: new Date(
          now + tokens.refreshExpiresIn * 1000,
        ).toISOString(),
        scope: tokens.scope,
        refresh_lock_until: null,
        updated_at: new Date(now).toISOString(),
      })
      .eq("provider", PROVIDER)
      .eq("refresh_token", previousRefreshToken)
      .select("provider"));
  } catch (err) {
    throw storageError("refresh-save", err);
  }
  if (error) throw storageError("refresh-save", error);
  return Array.isArray(data) && data.length > 0;
}

function isAccessTokenUsable(connection: TikTokConnection, now: number): boolean {
  const expiresAt = Date.parse(connection.accessTokenExpiresAt);
  if (Number.isNaN(expiresAt)) {
    throw new TikTokStorageError("Conexión guardada con formato inválido", 500);
  }
  return expiresAt - ACCESS_TOKEN_EXPIRY_SKEW_MS > now;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** El guardado no aplicó porque la conexión cambió (p. ej. reautorización) durante el refresh. */
const CONNECTION_CHANGED_MESSAGE = "La conexión cambió durante el refresh";

/**
 * Refresca la conexión bajo lease y devuelve el access token vigente, o null si otra
 * petición tiene el lease. Nunca borra tokens: ante cualquier fallo la conexión guardada
 * queda intacta.
 */
async function refreshUnderLease(
  connection: TikTokConnection,
  now: number,
): Promise<string | null> {
  // Sin credenciales de la app no se toma el lease: no habría refresh posible.
  const credentials = getTikTokCredentials();
  if (!(await acquireTikTokRefreshLease(connection.refreshToken, now))) return null;

  // Con el lease en mano se relee: otra petición pudo terminar su refresh justo antes.
  const fresh = await getTikTokConnection();
  if (!fresh) throw new TikTokConnectionError("missing");
  if (isAccessTokenUsable(fresh, now)) {
    await releaseTikTokRefreshLease(fresh.refreshToken);
    return fresh.accessToken;
  }

  let tokens: TikTokTokenSet;
  try {
    tokens = await refreshTikTokTokens(fresh.refreshToken, credentials);
  } catch (err) {
    // El lease NO se libera: su caducidad actúa como espera antes de reintentar contra
    // TikTok (y evita martillearlo si está rechazando). La conexión sigue intacta.
    if (err instanceof TikTokOAuthError && err.providerCode === "invalid_grant") {
      throw new TikTokConnectionError("reauthorization_required");
    }
    throw err;
  }

  // Nunca se sobrescribe la conexión con la cuenta equivocada.
  if (tokens.openId !== fresh.openId) {
    throw new TikTokOAuthError("TikTok devolvió tokens de otra cuenta", 502);
  }
  // Algunos refresh no repiten el scope: se conserva el guardado.
  const toSave = { ...tokens, scope: tokens.scope || fresh.scope };

  // Si TikTok rotó el refresh token, el anterior puede haber quedado inválido: un fallo
  // transitorio al guardar se reintenta una vez antes de rendirse.
  let lastError: unknown;
  for (let attempt = 0; attempt < REFRESH_SAVE_ATTEMPTS; attempt++) {
    try {
      const saved = await saveRefreshedTikTokConnection(
        toSave,
        fresh.refreshToken,
        Date.now(),
      );
      if (saved) return tokens.accessToken;
      // Otra autorización cambió la conexión mientras tanto: no se pisa ni se reintenta.
      throw new TikTokStorageError(CONNECTION_CHANGED_MESSAGE, 500);
    } catch (err) {
      lastError = err;
      if (err instanceof TikTokStorageError && err.message === CONNECTION_CHANGED_MESSAGE)
        break;
    }
  }
  throw lastError;
}

/**
 * Regla ÚNICA de "el refresh token guardado ya caducó y hace falta reautorizar" (no se puede
 * renovar). La usan tanto el feed (getUsableTikTokAccessToken) como el panel de conexiones
 * (estado reauth_required), para que ambos nunca discrepen. `refreshTokenExpiresAt` es el valor
 * ISO absoluto persistido.
 */
export function isTikTokRefreshTokenExpired(
  refreshTokenExpiresAt: string,
  now: number,
): boolean {
  return Date.parse(refreshTokenExpiresAt) <= now;
}

/**
 * Access token de la conexión guardada, listo para llamar a TikTok (solo servidor).
 * - Vigente (con más de 60 s de margen) → se usa tal cual, sin refresh.
 * - Vencido o dentro del margen → refresh con el refresh token guardado, guardando el
 *   token set nuevo completo (el refresh token puede rotar) y devolviendo el nuevo token.
 * - Sin conexión → `TikTokConnectionError("missing")`. Refresh token caducado o rechazado
 *   (invalid_grant) → `TikTokConnectionError("refresh_token_expired" | "reauthorization_required")`:
 *   hace falta reautorizar. Otro fallo → error del proveedor / almacenamiento.
 *
 * Concurrencia: ver `acquireTikTokRefreshLease`. Solo una petición refresca; las demás
 * esperan (relectura cada 500 ms, hasta ~3 s) y usan el token que aquella guarde.
 */
export async function getUsableTikTokAccessToken(
  nowArg?: number,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 0; attempt < REFRESH_WAIT_ATTEMPTS; attempt++) {
    const now = nowArg ?? Date.now();
    const connection = await getTikTokConnection();
    if (!connection) throw new TikTokConnectionError("missing");
    if (isAccessTokenUsable(connection, now)) return connection.accessToken;

    const refreshExpiresAt = Date.parse(connection.refreshTokenExpiresAt);
    if (Number.isNaN(refreshExpiresAt)) {
      throw new TikTokStorageError("Conexión guardada con formato inválido", 500);
    }
    if (isTikTokRefreshTokenExpired(connection.refreshTokenExpiresAt, now)) {
      throw new TikTokConnectionError("refresh_token_expired");
    }

    const accessToken = await refreshUnderLease(connection, now);
    if (accessToken) return accessToken;

    // Otra petición está refrescando: se espera y se relee.
    await sleep(REFRESH_WAIT_INTERVAL_MS);
  }
  throw new TikTokConnectionError("refresh_in_progress");
}

/** Registra solo mensaje genérico y código saneado. */
export function logTikTokStorageError(handler: string, err: unknown): void {
  if (!(err instanceof TikTokStorageError)) {
    console.error(`[${handler}] error de almacenamiento inesperado`);
    return;
  }
  console.error(`[${handler}] ${err.message}${err.code ? ` (code=${err.code})` : ""}`);
}
