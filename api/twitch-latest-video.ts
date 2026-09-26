import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TwitchVideoApiItem } from "../src/types/api.js";
import { applyThumbnailSize } from "../src/lib/format.js";
import { readProviderJson, sendProviderFailure } from "../src/lib/provider-http.js";
import {
  fetchTwitchHelix,
  getBroadcasterId,
  logTwitchError,
  twitchResponseError,
} from "../src/lib/twitch-shared.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    const broadcasterId = await getBroadcasterId();
    const response = await fetchTwitchHelix(
      `videos?user_id=${broadcasterId}&type=archive&first=1`,
    );

    if (!response.ok) {
      throw twitchResponseError(response, "Twitch no pudo consultar el último stream");
    }

    const { data } = await readProviderJson<{ data?: TwitchVideoApiItem[] }>(
      response,
      "Twitch videos",
    );
    const video = data?.[0];

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    if (!video) return res.status(204).end();

    return res.status(200).json({
      id: video.id,
      url: video.url,
      title: video.title,
      thumbnailUrl: applyThumbnailSize(video.thumbnail_url, 640, 360),
      createdAt: video.created_at,
      duration: video.duration,
    });
  } catch (err) {
    logTwitchError("twitch-latest-video", err);
    return sendProviderFailure(res, err, "No se pudo obtener el último stream de Twitch");
  }
}
