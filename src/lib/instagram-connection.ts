import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  logInstagramOAuthError,
  refreshInstagramAccessToken,
  type InstagramRefreshedToken,
} from "./instagram-oauth-shared.js";

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
/** Umbral de renovación proactiva: por debajo de esta antelación se intenta refrescar
 *  contra Meta, muy por encima del margen duro de arriba y del mínimo de 24h que exige
 *  Meta para poder renovar un token de ~60 días de vida. */
const RENEWAL_THRESHOLD_MS = 7 * 24 * 60 * 60_000;
/** Vigencia del lease de renovación: igual que el de TikTok (cubre una renovación normal
 *  y caduca solo si la función muere a mitad). */
const REFRESH_LEASE_MS = 30_000;
/** Espera única antes de releer si otra petición ya tiene el lease de renovación. */
const REFRESH_WAIT_INTERVAL_MS = 500;

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
 * con ig_refresh_token, ver la sección de auto-refresh más abajo), y el CHECK de la
 * migración exige que para provider = 'instagram' ambas columnas sean NULL.
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

// ---------- renovación automática (auto-refresh) ----------
//
// Instagram no tiene un refresh token separado: el propio access token largo se renueva
// a sí mismo con ig_refresh_token (ver refreshInstagramAccessToken en
// instagram-oauth-shared.ts). El lease reutiliza la misma columna `refresh_lock_until`
// que ya usa TikTok (ver acquireTikTokRefreshLease en tiktok-connection.ts) con el mismo
// patrón de UPDATE atómico condicionado, pero condicionado por `access_token` —la única
// "versión" estable del token en Instagram— en vez de por `refresh_token`, que aquí
// siempre es NULL. No requiere ninguna migración nueva: la columna ya es genérica.
//
// Política (ver docs/lote de diseño aprobado):
//   - más de RENEWAL_THRESHOLD_MS de vigencia → se usa tal cual, sin tocar Meta;
//   - dentro del umbral pero por encima del margen duro → se intenta renovar bajo lease;
//   - a partir del margen duro (ACCESS_TOKEN_EXPIRY_SKEW_MS) → nunca se usa, sin
//     fallback a INSTAGRAM_ACCESS_TOKEN (igual que ya hacía "expired" antes de esto).
// Un fallo de Meta o de Supabase durante la renovación nunca tumba una petición cuyo
// token actual sigue siendo válido: se registra de forma saneada y se sirve ese token.

/** Adquiere de forma ATÓMICA el lease de renovación: un único UPDATE condicionado a que
 *  el `access_token` siga siendo el esperado y a que nadie tenga un lease vigente.
 *  Devuelve true solo si esta petición se llevó la fila. */
export async function acquireInstagramRefreshLease(
  accessToken: string,
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
      .eq("access_token", accessToken)
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

/** Libera el lease (best effort: si falla, caduca solo a los 30 s). */
async function releaseInstagramRefreshLease(accessToken: string): Promise<void> {
  try {
    await getSupabaseAdmin()
      .from(TABLE)
      .update({ refresh_lock_until: null })
      .eq("provider", PROVIDER)
      .eq("access_token", accessToken);
  } catch {
    // Se ignora: el lease caduca solo.
  }
}

/**
 * Guarda el access token renovado (y su nueva expiración) tras un refresh exitoso, y
 * libera el lease en el mismo UPDATE. Escritura condicionada al access token que se usó
 * para renovar: si la conexión cambió mientras tanto (reautorización, u otra renovación
 * que ya escribió) no se sobrescribe nada y devuelve false. `refresh_token` /
 * `refresh_token_expires_at` nunca se incluyen: Instagram sigue sin usarlos y deben
 * seguir NULL.
 */
async function saveRefreshedInstagramConnection(
  refreshed: InstagramRefreshedToken,
  previousAccessToken: string,
  now: number,
): Promise<boolean> {
  const client = getSupabaseAdmin();
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await client
      .from(TABLE)
      .update({
        access_token: refreshed.accessToken,
        access_token_expires_at: new Date(now + refreshed.expiresIn * 1000).toISOString(),
        refresh_lock_until: null,
        updated_at: new Date(now).toISOString(),
      })
      .eq("provider", PROVIDER)
      .eq("access_token", previousAccessToken)
      .select("provider"));
  } catch (err) {
    throw storageError("refresh-save", err);
  }
  if (error) throw storageError("refresh-save", error);
  return Array.isArray(data) && data.length > 0;
}

function isRenewalDue(connection: InstagramConnection, now: number): boolean {
  return Date.parse(connection.accessTokenExpiresAt) - now <= RENEWAL_THRESHOLD_MS;
}

