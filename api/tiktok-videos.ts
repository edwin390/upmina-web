import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TikTokApiVideo } from "../src/types/api.js";
import type { TikTokVideo } from "../src/types/index.js";
import {
  TikTokConnectionError,
  TikTokStorageError,
  getUsableTikTokAccessToken,
  logTikTokStorageError,
} from "../src/lib/tiktok-connection.js";
import {
  TikTokOAuthError,
  logTikTokError,
  safeCode,
  tikTokErrorStatus,
} from "../src/lib/tiktok-shared.js";

const VIDEO_LIST_URL =
  "https://open.tiktokapis.com/v2/video/list/?fields=id,title,cover_image_url,share_url,create_time";
const REQUEST_TIMEOUT_MS = 10_000;
const ERROR_MESSAGE = "No se pudieron obtener los videos de TikTok";

function isHttps(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("https://");
}

function normalizeVideo(video: Partial<TikTokApiVideo>): TikTokVideo | null {
  if (
    typeof video.id !== "string" ||
    !video.id ||
    !isHttps(video.share_url) ||
    !isHttps(video.cover_image_url) ||
    typeof video.create_time !== "number"
  ) {
    return null;
  }
  return {
    id: video.id,
    title: typeof video.title === "string" ? video.title : "",
    embedUrl: video.share_url,
    coverImageUrl: video.cover_image_url,
    createTime: new Date(video.create_time * 1000).toISOString(),
  };
}

/** Videos recientes de la cuenta autorizada, usando el access token guardado en Supabase. */
async function fetchTikTokVideos(accessToken: string): Promise<TikTokVideo[]> {
  let res: Response;
  try {
    res = await fetch(VIDEO_LIST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ max_count: 12 }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // El mensaje de un fallo de red podría incluir cabeceras: se descarta.
    throw new TikTokOAuthError("No se pudo contactar con TikTok", 502);
  }

  let body: { data?: { videos?: unknown }; error?: { code?: unknown } } = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") body = parsed as typeof body;
  } catch {
    // Cuerpo no JSON: se trata como error del proveedor.
  }

  // TikTok v2 responde `{ data, error: { code: "ok" | ... } }`.
  const errorCode = typeof body.error?.code === "string" ? body.error.code : undefined;
  if (!res.ok || (errorCode !== undefined && errorCode !== "ok")) {
    throw new TikTokOAuthError(
      "TikTok rechazó la lista de videos",
      502,
      res.status,
      safeCode(errorCode),
    );
  }

  const videos = Array.isArray(body.data?.videos) ? body.data.videos : [];
  return (videos as Partial<TikTokApiVideo>[])
    .map(normalizeVideo)
    .filter((video): video is TikTokVideo => video !== null);
}

// Feed de TikTok. El access token sale SOLO de la conexión guardada en Supabase (tabla
// social_connections, escrita por /api/tiktok-callback); no hay fallback a variables de
// entorno. Si caducó (o le quedan <60 s) se refresca antes, con lease atómico en Supabase.
// Nunca se devuelve ni registra un token.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    const accessToken = await getUsableTikTokAccessToken();
    const videos = await fetchTikTokVideos(accessToken);

    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    return res.status(200).json(videos);
  } catch (err) {
    let status = 502;
    if (err instanceof TikTokConnectionError) {
      // Distinguible en logs (missing / refresh_token_expired / reauthorization_required /
      // refresh_in_progress); el cliente solo recibe el mensaje genérico.
      console.error(`[tiktok-videos] ${err.message} (reason=${err.reason})`);
      status = err.status;
    } else if (err instanceof TikTokStorageError) {
      logTikTokStorageError("tiktok-videos", err);
      status = err.status;
    } else {
      logTikTokError("tiktok-videos", err);
      status = tikTokErrorStatus(err);
    }
    return res.status(status).json({ error: ERROR_MESSAGE });
  }
}
