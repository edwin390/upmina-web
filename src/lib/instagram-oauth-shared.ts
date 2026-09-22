import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Infraestructura OAuth de Instagram compartida por api/instagram-auth.ts y
// api/instagram-callback.ts. Vive en src/lib por la misma razón que tiktok-shared.ts:
// Vercel despliega cada archivo de api/ como una ruta. Solo se ejecuta en servidor: lee
// INSTAGRAM_APP_SECRET.
//
// Flujo: Instagram API CON Instagram Login (Business Login) — NO Instagram API with
// Facebook Login, NO Instagram Basic Display API (deprecada). Endpoints, parámetros y
// forma de las respuestas verificados contra la documentación oficial de Meta
// (developers.facebook.com/docs/instagram-platform) el 2026-09-21:
//   - autorización:        https://www.instagram.com/oauth/authorize
//   - code -> short-lived: https://api.instagram.com/oauth/access_token (POST), respuesta
//                           envuelta en `data[0]` con access_token/user_id/permissions.
//   - short -> long-lived: https://graph.instagram.com/access_token (GET,
//                           grant_type=ig_exchange_token), respuesta plana con
//                           access_token/token_type/expires_in.
// Scopes vigentes desde la migración de enero 2025 (instagram_basic /
// instagram_manage_comments quedaron deprecados): instagram_business_basic,
// instagram_business_manage_comments. Son los mismos dos permisos que ya usa
// instagram-shared.ts con el token manual.
//
// Regla de seguridad: access_token / authorization code / client_secret nunca se
// registran, se devuelven ni se incluyen en mensajes de error.

export const INSTAGRAM_AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
export const INSTAGRAM_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
export const INSTAGRAM_GRAPH_TOKEN_URL = "https://graph.instagram.com/access_token";
// long-lived -> long-lived (renovación): GET, grant_type=ig_refresh_token, respuesta
// plana con access_token/token_type/expires_in (mismo formato que el intercambio a
// long-lived, endpoint distinto). NO es el mismo grant_type que ig_exchange_token: no
// debe confundirse con exchangeForLongLivedToken. Meta exige que el token a renovar
// tenga al menos 24 h de antigüedad y no esté ya expirado.
export const INSTAGRAM_REFRESH_URL = "https://graph.instagram.com/refresh_access_token";

/** Redirect URI registrada en la app de Meta; debe coincidir exactamente y NUNCA derivarse
 *  del Host de la petición (evita que Preview genere un redirect_uri distinto). */
export const INSTAGRAM_REDIRECT_URI =
  "https://upmina-web.vercel.app/api/instagram-callback";

/** Únicos scopes solicitados. */
export const INSTAGRAM_OAUTH_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_comments",
] as const;

/** Los Instagram-scoped user id son numéricos. */
export const INSTAGRAM_PROVIDER_USER_ID_FORMAT = /^\d{1,32}$/;

export const INSTAGRAM_STATE_COOKIE = "instagram_oauth_state";
/** Vigencia del `state` (y de su cookie): tiempo razonable para autorizar en Instagram. */
export const INSTAGRAM_STATE_TTL_MS = 10 * 60_000;

const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

export class InstagramOAuthError extends Error {
  constructor(
    message: string,
    /** Status HTTP con el que responde la función. */
    readonly status: number,
    /** Status HTTP de Instagram, si lo hubo. */
    readonly httpStatus?: number,
    /** `error_type` de Instagram, si tiene forma de código (ver `safeCode`). */
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = "InstagramOAuthError";
  }
}

export interface InstagramOAuthCredentials {
  appId: string;
  appSecret: string;
}

/** Lee las credenciales de la app de Meta; 503 si falta alguna. */
export function getInstagramOAuthCredentials(): InstagramOAuthCredentials {
  const appId = process.env.INSTAGRAM_APP_ID?.trim();
  const appSecret = process.env.INSTAGRAM_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new InstagramOAuthError("Faltan INSTAGRAM_APP_ID o INSTAGRAM_APP_SECRET", 503);
  }
  return { appId, appSecret };
}

/** Solo deja pasar códigos con forma de identificador (p. ej. `access_denied`). */
export function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9_.-]{1,64}$/i.test(value)
    ? value
    : undefined;
}

// ---------- Production only ----------
//
// Preview y Production comparten el mismo proyecto Supabase: un OAuth de prueba en
// Preview podría sobreescribir la conexión de Instagram de Production. `VERCEL_ENV` lo
// inyecta Vercel automáticamente (no se define en .env); combinado con el
// INSTAGRAM_REDIRECT_URI fijo de arriba, ninguna petición desde Preview puede completar
// un OAuth real ni tocar Supabase.

