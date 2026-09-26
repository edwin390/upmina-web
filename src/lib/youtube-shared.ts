// Helper compartido para las Vercel Functions de YouTube (api/youtube-latest.ts
// y api/youtube-videos.ts). Vive fuera de `api/` por la misma razón que
// twitch-shared.ts: cada archivo de `api/` se despliega como una ruta pública.
//
// Regla de seguridad: la API key va en la query string de Google, así que
// nunca se registra ni se devuelve una URL, un mensaje de Google ni el error
// original de `fetch`. Solo se registran la operación, el status HTTP y el
// `reason` de Google, este último filtrado a un formato seguro.
import { parseIsoDuration } from "./format.js";
import {
  ProviderApiError,
  fetchWithTimeout,
  providerErrorFromResponse,
  readProviderJson,
} from "./provider-http.js";
import type {
  YouTubeChannelResponse,
  YouTubePlaylistResponse,
  YouTubeVideosResponse,
} from "../types/api.js";

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

type YouTubeConfig = {
  apiKey: string;
  channelId: string;
};

export class YouTubeApiError extends ProviderApiError {
  constructor(
    message: string,
    /** Status HTTP con el que responde la función (no el de Google). */
    status: number,
  ) {
    super(message, status);
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
 * GET a la YouTube Data API v3. Añade la API key, aplica un timeout real (fetchWithTimeout),
 * comprueba `response.ok` y, si Google falla, lanza un ProviderRequestError clasificado
 * (timeout 504, 429, 5xx/otros 502) con operación, status y reason de Google, sin la URL ni el
 * mensaje original.
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

  // fetchWithTimeout nunca propaga el error original de fetch (arrastra la URL con la key).
  const response = await fetchWithTimeout(`YouTube ${operation}`, url.toString());

  if (!response.ok) {
    const reason = await getGoogleReason(response);
    throw providerErrorFromResponse(
      response,
      `YouTube ${operation}: HTTP ${response.status} (${reason})`,
    );
  }

  return readProviderJson<T>(response, `YouTube ${operation}`);
}

// ---------- Playlist de subidas: caché en memoria ----------

/**
 * TTL de la playlist de subidas resuelta. El id de esa playlist de un canal no cambia (es
 * derivable del id del canal); 6 h solo acota cuánto sobrevive una entrada errónea si Google
 * alguna vez devolviera otra cosa. Evita 1 unidad de cuota (llamada a `channels`) por petición.
 */
export const UPLOADS_PLAYLIST_TTL_MS = 6 * 60 * 60 * 1000;

/** Forma de un id de playlist de YouTube: solo caracteres de id, longitud acotada. */
const PLAYLIST_ID_FORMAT = /^[A-Za-z0-9_-]{2,64}$/;

// La aplicación sirve UN canal configurado (YOUTUBE_CHANNEL_ID), así que basta UNA entrada: la
// caché queda acotada por construcción (no hay Map que crezca) y va ligada al id del canal para que
// un cambio de configuración nunca reutilice la de otro. Vive en la memoria del lambda: un arranque
// en frío la vacía y se comporta exactamente como antes (una llamada a `channels`).
let uploadsCache: { channelId: string; playlistId: string; expiresAt: number } | null =
  null;
// Una sola resolución en vuelo por canal: las peticiones simultáneas de una instancia en frío
// comparten la llamada en lugar de gastar una unidad de cuota cada una.
let uploadsInflight: { channelId: string; promise: Promise<string> } | null = null;

/** Solo para pruebas: olvida la playlist cacheada y la resolución en vuelo. */
export function resetYouTubeCacheForTests(): void {
  uploadsCache = null;
  uploadsInflight = null;
}

async function resolveUploadsPlaylistId(channelId: string): Promise<string> {
  const data = await fetchYouTube<YouTubeChannelResponse>("channels", "channels", {
    part: "contentDetails",
    id: channelId,
  });

  const uploadsPlaylistId: unknown =
    data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (
    typeof uploadsPlaylistId !== "string" ||
    !PLAYLIST_ID_FORMAT.test(uploadsPlaylistId)
  ) {
    throw new YouTubeApiError("YouTube channels: canal no encontrado", 502);
  }
  return uploadsPlaylistId;
}

/**
 * Resuelve la playlist de subidas del canal configurado. Solo se cachea un id VALIDADO tras una
 * respuesta correcta: un fallo (timeout, 429, 5xx, cuerpo inválido, canal inexistente o id
 * malformado) nunca se guarda ni sustituye una entrada válida vigente.
 */
export async function getUploadsPlaylistId(): Promise<string> {
  // La configuración se comprueba SIEMPRE primero: sin credenciales no se sirve ni la caché.
  const { channelId } = getYouTubeConfig();

  if (
    uploadsCache &&
    uploadsCache.channelId === channelId &&
    uploadsCache.expiresAt > Date.now()
  ) {
    return uploadsCache.playlistId;
  }
  if (uploadsInflight?.channelId === channelId) return uploadsInflight.promise;

  const promise = (async () => {
    try {
      const playlistId = await resolveUploadsPlaylistId(channelId);
      uploadsCache = {
        channelId,
        playlistId,
        expiresAt: Date.now() + UPLOADS_PLAYLIST_TTL_MS,
      };
      return playlistId;
    } finally {
      // Solo puede haber una resolución en vuelo por canal (arriba se reutiliza), así que esta es la nuestra.
      if (uploadsInflight?.channelId === channelId) uploadsInflight = null;
    }
  })();
  uploadsInflight = { channelId, promise };
  return promise;
}

// ---------- Videos normales vs. Shorts ----------

export type YouTubeVideoKind = "video" | "short";

/** Video normalizado tal y como lo consume el frontend (contrato existente). */
export interface UploadedVideo {
  id: string;
  title: string;
  description: string;
  thumbnailUrl: string | undefined;
  publishedAt: string;
  duration: string;
}

/** Segundos de una duración ISO 8601 (PT#H#M#S). 0 si no es parseable (p. ej. directos "P0D"). */
export function isoDurationSeconds(iso: string): number {
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  return (
    Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)
  );
}

