import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Persistencia de la conexión de Instagram en Supabase (tabla social_connections, fila
// provider = 'instagram'; ver supabase/migrations) y consumo de un solo uso del
// state/nonce del OAuth (tabla instagram_oauth_nonces). SOLO servidor: usa la
// service_role key, que omite RLS. Es independiente de src/lib/supabase.ts (cliente del
// navegador) y de tiktok-connection.ts, que no se toca.
//
// Regla de seguridad: los tokens solo viajan entre Meta, esta capa y la tabla. Nunca se
// registran, ni se incluyen en errores o respuestas. Los errores de Supabase se reducen a
// un código saneado. La tabla de nonces solo guarda un hash, nunca el nonce ni el state
// completo (ver claimInstagramOAuthNonce).

const TABLE = "social_connections";
const PROVIDER = "instagram";
const NONCE_TABLE = "instagram_oauth_nonces";

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

/** Falla con 503 si Supabase no está configurado; permite comprobarlo sin tocar la red ni
 *  gastar el authorization code (de un solo uso) si el guardado no va a poder ocurrir. */
export function assertInstagramStorageConfigured(): void {
  getSupabaseAdmin();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// ---------- consumo de un solo uso del state/nonce (Lote 3B.1) ----------
//
// El HMAC del `state` (ver instagram-oauth-shared.ts) ya garantiza que solo este
// servidor pudo emitirlo y que no fue alterado ni ha expirado, pero eso NO impide que la
// misma petición de callback (mismo state + cookie) se reenvíe manualmente y complete el
// intercambio dos veces: sin nada más, la única barrera real ante esa repetición sería
// que Meta rechace un authorization code ya usado, y no queremos depender solo de eso.
//
// claimInstagramOAuthNonce resuelve esto con un INSERT atómico: la primera llamada para
// un nonce dado inserta la fila (gana); cualquier repetición —secuencial o dos peticiones
// concurrentes con el mismo state— choca con la primary key de la tabla y pierde. No hace
// falta Redis ni ningún servicio externo: la garantía de atomicidad la da la propia
// restricción única de Postgres, igual que ya usa el lease de refresh de TikTok
// (acquireTikTokRefreshLease en tiktok-connection.ts) para el mismo tipo de problema.
//
// Solo se guarda el hash SHA-256 del nonce (nunca el nonce, el `state` completo, el code
// ni ningún token). La limpieza de nonces expirados es oportunista (se ejecuta en cada
// intento de reclamación): no requiere cron ni infraestructura adicional.

export type InstagramOAuthNonceClaim = "claimed" | "already_used";

function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

/**
 * Reclama el nonce del `state` de forma atómica ANTES de contactar a Meta y antes de
 * guardar la conexión. Debe llamarse exactamente una vez por callback, después de validar
 * el `state` (verifyInstagramState) y antes de exchangeInstagramCode.
 *
 * - Primera llamada para un nonce → lo inserta y devuelve "claimed": el callback puede
 *   continuar.
 * - Repetición del mismo nonce (secuencial o concurrente) → "already_used": el callback
 *   debe rechazar la petición sin tocar Meta ni social_connections.
 * - Fail-closed: cualquier error de Supabase que no sea el choque esperado con la primary
 *   key (violación 23505) se propaga como InstagramStorageError. Nunca se interpreta un
 *   fallo del mecanismo como "claimed": si no se puede confirmar que el nonce es nuevo,
 *   la petición se rechaza (el llamador no debe continuar ante una excepción).
 */
export async function claimInstagramOAuthNonce(
  nonce: string,
  expiresAtMs: number,
  now: number = Date.now(),
): Promise<InstagramOAuthNonceClaim> {
  const client = getSupabaseAdmin();
  const nonceHash = hashNonce(nonce);

  // Limpieza oportunista de nonces ya expirados (best effort: un fallo aquí no debe
  // impedir la reclamación real ni interpretarse como fail-open).
  try {
    await client.from(NONCE_TABLE).delete().lt("expires_at", new Date(now).toISOString());
  } catch {
    // Ignorado a propósito: es solo higiene de la tabla, no afecta la garantía de
    // un solo uso (esa la da la primary key en el insert de abajo).
  }

  let error: unknown;
  try {
    ({ error } = await client.from(NONCE_TABLE).insert({
      nonce_hash: nonceHash,
      expires_at: new Date(expiresAtMs).toISOString(),
    }));
  } catch (err) {
    throw storageError("claim-nonce", err);
  }
  if (error) {
    // 23505 = violación de la primary key: alguien (una repetición, u otra petición
    // concurrente) ya reclamó este nonce. No es un fallo: es el resultado esperado.
    if ((error as { code?: unknown }).code === "23505") return "already_used";
    throw storageError("claim-nonce", error);
  }
  return "claimed";
}

/** Los Instagram-scoped user id son numéricos (mismo formato que instagram-oauth-shared.ts;
 *  no se importa de allí para mantener este módulo independiente, igual que ya es
 *  independiente de tiktok-connection.ts). */
const PROVIDER_USER_ID_FORMAT = /^\d{1,32}$/;

/** Tokens ya intercambiados con Meta, listos para persistir. SOLO para código servidor. */
export interface InstagramTokenSet {
  accessToken: string;
  providerUserId: string;
  /** Segundos de vida del access token de larga duración, desde su emisión. */
  expiresIn: number;
  scope: string;
}

export interface SavedInstagramConnection {
  providerUserId: string;
  /** ISO 8601 UTC, absoluto. */
  accessTokenExpiresAt: string;
}

/**
 * Guarda (upsert por proveedor) la conexión OAuth de Instagram. Como solo hay una cuenta
 * autorizada para el sitio, la restricción única en `provider` hace que re-autorizar
 * actualice la fila existente sin duplicarla. `created_at` no se envía, así que se
 * conserva; `updated_at` se refresca.
 *
 * `refresh_token`/`refresh_token_expires_at` nunca se envían: Instagram (Instagram Login)
 * no tiene un refresh token separado (su propio access token largo se renueva a sí mismo
 * con ig_refresh_token, en un lote posterior), y el CHECK de la migración exige que para
 * provider = 'instagram' ambas columnas sean NULL.
 *
 * El upsert es atómico y NUNCA borra la fila anterior antes de escribir: si esta llamada
 * falla (red, permisos, formato), la conexión previa —si existía— sigue intacta y
 * sirviendo tráfico; no hay ventana en la que Instagram se quede sin token utilizable por
 * culpa de un OAuth nuevo que no llegó a completarse. Devuelve solo metadatos: nunca el
 * token.
 */
export async function saveInstagramConnection(
  tokens: InstagramTokenSet,
  now: number = Date.now(),
): Promise<SavedInstagramConnection> {
  // Validación antes de tocar Supabase: una identidad o token con formato inválido nunca
  // debe llegar a escribirse, ni siquiera intentarlo.
  if (!isNonEmptyString(tokens.accessToken)) {
    throw new Error("saveInstagramConnection: accessToken inválido");
  }
  if (!PROVIDER_USER_ID_FORMAT.test(tokens.providerUserId)) {
    throw new Error("saveInstagramConnection: providerUserId inválido");
  }
  if (!Number.isFinite(tokens.expiresIn) || tokens.expiresIn <= 0) {
    throw new Error("saveInstagramConnection: expiresIn inválido");
  }

  const client = getSupabaseAdmin();
  const accessTokenExpiresAt = new Date(now + tokens.expiresIn * 1000).toISOString();

  let error: unknown;
  try {
    ({ error } = await client.from(TABLE).upsert(
      {
        provider: PROVIDER,
        provider_user_id: tokens.providerUserId,
        access_token: tokens.accessToken,
        access_token_expires_at: accessTokenExpiresAt,
        scope: tokens.scope,
        updated_at: new Date(now).toISOString(),
      },
      { onConflict: "provider" },
    ));
  } catch (err) {
    throw storageError("save", err);
  }
  if (error) throw storageError("save", error);

  return { providerUserId: tokens.providerUserId, accessTokenExpiresAt };
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
