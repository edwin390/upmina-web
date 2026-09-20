import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getRecentUploads,
  getRecentUploadsByKind,
  getUploadsPlaylistId,
  logYouTubeError,
  youTubeErrorStatus,
  type YouTubeVideoKind,
} from "../src/lib/youtube-shared.js";

// `?type=videos` → solo videos normales, `?type=shorts` → solo Shorts. Sin `type`
// se devuelven los uploads más recientes sin clasificar (contrato original).
const KIND_BY_TYPE = new Map<string, YouTubeVideoKind>([
  ["videos", "video"],
  ["shorts", "short"],
]);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const maxResults = Math.min(Number(req.query.maxResults) || 12, 50);

  const type = req.query.type;
  const kind = typeof type === "string" ? KIND_BY_TYPE.get(type) : undefined;
  if (type !== undefined && !kind) {
    return res.status(400).json({ error: "Parámetro type no válido" });
  }

  try {
    const uploadsPlaylistId = await getUploadsPlaylistId();

    const videos = kind
      ? await getRecentUploadsByKind(uploadsPlaylistId, kind, maxResults)
      : await getRecentUploads(uploadsPlaylistId, maxResults);

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=1800");
    return res.status(200).json(videos);
  } catch (err) {
    logYouTubeError("youtube-videos", err);
    return res
      .status(youTubeErrorStatus(err))
      .json({ error: "No se pudieron obtener los videos de YouTube" });
  }
}