// LIMITACIÓN: la YouTube Data API v3 no expone si un video es un Short (no hay
// campo oficial y `search.list` no lo distingue). Se usa una heurística con las
// señales que ya obtenemos:
//  - hasta 60 s: Short (el límite original de los Shorts);
//  - de 61 s a 3 min: Short solo si título o descripción llevan #shorts, porque
//    desde oct-2024 los Shorts pueden durar hasta 3 min pero un video horizontal
//    corto también cabe en ese rango;
//  - más de 3 min, o duración 0 (directos/estrenos sin duración): video normal.
// Puede fallar en ambos sentidos (un Short de 61-180 s sin #shorts se cuenta como
// video normal; un video horizontal de <60 s se cuenta como Short).
export const SHORT_MAX_SECONDS = 60;
export const SHORT_MAX_SECONDS_TAGGED = 180;
const SHORTS_TAG = /#shorts\b/i;

export function classifyYouTubeVideo(video: {
  durationSeconds: number;
  title: string;
  description: string;
}): YouTubeVideoKind {
  const { durationSeconds, title, description } = video;
  if (durationSeconds <= 0) return "video";
  if (durationSeconds <= SHORT_MAX_SECONDS) return "short";
  if (
    durationSeconds <= SHORT_MAX_SECONDS_TAGGED &&
    (SHORTS_TAG.test(title) || SHORTS_TAG.test(description))
  ) {
    return "short";
  }
  return "video";
}

// Cotas de la búsqueda por tipo: como máximo MAX_UPLOAD_PAGES páginas de
// UPLOADS_PAGE_SIZE uploads, cada una con 2 llamadas (playlistItems + videos).
// Con la de `channels`, el peor caso son 1 + 2 * MAX_UPLOAD_PAGES = 9 llamadas
// (9 unidades de cuota) por petición; en cuanto hay suficientes se detiene.
export const UPLOADS_PAGE_SIZE = 50;
export const MAX_UPLOAD_PAGES = 4;

