// Helper compartido para las Vercel Functions de Twitch (api/twitch-status.ts,
// api/twitch-clips.ts, api/twitch-latest-video.ts). Vive fuera de `api/` a
// propósito: Vercel despliega cada archivo de `api/` como su propia ruta, y
// este módulo no es un endpoint, solo lógica compartida (token cache,
// resolución del broadcaster, fetch a Helix con reintento de token).
import type { TwitchTokenResponse, TwitchUser } from "../types/api.js";
import {
  ProviderApiError,
  fetchWithTimeout,
  providerErrorFromResponse,
  readProviderJson,
} from "./provider-http.js";

type TwitchConfig = {
  clientId: string;
  clientSecret: string;
  channel: string;
};

// Mismo valor que se usa si TWITCH_CHANNEL no está definida. Vive aquí, en el
// único lugar del backend que construye la config de Twitch.
const DEFAULT_TWITCH_CHANNEL = "upminaa";

export class TwitchApiError extends ProviderApiError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = "TwitchApiError";
  }
}

/**
 * Error clasificado para una respuesta NO exitosa de Twitch (429 con su Retry-After, 5xx u otro
 * rechazo). El mensaje conserva el texto que ya se usaba; nunca lleva la URL ni tokens.
 */
export function twitchResponseError(response: Response, message: string) {
  return providerErrorFromResponse(response, message);
}

let cachedToken: { token: string; expiresAt: number } | null = null;
let cachedBroadcasterId: string | null = null;

async function getTwitchError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? fallback;
  } catch {
    return fallback;
  }
}

export function getTwitchConfig(): TwitchConfig {
  const clientId = process.env.TWITCH_CLIENT_ID?.trim();
  const clientSecret = process.env.TWITCH_CLIENT_SECRET?.trim();
  const channel = process.env.TWITCH_CHANNEL?.trim() || DEFAULT_TWITCH_CHANNEL;

  if (!clientId || !clientSecret) {
    throw new TwitchApiError("Faltan las credenciales de Twitch", 503);
  }

  return { clientId, clientSecret, channel };
}

/** Solo para pruebas: fuerza a olvidar el token y el broadcaster cacheados. */
export function resetTwitchCacheForTests(): void {
  cachedToken = null;
  cachedBroadcasterId = null;
}

function invalidateCachedToken(): void {
  cachedToken = null;
}

export async function getAppAccessToken(forceRefresh = false): Promise<string> {
  const { clientId, clientSecret } = getTwitchConfig();

  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  const response = await fetchWithTimeout(
    "Twitch OAuth",
    "https://id.twitch.tv/oauth2/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
    },
  );

  if (!response.ok) {
    const message = await getTwitchError(response, "Twitch rechazó las credenciales");
    throw twitchResponseError(response, `Twitch OAuth: ${message}`);
  }

  const data = await readProviderJson<TwitchTokenResponse>(response, "Twitch OAuth");
  if (!data.access_token || !data.expires_in) {
    throw new TwitchApiError("Twitch devolvió un token inválido", 502);
  }

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(data.expires_in - 60, 1) * 1000,
  };
  return cachedToken.token;
}

/**
 * Llama a un endpoint de Twitch Helix con el token cacheado. Si Helix
 * responde 401 (token revocado o inválido antes de su expiración natural),
 * invalida el token cacheado, pide uno nuevo y reintenta la misma petición
 * una única vez. Si vuelve a fallar, devuelve esa segunda respuesta tal
 * cual (nunca reintenta en bucle).
 */
export async function fetchTwitchHelix(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const { clientId } = getTwitchConfig();

  const doFetch = (token: string) =>
    fetchWithTimeout("Twitch Helix", `https://api.twitch.tv/helix/${path}`, {
      ...init,
      headers: {
        ...init.headers,
        "Client-Id": clientId,
        Authorization: `Bearer ${token}`,
      },
    });

  const firstToken = await getAppAccessToken();
  const firstResponse = await doFetch(firstToken);
  if (firstResponse.status !== 401) {
    return firstResponse;
  }

  invalidateCachedToken();
  const freshToken = await getAppAccessToken(true);
  return doFetch(freshToken);
}

export async function getBroadcasterId(): Promise<string> {
  if (cachedBroadcasterId) return cachedBroadcasterId;

  const { channel } = getTwitchConfig();
  const response = await fetchTwitchHelix(`users?login=${encodeURIComponent(channel)}`);

  if (!response.ok) {
    const message = await getTwitchError(response, "Twitch no pudo resolver el canal");
    throw twitchResponseError(response, `Twitch usuario: ${message}`);
  }

  const { data } = await readProviderJson<{ data?: TwitchUser[] }>(
    response,
    "Twitch usuario",
  );
  cachedBroadcasterId = data?.[0]?.id ?? null;
  if (!cachedBroadcasterId) {
    throw new TwitchApiError("El canal de Twitch no existe", 404);
  }

  return cachedBroadcasterId;
}
