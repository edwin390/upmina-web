import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TwitchClipApiItem } from "../src/types/api.js";
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
    const clientId = getTwitchClientId();

    const clipsRes = await fetch(
      `https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}&first=12`,
      {
        headers: {
          "Client-Id": clientId,
          Authorization: `Bearer ${token}`,
        },
      },
    );
    if (!clipsRes.ok) throw new TwitchApiError("Twitch no pudo consultar los clips", 502);

    const { data } = (await clipsRes.json()) as { data?: TwitchClipApiItem[] };
    const clips = (data ?? []).map((clip) => ({
      id: clip.id,
      title: clip.title,
      embedUrl: `https://clips.twitch.tv/embed?clip=${clip.id}`,
      thumbnailUrl: clip.thumbnail_url,
      viewCount: clip.view_count,
      createdAt: clip.created_at,
    }));

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json(clips);
  } catch (err) {
    console.error("[twitch-clips]", err);
    const status = err instanceof TwitchApiError ? err.status : 502;
    return res
      .status(status)
      .json({ error: "No se pudieron obtener los clips de Twitch" });
  }
}