type ScannedVideo = UploadedVideo & {
  /** null si videos.list no devolvió detalles (borrado/privado). */
  durationSeconds: number | null;
};

async function fetchUploadsPage(
  playlistId: string,
  pageSize: number,
  pageToken?: string,
): Promise<{ videos: ScannedVideo[]; nextPageToken?: string }> {
  const params: Record<string, string> = {
    part: "snippet",
    playlistId,
    maxResults: String(pageSize),
  };
  if (pageToken) params.pageToken = pageToken;

  const itemsData = await fetchYouTube<YouTubePlaylistResponse>(
    "playlistItems",
    "playlistItems",
    params,
  );
  const items = itemsData.items ?? [];

  // Sin uploads no hay nada que detallar (y Google rechaza `videos` sin `id`).
  if (items.length === 0) return { videos: [], nextPageToken: itemsData.nextPageToken };

  const videosData = await fetchYouTube<YouTubeVideosResponse>("videos", "videos", {
    part: "contentDetails",
    id: items.map((item) => item.snippet.resourceId.videoId).join(","),
  });
  const isoById = new Map<string, string>(
    (videosData.items ?? []).map((video) => [video.id, video.contentDetails.duration]),
  );

  const videos = items.map((item) => {
    const id = item.snippet.resourceId.videoId;
    const iso = isoById.get(id);
    return {
      id,
      title: item.snippet.title,
      description: item.snippet.description,
      thumbnailUrl:
        item.snippet.thumbnails?.high?.url ?? item.snippet.thumbnails?.default?.url,
      publishedAt: item.snippet.publishedAt,
      duration: parseIsoDuration(iso ?? "PT0S"),
      durationSeconds: iso === undefined ? null : isoDurationSeconds(iso),
    };
  });
  return { videos, nextPageToken: itemsData.nextPageToken };
}

/** Uploads más recientes sin clasificar (comportamiento original de /api/youtube-videos). */
export async function getRecentUploads(
  playlistId: string,
  limit: number,
): Promise<UploadedVideo[]> {
  const { videos } = await fetchUploadsPage(playlistId, limit);
  return videos.map(toUploadedVideo);
}

/**
 * Los `limit` uploads más recientes de un tipo, del más nuevo al más antiguo.
 * Recorre los uploads por páginas (máx. MAX_UPLOAD_PAGES) hasta reunir `limit`,
 * de modo que una racha de Shorts no deje vacía la lista de videos normales.
 */
export async function getRecentUploadsByKind(
  playlistId: string,
  kind: YouTubeVideoKind,
  limit: number,
): Promise<UploadedVideo[]> {
  const found: UploadedVideo[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_UPLOAD_PAGES && found.length < limit; page++) {
    const result = await fetchUploadsPage(playlistId, UPLOADS_PAGE_SIZE, pageToken);

    for (const video of result.videos) {
      // Un upload nuevo entre páginas puede desplazar la paginación y repetir ids.
      if (seen.has(video.id)) continue;
      seen.add(video.id);
      if (video.durationSeconds === null) continue;
      if (
        classifyYouTubeVideo({ ...video, durationSeconds: video.durationSeconds }) !==
        kind
      ) {
        continue;
      }
      found.push(toUploadedVideo(video));
    }

    if (!result.nextPageToken) break;
    pageToken = result.nextPageToken;
  }

  return found
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, limit);
}

function toUploadedVideo(video: ScannedVideo): UploadedVideo {
  return {
    id: video.id,
    title: video.title,
    description: video.description,
    thumbnailUrl: video.thumbnailUrl,
    publishedAt: video.publishedAt,
    duration: video.duration,
  };
}

export function logYouTubeError(scope: string, err: unknown): void {
  if (err instanceof ProviderApiError) {
    console.error(`[${scope}] ${err.message}`);
  } else if (err instanceof Error) {
    console.error(`[${scope}] error inesperado: ${err.name}: ${err.message}`);
  } else {
    console.error(`[${scope}] error inesperado`);
  }
}
