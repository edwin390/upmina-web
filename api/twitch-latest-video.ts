import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TwitchVideoApiItem } from "../src/types/api.js";
import type { TwitchVideo } from "../src/types/index.js";
import { applyThumbnailSize } from "../src/lib/format.js";
import { readProviderJson, sendProviderFailure } from "../src/lib/provider-http.js";
import {
  openSnapshot,
  sendSnapshotHeaders,
} from "../src/lib/public-snapshot-fallback.js";
import { twitchSourceId } from "../src/lib/public-snapshot-resources.js";
import {
  TwitchApiError,
  fetchTwitchHelix,
  getBroadcasterId,
  getTwitchChannel,
  logTwitchError,
  twitchResponseError,
} from "../src/lib/twitch-shared.js";

/**
 * Último VOD de una respuesta de Helix, o `null` si NO hay ninguno. `data: []` es el vacío
 * autoritativo; un `data` que no es un array, o un elemento sin los campos que la API siempre da,
 * es un esquema inesperado (TwitchApiError) y NUNCA se interpreta como "sin video".
 */
function latestVideoOf(body: unknown): TwitchVideoApiItem | null {
  const data = (body as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) {
    throw new TwitchApiError("Twitch videos: respuesta con formato inesperado", 502);
  }
  if (data.length === 0) return null;
  const video: unknown = data[0];
  const item = video as Partial<Record<keyof TwitchVideoApiItem, unknown>> | null;
  if (
    typeof item !== "object" ||
    item === null ||
    typeof item.id !== "string" ||
    typeof item.url !== "string" ||
    typeof item.title !== "string" ||
    typeof item.created_at !== "string" ||
    typeof item.duration !== "string"
  ) {
    throw new TwitchApiError("Twitch videos: respuesta con formato inesperado", 502);
  }
  return video as TwitchVideoApiItem;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  const snapshot = openSnapshot(
    "twitch-latest-video",
    twitchSourceId(getTwitchChannel()),
  );

  try {
    const broadcasterId = await getBroadcasterId();
    const response = await fetchTwitchHelix(
      `videos?user_id=${broadcasterId}&type=archive&first=1`,
    );

    if (!response.ok) {
      throw twitchResponseError(response, "Twitch no pudo consultar el último stream");
    }

    const video = latestVideoOf(
      await readProviderJson<unknown>(response, "Twitch videos"),
    );
    const body: TwitchVideo | null = video && {
      id: video.id,
      url: video.url,
      title: video.title,
      thumbnailUrl: applyThumbnailSize(video.thumbnail_url, 640, 360),
      createdAt: video.created_at,
      duration: video.duration,
    };

    // `null` (sin VOD) es un vacío autoritativo y también sustituye al snapshot anterior.
    await snapshot.save(body);

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    if (!body) return res.status(204).end();
    return res.status(200).json(body);
  } catch (err) {
    logTwitchError("twitch-latest-video", err);
    const stale = await snapshot.fallback(err);
    if (stale) {
      sendSnapshotHeaders(res);
      return stale.value ? res.status(200).json(stale.value) : res.status(204).end();
    }
    return sendProviderFailure(res, err, "No se pudo obtener el último stream de Twitch");
  }
}
