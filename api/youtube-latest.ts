import type { VercelRequest, VercelResponse } from "@vercel/node";
import { parseIsoDuration } from "../src/lib/format.js";
import type { YouTubePlaylistResponse, YouTubeVideosResponse } from "../src/types/api.js";
import { sendProviderFailure } from "../src/lib/provider-http.js";
import {
  openSnapshot,
  sendSnapshotHeaders,
} from "../src/lib/public-snapshot-fallback.js";
import {
  fetchYouTube,
  getUploadsPlaylistId,
  logYouTubeError,
  requireItems,
  youtubeSnapshotSourceId,
} from "../src/lib/youtube-shared.js";
import type { YouTubeVideo } from "../src/types/index.js";

type PlaylistItem = NonNullable<YouTubePlaylistResponse["items"]>[number];
type VideoDetails = NonNullable<YouTubeVideosResponse["items"]>[number];

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const snapshot = openSnapshot("youtube-latest", youtubeSnapshotSourceId());

  try {
    const uploadsPlaylistId = await getUploadsPlaylistId();

    const itemsData = await fetchYouTube<YouTubePlaylistResponse>(
      "playlistItems",
      "playlistItems",
      { part: "snippet", playlistId: uploadsPlaylistId, maxResults: "1" },
    );
    const latest = requireItems<PlaylistItem>(itemsData, "playlistItems")[0];
    if (!latest) {
      // Vacío AUTORITATIVO: sustituye al snapshot anterior (no debe resucitar un video borrado).
      await snapshot.save(null);
      return res.status(404).json({ error: "Sin videos" });
    }

    const videoId = latest.snippet.resourceId.videoId;

    const videoData = await fetchYouTube<YouTubeVideosResponse>("videos", "videos", {
      part: "contentDetails",
      id: videoId,
    });
    const isoDuration =
      requireItems<VideoDetails>(videoData, "videos")[0]?.contentDetails?.duration ??
      "PT0S";

    const body = {
      id: videoId,
      title: latest.snippet.title,
      description: latest.snippet.description,
      thumbnailUrl:
        latest.snippet.thumbnails?.high?.url ?? latest.snippet.thumbnails?.default?.url,
      publishedAt: latest.snippet.publishedAt,
      duration: parseIsoDuration(isoDuration),
    };
    // El validador del snapshot reconstruye el valor (una miniatura ausente queda ausente).
    await snapshot.save(body as YouTubeVideo);

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=1800");
    return res.status(200).json(body);
  } catch (err) {
    logYouTubeError("youtube-latest", err);
    const stale = await snapshot.fallback(err);
    if (stale) {
      sendSnapshotHeaders(res);
      return stale.value
        ? res.status(200).json(stale.value)
        : res.status(404).json({ error: "Sin videos" });
    }
    return sendProviderFailure(res, err, "No se pudo obtener el último video de YouTube");
  }
}
