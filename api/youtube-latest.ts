import type { VercelRequest, VercelResponse } from "@vercel/node";
import { parseIsoDuration } from "../src/lib/format.js";
import type { YouTubePlaylistResponse, YouTubeVideosResponse } from "../src/types/api.js";
import {
  fetchYouTube,
  getUploadsPlaylistId,
  logYouTubeError,
  youTubeErrorStatus,
} from "../src/lib/youtube-shared.js";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const uploadsPlaylistId = await getUploadsPlaylistId();

    const itemsData = await fetchYouTube<YouTubePlaylistResponse>(
      "playlistItems",
      "playlistItems",
      { part: "snippet", playlistId: uploadsPlaylistId, maxResults: "1" },
    );
    const latest = itemsData.items?.[0];
    if (!latest) return res.status(404).json({ error: "Sin videos" });

    const videoId = latest.snippet.resourceId.videoId;

    const videoData = await fetchYouTube<YouTubeVideosResponse>("videos", "videos", {
      part: "contentDetails",
      id: videoId,
    });
    const isoDuration = videoData.items?.[0]?.contentDetails?.duration ?? "PT0S";

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=1800");
    return res.status(200).json({
      id: videoId,
      title: latest.snippet.title,
      description: latest.snippet.description,
      thumbnailUrl:
        latest.snippet.thumbnails?.high?.url ?? latest.snippet.thumbnails?.default?.url,
      publishedAt: latest.snippet.publishedAt,
      duration: parseIsoDuration(isoDuration),
    });
  } catch (err) {
    logYouTubeError("youtube-latest", err);
    return res
      .status(youTubeErrorStatus(err))
      .json({ error: "No se pudo obtener el último video de YouTube" });
  }
}
