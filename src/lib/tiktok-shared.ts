import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Infraestructura OAuth de TikTok (Login Kit) compartida por api/tiktok-auth.ts y
// api/tiktok-callback.ts. Vive en src/lib porque Vercel despliega cada archivo de api/
// como una ruta. Solo se ejecuta en servidor: lee TIKTOK_CLIENT_SECRET.
//
// Regla de seguridad: access_token / refresh_token / code / client_secret nunca se
// registran, se devuelven ni se incluyen en mensajes de error.

export const TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
export const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";

/** Redirect URI registrada en la app de TikTok; debe coincidir exactamente. */
export const TIKTOK_REDIRECT_URI = "https://upmina-web.vercel.app/api/tiktok-callback";

/** Únicos scopes solicitados. */
export const TIKTOK_SCOPES = ["user.info.basic", "video.list"] as const;

export const TIKTOK_STATE_COOKIE = "tiktok_oauth_state";
/** Vigencia del `state` (y de su cookie): tiempo razonable para autorizar en TikTok. */
export const TIKTOK_STATE_TTL_MS = 10 * 60_000;

const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

export class TikTokOAuthError extends Error {
  constructor(
    message: string,
    /** Status HTTP con el que responde la función. */
    readonly status: number,
    /** Status HTTP de TikTok, si lo hubo. */
    readonly httpStatus?: number,
    /** `error` de TikTok (solo si tiene forma de código, ver `safeCode`). */
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = "TikTokOAuthError";
  }
}

export interface TikTokCredentials {
  clientKey: string;
  clientSecret: string;
}

/** Lee las credenciales de la app; 503 si falta alguna. */
export function getTikTokCredentials(): TikTokCredentials {
  const clientKey = process.env.TIKTOK_CLIENT_KEY?.trim();
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET?.trim();
  if (!clientKey || !clientSecret) {
    throw new TikTokOAuthError("Faltan TIKTOK_CLIENT_KEY o TIKTOK_CLIENT_SECRET", 503);
  }
  return { clientKey, clientSecret };
}

/** Solo deja pasar códigos con forma de identificador (p. ej. `access_denied`). */
export function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9_.-]{1,64}$/i.test(value)
    ? value
    : undefined;
}

// ---------- state (anti-CSRF) ----------
//
// state = <nonce>.<expiraMs>.<firma HMAC-SHA256>. El mismo nonce viaja en una cookie
// HttpOnly, así que un `state` solo es válido en el navegador que inició el flujo
// (cookie) y solo si lo emitió este servidor (firma), sin guardar nada en servidor.

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`tiktok-oauth-state:${payload}`)
    .digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface TikTokState {
  /** Valor para el parámetro `state` de TikTok. */
  state: string;
  /** Valor de la cookie HttpOnly que lo acompaña. */
  nonce: string;
}

export function createTikTokState(secret: string, now = Date.now()): TikTokState {
  const nonce = randomBytes(24).toString("base64url");
  const payload = `${nonce}.${now + TIKTOK_STATE_TTL_MS}`;
  return { state: `${payload}.${sign(payload, secret)}`, nonce };
}

