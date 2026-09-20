import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TwitchVideoApiItem } from "../src/types/api.js";
import { applyThumbnailSize } from "../src/lib/format.js";
import {
  fetchTwitchHelix,
  getBroadcasterId,
  TwitchApiError,
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
      throw new TwitchApiError("Twitch no pudo consultar el último stream", 502);
    }

    const { data } = (await response.json()) as { data?: TwitchVideoApiItem[] };
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
    console.error("[twitch-latest-video]", err);
    const status = err instanceof TwitchApiError ? err.status : 502;
    return res
      .status(status)
      .json({ error: "No se pudo obtener el último stream de Twitch" });
  }
}
