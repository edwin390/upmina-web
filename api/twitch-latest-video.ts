import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TwitchVideoApiItem } from "../src/types/api.js";
import {
  getAppAccessToken,
  getBroadcasterId,
  getTwitchClientId,
  TwitchApiError,
} from "./twitch.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    const token = await getAppAccessToken();
    const broadcasterId = await getBroadcasterId(token);
    const response = await fetch(
      `https://api.twitch.tv/helix/videos?user_id=${broadcasterId}&type=archive&first=1`,
      {
        headers: {
          "Client-Id": getTwitchClientId(),
          Authorization: `Bearer ${token}`,
        },
      },
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
      title: video.title,
      thumbnailUrl: video.thumbnail_url
        .replace("%{width}", "640")
        .replace("%{height}", "360"),
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
