// Helper compartido para las Vercel Functions de YouTube (api/youtube-latest.ts
// y api/youtube-videos.ts). Vive fuera de `api/` por la misma razón que
// twitch-shared.ts: cada archivo de `api/` se despliega como una ruta pública.
//
// Regla de seguridad: la API key va en la query string de Google, así que
// nunca se registra ni se devuelve una URL, un mensaje de Google ni el error
// original de `fetch`. Solo se registran la operación, el status HTTP y el
// `reason` de Google, este último filtrado a un formato seguro.
import type { YouTubeChannelResponse } from "../types/api.js";

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

type YouTubeConfig = {
  apiKey: string;
  channelId: string;
};

export class YouTubeApiError extends Error {
  constructor(
    message: string,
    /** Status HTTP con el que responde la función (no el de Google). */
    readonly status: number,
  ) {
    super(message);
    this.name = "YouTubeApiError";
  }
}

export function getYouTubeConfig(): YouTubeConfig {
  const apiKey = process.env.YOUTUBE_API_KEY?.trim();
  const channelId = process.env.YOUTUBE_CHANNEL_ID?.trim();

  if (!apiKey || !channelId) {
    const missing = [
      !apiKey && "YOUTUBE_API_KEY",
      !channelId && "YOUTUBE_CHANNEL_ID",
    ].filter(Boolean);
    throw new YouTubeApiError(
      `Faltan variables de entorno de YouTube: ${missing.join(", ")}`,
      503,
    );
  }

  return { apiKey, channelId };
}

// Google devuelve `{ error: { status, errors: [{ reason }] } }`. Solo se acepta
// un identificador corto (p. ej. "keyInvalid", "quotaExceeded", "forbidden"):
// cualquier otra cosa se descarta para no filtrar texto arbitrario a los logs.
async function getGoogleReason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { status?: unknown; errors?: Array<{ reason?: unknown }> };
    };
    const reason = body.error?.errors?.[0]?.reason ?? body.error?.status;
    return typeof reason === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(reason)
      ? reason
      : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * GET a la YouTube Data API v3. Añade la API key, comprueba `response.ok` y,
 * si Google falla, lanza un YouTubeApiError (502) con operación, status y
 * reason de Google, sin la URL ni el mensaje original.
 */
export async function fetchYouTube<T>(
  operation: string,
  endpoint: string,
  params: Record<string, string>,
): Promise<T> {
  const { apiKey } = getYouTubeConfig();

  const url = new URL(`${YOUTUBE_API_BASE}/${endpoint}`);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  url.searchParams.set("key", apiKey);

  let response: Response;
  try {
    response = await fetch(url.toString());
  } catch {
    // El error original de fetch puede arrastrar la URL (con la key).
    throw new YouTubeApiError(`YouTube ${operation}: error de red`, 502);
  }

  if (!response.ok) {
    const reason = await getGoogleReason(response);
    throw new YouTubeApiError(
      `YouTube ${operation}: HTTP ${response.status} (${reason})`,
      502,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new YouTubeApiError(`YouTube ${operation}: respuesta no válida`, 502);
  }
}

/** Resuelve la playlist de subidas del canal configurado. */
export async function getUploadsPlaylistId(): Promise<string> {
  const { channelId } = getYouTubeConfig();
  const data = await fetchYouTube<YouTubeChannelResponse>("channels", "channels", {
    part: "contentDetails",
    id: channelId,
  });

  const uploadsPlaylistId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    throw new YouTubeApiError("YouTube channels: canal no encontrado", 502);
  }
  return uploadsPlaylistId;
}

export function logYouTubeError(scope: string, err: unknown): void {
  if (err instanceof YouTubeApiError) {
    console.error(`[${scope}] ${err.message}`);
  } else if (err instanceof Error) {
    console.error(`[${scope}] error inesperado: ${err.name}: ${err.message}`);
  } else {
    console.error(`[${scope}] error inesperado`);
  }
}

export function youTubeErrorStatus(err: unknown): number {
  return err instanceof YouTubeApiError ? err.status : 502;
}
