import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createDeadline, sendProviderFailure } from "../src/lib/provider-http.js";
import { getBroadcasterId, logTwitchError } from "../src/lib/twitch-shared.js";
import { TWITCH_CLIPS_DEADLINE_MS, getRecentClips } from "../src/lib/twitch-clips.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    // Un único plazo para todo: token, resolución del canal y ventanas de clips.
    const deadline = createDeadline(TWITCH_CLIPS_DEADLINE_MS);
    const broadcasterId = await getBroadcasterId(deadline);

    // Los 12 clips más recientes (createdAt DESC). Helix ordena por vistas, así
    // que el orden se resuelve en getRecentClips; ver ese módulo.
    let incomplete = false;
    const recentClips = await getRecentClips(broadcasterId, new Date(), {
      deadline,
      onIncomplete: (error) => {
        incomplete = true;
        logTwitchError("twitch-clips", error);
      },
    });
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

    // Una lista incompleta (el proveedor falló a mitad) se cachea poco tiempo para no fijar 5 min
    // un resultado parcial; la completa conserva su caché de siempre.
    res.setHeader(
      "Cache-Control",
      incomplete
        ? "s-maxage=60, stale-while-revalidate=120"
        : "s-maxage=300, stale-while-revalidate=600",
    );
    return res.status(200).json(clips);
  } catch (err) {
    logTwitchError("twitch-clips", err);
    return sendProviderFailure(res, err, "No se pudieron obtener los clips de Twitch");
  }
}
