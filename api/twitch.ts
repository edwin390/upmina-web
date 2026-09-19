import type { TwitchTokenResponse, TwitchUser } from "../src/types/api.js";

type TwitchConfig = {
  clientId: string;
  clientSecret: string;
  channel: string;
};

export class TwitchApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TwitchApiError";
  }
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

function getTwitchConfig(): TwitchConfig {
  const clientId = process.env.TWITCH_CLIENT_ID?.trim();
  const clientSecret = process.env.TWITCH_CLIENT_SECRET?.trim();
  const channel = process.env.TWITCH_CHANNEL?.trim() || "upminaa";

  if (!clientId || !clientSecret) {
    throw new TwitchApiError("Faltan las credenciales de Twitch", 503);
  }

  return { clientId, clientSecret, channel };
}

export async function getAppAccessToken(): Promise<string> {
  const { clientId, clientSecret } = getTwitchConfig();

  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });

  if (!response.ok) {
    const message = await getTwitchError(response, "Twitch rechazó las credenciales");
    throw new TwitchApiError(`Twitch OAuth: ${message}`, 502);
  }

  const data = (await response.json()) as TwitchTokenResponse;
  if (!data.access_token || !data.expires_in) {
    throw new TwitchApiError("Twitch devolvió un token inválido", 502);
  }

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(data.expires_in - 60, 1) * 1000,
  };
  return cachedToken.token;
}

export async function getBroadcasterId(token: string): Promise<string> {
  const { clientId, channel } = getTwitchConfig();

  if (cachedBroadcasterId) return cachedBroadcasterId;

  const response = await fetch(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(channel)}`,
    {
      headers: {
        "Client-Id": clientId,
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (!response.ok) {
    const message = await getTwitchError(response, "Twitch no pudo resolver el canal");
    throw new TwitchApiError(`Twitch usuario: ${message}`, 502);
  }

  const { data } = (await response.json()) as { data?: TwitchUser[] };
  cachedBroadcasterId = data?.[0]?.id ?? null;
  if (!cachedBroadcasterId) {
    throw new TwitchApiError("El canal de Twitch no existe", 404);
  }

  return cachedBroadcasterId;
}

export function getTwitchClientId(): string {
  return getTwitchConfig().clientId;
}
