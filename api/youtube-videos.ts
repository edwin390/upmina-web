import type { VercelRequest, VercelResponse } from "@vercel/node";
import { parseIsoDuration } from "../src/lib/format.js";
import type { YouTubePlaylistResponse, YouTubeVideosResponse } from "../src/types/api.js";
import {
  fetchYouTube,
  getUploadsPlaylistId,
  logYouTubeError,
  youTubeErrorStatus,
} from "../src/lib/youtube-shared.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const maxResults = Math.min(Number(req.query.maxResults) || 12, 50);

  try {
    const uploadsPlaylistId = await getUploadsPlaylistId();

    const itemsData = await fetchYouTube<YouTubePlaylistResponse>(
      "playlistItems",
      "playlistItems",
      { part: "snippet", playlistId: uploadsPlaylistId, maxResults: String(maxResults) },
    );
    const items = itemsData.items ?? [];

    // Sin videos no hay nada que detallar (y Google rechaza `videos` sin `id`).
    if (items.length === 0) {
      res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=1800");
      return res.status(200).json([]);
    }

    const videoIds = items.map((item) => item.snippet.resourceId.videoId).join(",");

    const videosData = await fetchYouTube<YouTubeVideosResponse>("videos", "videos", {
      part: "contentDetails",
      id: videoIds,
    });
    const durationById = new Map<string, string>(
      (videosData.items ?? []).map((video) => [video.id, video.contentDetails.duration]),
    );

    const videos = items.map((item) => {
      const id = item.snippet.resourceId.videoId;
      return {
        id,
        title: item.snippet.title,
        description: item.snippet.description,
        thumbnailUrl:
          item.snippet.thumbnails?.high?.url ?? item.snippet.thumbnails?.default?.url,
        publishedAt: item.snippet.publishedAt,
        duration: parseIsoDuration(durationById.get(id) ?? "PT0S"),
      };
    });

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=1800");
    return res.status(200).json(videos);
  } catch (err) {
    logYouTubeError("youtube-videos", err);
    return res
      .status(youTubeErrorStatus(err))
      .json({ error: "No se pudieron obtener los videos de YouTube" });
  }
}