export function isProductionEnvironment(): boolean {
  return process.env.VERCEL_ENV === "production";
}

// ---------- state (anti-CSRF) ----------
//
// state = <nonce>.<expiraMs>.<firma HMAC-SHA256>. El mismo nonce viaja en una cookie
// HttpOnly, así que un `state` solo es válido en el navegador que inició el flujo
// (cookie) y solo si lo emitió este servidor (firma), sin guardar nada en servidor.
//
// Esto NO hace que `state` sea de un solo uso por sí mismo (nada impide reenviar la
// misma petición de callback con el mismo state+cookie mientras no haya expirado). La
// garantía real de que un callback repetido no produce una segunda escritura válida la
// da el authorization code de Instagram, que Meta invalida tras el primer intercambio
// (ver exchangeInstagramCode). La cookie sí se borra en cualquier desenlace del
// callback (éxito o error) para no dejarla reutilizable innecesariamente.

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`instagram-oauth-state:${payload}`)
    .digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface InstagramState {
  /** Valor para el parámetro `state` de Instagram. */
  state: string;
  /** Valor de la cookie HttpOnly que lo acompaña. */
  nonce: string;
}

export function createInstagramState(secret: string, now = Date.now()): InstagramState {
  const nonce = randomBytes(24).toString("base64url");
  const payload = `${nonce}.${now + INSTAGRAM_STATE_TTL_MS}`;
  return { state: `${payload}.${sign(payload, secret)}`, nonce };
}

/** Resultado de un `state` válido: lo necesario para reclamar el nonce una sola vez
 *  (ver claimInstagramOAuthNonce en instagram-connection.ts). */
export interface VerifiedInstagramState {
  nonce: string;
  /** Momento (ms epoch) en el que expira el `state`, tal como se firmó. */
  expiresAt: number;
}

/**
 * Valida firma, vigencia y que el nonce coincida con el de la cookie. Devuelve `null`
 * si el `state` no es válido por cualquier motivo (falsy, así que `if (!verifyInstagramState(...))`
 * sigue funcionando igual que antes de exponer el resultado).
 *
 * Esto NO garantiza que el `state` sea de un solo uso: solo confirma que lo emitió este
 * servidor y que no ha expirado. El consumo de un solo uso real lo hace
 * claimInstagramOAuthNonce con el `nonce`/`expiresAt` que devuelve esta función.
 */
export function verifyInstagramState(
  state: unknown,
  cookieNonce: string | undefined,
  secret: string,
  now = Date.now(),
): VerifiedInstagramState | null {
  if (typeof state !== "string" || !cookieNonce) return null;
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [nonce, expires, signature] = parts;
  if (!safeEqual(nonce, cookieNonce)) return null;
  if (!safeEqual(signature, sign(`${nonce}.${expires}`, secret))) return null;
  const expiresAt = Number(expires);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return { nonce, expiresAt };
}

