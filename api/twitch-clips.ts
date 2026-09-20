import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getBroadcasterId, TwitchApiError } from "../src/lib/twitch-shared.js";
import { getRecentClips } from "../src/lib/twitch-clips.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    const broadcasterId = await getBroadcasterId();

    // Los 12 clips más recientes (createdAt DESC). Helix ordena por vistas, así
    // que el orden se resuelve en getRecentClips; ver ese módulo.
    const recentClips = await getRecentClips(broadcasterId);
    const clips = recentClips.map((clip) => ({
      id: clip.id,
      url: clip.url,
      title: clip.title ?? "",
      creatorName: clip.creator_name ?? "",
      embedUrl: `https://clips.twitch.tv/embed?clip=${clip.id}`,
      thumbnailUrl: clip.thumbnail_url ?? "",
      viewCount: clip.view_count ?? 0,
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