function isStillUsable(connection: InstagramConnection, now: number): boolean {
  return Date.parse(connection.accessTokenExpiresAt) - ACCESS_TOKEN_EXPIRY_SKEW_MS > now;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Intenta renovar bajo lease y devuelve el token vigente resultante, o `null` si no se
 * consiguió el lease (otra petición ya está renovando). Nunca borra ni invalida el
 * token guardado: ante cualquier fallo de Meta o de Supabase la conexión previa queda
 * intacta, y se sirve el token actual mientras siga siendo válido.
 */
async function renewInstagramConnectionUnderLease(
  connection: InstagramConnection,
  now: number,
): Promise<string | null> {
  if (!(await acquireInstagramRefreshLease(connection.accessToken, now))) return null;

  // Con el lease en mano se relee: otra petición pudo terminar su renovación justo
  // antes de que esta lo consiguiera.
  const fresh = await getInstagramConnection();
  if (!fresh) {
    await releaseInstagramRefreshLease(connection.accessToken);
    throw new InstagramConnectionError("missing_token");
  }
  if (fresh.accessToken !== connection.accessToken || !isRenewalDue(fresh, now)) {
    // Ya no hace falta renovar (otra petición lo hizo, o la relectura ya no está dentro
    // del umbral): liberar el lease tomado sobre el access_token vigente y usarlo.
    await releaseInstagramRefreshLease(fresh.accessToken);
    return fresh.accessToken;
  }

  let refreshed: InstagramRefreshedToken;
  try {
    refreshed = await refreshInstagramAccessToken(fresh.accessToken);
  } catch (err) {
    // A diferencia de TikTok, Instagram no rota el token en cada intento: no hay ventaja
    // en mantener el lease bloqueado hasta que caduque solo, así que se libera de una
    // vez para no bloquear el próximo intento.
    await releaseInstagramRefreshLease(fresh.accessToken);
    logInstagramOAuthError("instagram-connection", err);
    if (isStillUsable(fresh, now)) return fresh.accessToken;
    throw new InstagramConnectionError("expired");
  }

  try {
    const saved = await saveRefreshedInstagramConnection(
      refreshed,
      fresh.accessToken,
      now,
    );
    if (saved) return refreshed.accessToken;
    // El UPDATE condicionado no aplicó: la conexión cambió entretanto (reautorización, u
    // otra renovación que ya ganó la carrera de guardado). No se pisa nada: se relee y
    // se sirve lo que haya.
    const changed = await getInstagramConnection();
    if (!changed) throw new InstagramConnectionError("missing_token");
    return changed.accessToken;
  } catch (err) {
    // Meta ya emitió el token nuevo, pero no se pudo guardar: la renovación NO se da por
    // completada y el token nuevo se descarta (nunca se devuelve como fuente persistida
    // definitiva). La fila anterior sigue intacta —el UPDATE condicionado nunca llegó a
    // aplicar—, y el lease queda tomado (caduca solo a los 30 s).
    logInstagramStorageError("instagram-connection", err);
    if (isStillUsable(fresh, now)) return fresh.accessToken;
    throw err;
  }
}

/**
 * Regla ÚNICA de "el token guardado ya no sirve y hace falta reconectar": caducado o a
 * ≤ 60 s de caducar (Meta no renueva un token ya expirado). La usan tanto el feed
 * (getUsableInstagramAccessToken) como el panel de conexiones (estado reauth_required), para
 * que ambos nunca discrepen. `accessTokenExpiresAt` es el valor ISO absoluto persistido.
 */
export function isInstagramAccessTokenExpired(
  accessTokenExpiresAt: string,
  now: number,
): boolean {
  return Date.parse(accessTokenExpiresAt) - ACCESS_TOKEN_EXPIRY_SKEW_MS <= now;
}

/**
 * Resuelve el access token a partir de una conexión ya validada como no expirada
 * (`getUsableInstagramAccessToken` ya comprobó el margen duro antes de llamar aquí).
 */
async function resolveInstagramAccessToken(
  connection: InstagramConnection,
  now: number,
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  if (!isRenewalDue(connection, now)) return connection.accessToken;

  const renewed = await renewInstagramConnectionUnderLease(connection, now);
  if (renewed !== null) return renewed;

  // No se consiguió el lease: otra petición ya está renovando. Se espera un turno corto
  // (mismo patrón conceptual que TikTok, sin busy-loop) y se relee UNA vez, por si esa
  // renovación ya terminó; si no, se sigue con el token actual mientras siga siendo
  // utilizable.
  await sleep(REFRESH_WAIT_INTERVAL_MS);
  const fresh = await getInstagramConnection();
  if (!fresh) throw new InstagramConnectionError("missing_token");
  if (isStillUsable(fresh, now)) return fresh.accessToken;
  throw new InstagramConnectionError("expired");
}

/**
 * Access token de Instagram listo para llamar a Meta (solo servidor).
 * - Fila de Instagram con más de 60 s de vigencia → su token, renovándolo antes bajo
 *   lease si está a 7 días o menos de expirar (ver `resolveInstagramAccessToken`). Un
 *   fallo de Meta o de Supabase durante esa renovación no impide servir el token actual
 *   mientras siga siendo válido.
 * - Fila con el token caducado o a ≤ 60 s de caducar → `InstagramConnectionError("expired")`
 *   (503), SIN fallback: no se sirve en silencio el token de otra cuenta si ya hay una
 *   conexión guardada, y tampoco se intenta renovar un token que Meta rechazaría igual.
 * - Fila con formato inválido → error 500, tampoco hay fallback.
 * - Sin fila, Supabase sin configurar o error al leerlo (registrado de forma saneada) →
 *   fallback TEMPORAL a INSTAGRAM_ACCESS_TOKEN.
 * - Sin nada de lo anterior → `InstagramConnectionError("missing_token")` (503), o el
 *   error de almacenamiento si fue un fallo de lectura.
 */
export async function getUsableInstagramAccessToken(
  now: number = Date.now(),
  options: { sleep?: (ms: number) => Promise<void> } = {},
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

  if (isInstagramAccessTokenExpired(connection.accessTokenExpiresAt, now)) {
    throw new InstagramConnectionError("expired");
  }

  return resolveInstagramAccessToken(connection, now, options.sleep ?? defaultSleep);
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