function cookieAttrs(maxAgeSeconds: number): string {
  // Path limitado al callback: el navegador no la envía a otras rutas.
  return `Path=/api/instagram-callback; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function stateCookie(nonce: string): string {
  return `${INSTAGRAM_STATE_COOKIE}=${nonce}; ${cookieAttrs(INSTAGRAM_STATE_TTL_MS / 1000)}`;
}

export function clearStateCookie(): string {
  return `${INSTAGRAM_STATE_COOKIE}=; ${cookieAttrs(0)}`;
}

export function readStateCookie(cookieHeader: string | undefined): string | undefined {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === INSTAGRAM_STATE_COOKIE) return rest.join("=") || undefined;
  }
  return undefined;
}

// ---------- URL de autorización ----------

export function buildInstagramAuthorizeUrl(appId: string, state: string): string {
  const url = new URL(INSTAGRAM_AUTHORIZE_URL);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", INSTAGRAM_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", INSTAGRAM_OAUTH_SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

// ---------- intercambio code -> short-lived token ----------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Objeto plano: no null, no array. Usado para no aceptar arrays/null como fuente de campos. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// AbortSignal.timeout rechaza con un DOMException "TimeoutError".
const isTimeout = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  (err as { name?: unknown }).name === "TimeoutError";

interface InstagramProviderErrorBody {
  error_type?: unknown;
  error_message?: unknown;
}

/** Tokens de Instagram ya validados. SOLO para código servidor: nunca se serializan a una
 *  respuesta, log o mensaje de error. */
export interface InstagramShortLivedToken {
  accessToken: string;
  /** Instagram-scoped user id de la cuenta autorizada (ver INSTAGRAM_PROVIDER_USER_ID_FORMAT). */
  providerUserId: string;
  /** Permisos que Instagram concedió realmente (pueden ser menos que los solicitados). */
  permissions: string;
}

/**
 * POST a api.instagram.com/oauth/access_token. La documentación de Instagram Login
 * describe la respuesta envuelta en `data[0]`; también se acepta la forma plana
 * (`access_token`/`user_id`/`permissions` en la raíz) por si la API la devuelve así en la
 * práctica — Production rechazó una respuesta HTTP 200 real con el parser que solo
 * aceptaba `data[0]`, y no hay forma de confirmar cuál usa sin repetir el OAuth. Ambas
 * formas pasan por la misma validación estricta (ver más abajo). Valida que el `user_id`
 * recibido tenga forma de Instagram-scoped id: si no puede determinarse una identidad
 * fiable, se lanza y NO se debe persistir nada con esta respuesta.
 */
export async function exchangeInstagramCode(
  code: string,
  { appId, appSecret }: InstagramOAuthCredentials,
): Promise<InstagramShortLivedToken> {
  let res: Response;
  try {
    res = await fetch(INSTAGRAM_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        grant_type: "authorization_code",
        redirect_uri: INSTAGRAM_REDIRECT_URI,
        code,
      }),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // El mensaje original de un fallo de red podría arrastrar datos sensibles: se descarta.
    // Mismo status (502) para timeout que para cualquier otro fallo de red, como ya hace
    // tiktok-shared.ts e instagram-shared.ts: no se distingue el motivo hacia el cliente.
    if (isTimeout(err)) {
      throw new InstagramOAuthError(
        "Tiempo de espera agotado al contactar con Instagram",
        502,
      );
    }
    throw new InstagramOAuthError("No se pudo contactar con Instagram", 502);
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // Cuerpo no JSON: se trata como respuesta inválida más abajo.
  }

  const providerError = body as InstagramProviderErrorBody;
  const errorMessage = isNonEmptyString(providerError.error_message)
    ? providerError.error_message
    : undefined;
  if (!res.ok || errorMessage) {
    throw new InstagramOAuthError(
      "Instagram rechazó el intercambio del código",
      502,
      res.status,
      safeCode(providerError.error_type),
    );
  }

  // La documentación vigente describe la respuesta envuelta en `data[0]`; no puede
  // descartarse que en la práctica llegue como objeto plano en la raíz (no hay forma de
  // confirmarlo sin repetir el OAuth). Se aceptan ambas formas, pero de manera estricta:
  // si `data` está presente, es la ÚNICA fuente válida —sin caer a la raíz aunque esté
  // vacío o su primer elemento no sirva—; la raíz solo se usa cuando `data` no existe en
  // absoluto. Así el soporte de compatibilidad no relaja ninguna validación existente.
  const entry: Record<string, unknown> | undefined = Object.prototype.hasOwnProperty.call(
    body,
    "data",
  )
    ? Array.isArray(body.data) && isPlainObject(body.data[0])
      ? (body.data[0] as Record<string, unknown>)
      : undefined
    : isPlainObject(body)
      ? body
      : undefined;
  const accessToken = entry?.access_token;
  const rawUserId = entry?.user_id;
  const permissions = entry?.permissions;

  // Meta documenta user_id como string en esta respuesta. Si llegara como number JSON se
  // acepta igual (con el riesgo de precisión ya conocido para enteros > 2^53), pero el
  // formato se valida estrictamente a continuación: si no son solo dígitos, no hay
  // identidad fiable y no se debe persistir nada con este resultado.
  const providerUserId =
    typeof rawUserId === "string"
      ? rawUserId
      : typeof rawUserId === "number"
        ? String(rawUserId)
        : "";

  if (
    !isNonEmptyString(accessToken) ||
    !INSTAGRAM_PROVIDER_USER_ID_FORMAT.test(providerUserId)
  ) {
    throw new InstagramOAuthError(
      "Instagram devolvió una respuesta de token inválida",
      502,
      res.status,
    );
  }

  return {
    accessToken,
    providerUserId,
    permissions: typeof permissions === "string" ? permissions : "",
  };
}

// ---------- intercambio short-lived -> long-lived token ----------

export interface InstagramLongLivedToken {
  accessToken: string;
  /** Segundos de vida del token largo desde su emisión (~60 días documentados por Meta). */
  expiresIn: number;
}

/**
 * GET a graph.instagram.com/access_token (grant_type=ig_exchange_token). Requiere
 * client_secret, así que solo puede ejecutarse en servidor.
 */
export async function exchangeForLongLivedToken(
  shortLivedToken: string,
  { appSecret }: InstagramOAuthCredentials,
): Promise<InstagramLongLivedToken> {
  const url = new URL(INSTAGRAM_GRAPH_TOKEN_URL);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("access_token", shortLivedToken);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // El error original podría arrastrar la URL (con el token corto): se descarta.
    if (isTimeout(err)) {
      throw new InstagramOAuthError(
        "Tiempo de espera agotado al contactar con Instagram",
        502,
      );
    }
    throw new InstagramOAuthError("No se pudo contactar con Instagram", 502);
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // Cuerpo no JSON: se trata como respuesta inválida más abajo.
  }

  if (!res.ok) {
    const providerError = body as InstagramProviderErrorBody;
    throw new InstagramOAuthError(
      "Instagram rechazó la conversión a token de larga duración",
      502,
      res.status,
      safeCode(providerError.error_type),
    );
  }

  const { access_token, expires_in } = body;
  if (!isNonEmptyString(access_token) || !isPositiveNumber(expires_in)) {
    throw new InstagramOAuthError(
      "Instagram devolvió un token de larga duración inválido",
      502,
      res.status,
    );
  }

  return { accessToken: access_token, expiresIn: expires_in };
}

// ---------- renovación del token largo (auto-refresh) ----------

/** Token renovado. SOLO para código servidor: nunca se serializa a una respuesta, log o
 *  mensaje de error. */
export interface InstagramRefreshedToken {
  accessToken: string;
  /** Segundos de vida del token renovado, desde este momento. */
  expiresIn: number;
}

/**
 * GET a graph.instagram.com/refresh_access_token (grant_type=ig_refresh_token). Renueva
 * el propio access token largo de Instagram ANTES de que expire: a diferencia de TikTok,
 * no hay un refresh token separado, así que es el propio access token vigente el que
 * autoriza su renovación (no requiere client_secret ni ninguna otra credencial de la
 * app). Misma disciplina de timeout/validación estricta/errores saneados que
 * `exchangeForLongLivedToken`; no se asume que la respuesta real coincida exactamente
 * con la documentación (ver el comentario sobre `exchangeInstagramCode` más arriba).
 */
export async function refreshInstagramAccessToken(
  accessToken: string,
): Promise<InstagramRefreshedToken> {
  const url = new URL(INSTAGRAM_REFRESH_URL);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", accessToken);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // El error original podría arrastrar la URL (con el token): se descarta.
    if (isTimeout(err)) {
      throw new InstagramOAuthError(
        "Tiempo de espera agotado al renovar el token de Instagram",
        502,
      );
    }
    throw new InstagramOAuthError("No se pudo contactar con Instagram", 502);
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // Cuerpo no JSON: se trata como respuesta inválida más abajo.
  }

  if (!res.ok) {
    const providerError = body as InstagramProviderErrorBody;
    throw new InstagramOAuthError(
      "Instagram rechazó la renovación del token",
      502,
      res.status,
      safeCode(providerError.error_type),
    );
  }

  const { access_token, expires_in } = body;
  if (!isNonEmptyString(access_token) || !isPositiveNumber(expires_in)) {
    throw new InstagramOAuthError(
      "Instagram devolvió una respuesta de renovación inválida",
      502,
      res.status,
    );
  }

  return { accessToken: access_token, expiresIn: expires_in };
}

// ---------- logs y respuestas seguras ----------

/** Registra solo mensaje genérico, status HTTP y código del proveedor (nunca cuerpos). */
export function logInstagramOAuthError(handler: string, err: unknown): void {
  if (!(err instanceof InstagramOAuthError)) {
    console.error(`[${handler}] error inesperado`);
    return;
  }
  const extra = [
    err.httpStatus !== undefined ? `http=${err.httpStatus}` : "",
    err.providerCode ? `code=${err.providerCode}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  console.error(`[${handler}] ${err.message}${extra ? ` (${extra})` : ""}`);
}

export function instagramOAuthErrorStatus(err: unknown): number {
  return err instanceof InstagramOAuthError ? err.status : 502;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Página HTML mínima y estática (sin datos del proveedor ni del usuario). */
export function renderInstagramPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · UPMINAA</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b12;color:#f4f4f8;font-family:system-ui,sans-serif}
main{max-width:28rem;padding:2rem;text-align:center}
a{color:#7dd3fc}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/">Volver al inicio</a></p>
</main>
</body>
</html>
`;
}

/** Cabeceras comunes de las respuestas HTML del flujo OAuth. */
export const INSTAGRAM_PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
};