/** Valida firma, vigencia y que el nonce coincida con el de la cookie. */
export function verifyTikTokState(
  state: unknown,
  cookieNonce: string | undefined,
  secret: string,
  now = Date.now(),
): boolean {
  if (typeof state !== "string" || !cookieNonce) return false;
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [nonce, expires, signature] = parts;
  if (!safeEqual(nonce, cookieNonce)) return false;
  if (!safeEqual(signature, sign(`${nonce}.${expires}`, secret))) return false;
  const expiresAt = Number(expires);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function cookieAttrs(maxAgeSeconds: number): string {
  // Path limitado al callback: el navegador no la envía a otras rutas.
  return `Path=/api/tiktok-callback; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function stateCookie(nonce: string): string {
  return `${TIKTOK_STATE_COOKIE}=${nonce}; ${cookieAttrs(TIKTOK_STATE_TTL_MS / 1000)}`;
}

export function clearStateCookie(): string {
  return `${TIKTOK_STATE_COOKIE}=; ${cookieAttrs(0)}`;
}

export function readStateCookie(cookieHeader: string | undefined): string | undefined {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === TIKTOK_STATE_COOKIE) return rest.join("=") || undefined;
  }
  return undefined;
}

// ---------- URL de autorización ----------

export function buildTikTokAuthorizeUrl(clientKey: string, state: string): string {
  const url = new URL(TIKTOK_AUTHORIZE_URL);
  url.searchParams.set("client_key", clientKey);
  url.searchParams.set("scope", TIKTOK_SCOPES.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", TIKTOK_REDIRECT_URI);
  url.searchParams.set("state", state);
  return url.toString();
}

// ---------- intercambio code → tokens ----------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Tokens de TikTok ya validados. SOLO para código servidor: nunca se serializan a una
 * respuesta, log o mensaje de error (ver `saveTikTokConnection`).
 */
export interface TikTokTokenSet {
  accessToken: string;
  refreshToken: string;
  /** `open_id` de la cuenta autorizada. */
  openId: string;
  /** Segundos de vida del access token desde su emisión. */
  expiresIn: number;
  /** Segundos de vida del refresh token desde su emisión. */
  refreshExpiresIn: number;
  scope: string;
}

type TikTokTokenOperation = "exchange" | "refresh";

/**
 * POST al endpoint de token de TikTok y validación estricta de la respuesta: solo se
 * devuelve un token set COMPLETO (nunca se debe persistir una respuesta parcial).
 */
async function requestTikTokTokens(
  operation: TikTokTokenOperation,
  params: Record<string, string>,
  { clientKey, clientSecret }: TikTokCredentials,
): Promise<TikTokTokenSet> {
  let res: Response;
  try {
    res = await fetch(TIKTOK_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache",
      },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        ...params,
      }),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch {
    // El mensaje original de un fallo de red podría contener la URL/cuerpo: se descarta.
    throw new TikTokOAuthError("No se pudo contactar con TikTok", 502);
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // Cuerpo no JSON: se trata como respuesta inválida más abajo.
  }

  // TikTok puede responder 200 con `error` en el cuerpo.
  const providerError = isNonEmptyString(body.error) ? body.error : undefined;
  if (!res.ok || providerError) {
    throw new TikTokOAuthError(
      operation === "refresh"
        ? "TikTok rechazó el refresh de tokens"
        : "TikTok rechazó el intercambio del código",
      502,
      res.status,
      safeCode(providerError),
    );
  }

  const { access_token, refresh_token, open_id, expires_in, refresh_expires_in } = body;
  if (
    !isNonEmptyString(access_token) ||
    !isNonEmptyString(refresh_token) ||
    !isNonEmptyString(open_id) ||
    !isPositiveNumber(expires_in) ||
    !isPositiveNumber(refresh_expires_in)
  ) {
    throw new TikTokOAuthError(
      "TikTok devolvió una respuesta de tokens inválida",
      502,
      res.status,
    );
  }

  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    openId: open_id,
    expiresIn: expires_in,
    refreshExpiresIn: refresh_expires_in,
    scope: typeof body.scope === "string" ? body.scope : "",
  };
}

/**
 * Intercambia el authorization code por tokens y valida que TikTok devolvió
 * credenciales completas.
 */
export function exchangeTikTokCode(
  code: string,
  credentials: TikTokCredentials,
): Promise<TikTokTokenSet> {
  return requestTikTokTokens(
    "exchange",
    { code, grant_type: "authorization_code", redirect_uri: TIKTOK_REDIRECT_URI },
    credentials,
  );
}

/**
 * Renueva los tokens con el refresh token (grant_type=refresh_token). TikTok puede
 * devolver un refresh token NUEVO: quien llame debe persistir siempre el set completo.
 */
export function refreshTikTokTokens(
  refreshToken: string,
  credentials: TikTokCredentials,
): Promise<TikTokTokenSet> {
  return requestTikTokTokens(
    "refresh",
    { grant_type: "refresh_token", refresh_token: refreshToken },
    credentials,
  );
}

// ---------- logs y respuestas seguras ----------

/** Registra solo mensaje genérico, status HTTP y código del proveedor (nunca cuerpos). */
export function logTikTokError(handler: string, err: unknown): void {
  if (!(err instanceof TikTokOAuthError)) {
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

export function tikTokErrorStatus(err: unknown): number {
  return err instanceof TikTokOAuthError ? err.status : 502;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Página HTML mínima y estática (sin datos del proveedor ni del usuario). */
export function renderTikTokPage(title: string, message: string): string {
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
export const TIKTOK_PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
};
