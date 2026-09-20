import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TwitchStream } from "../src/types/api.js";
import { applyThumbnailSize } from "../src/lib/format.js";
import {
  fetchTwitchHelix,
  getTwitchConfig,
  TwitchApiError,
} from "../src/lib/twitch-shared.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    const { channel } = getTwitchConfig();

    const streamRes = await fetchTwitchHelix(
      `streams?user_login=${encodeURIComponent(channel)}`,
    );

    if (!streamRes.ok) {
      const body = (await streamRes.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new TwitchApiError(
        `Twitch streams: ${body?.message ?? streamRes.statusText}`,
        502,
      );
    }

    const { data } = (await streamRes.json()) as { data?: TwitchStream[] };
    const stream = data?.[0];

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");

    if (!stream) {
      return res.status(200).json({ isLive: false, channel });
    }

    return res.status(200).json({
      isLive: true,
      channel,
      title: stream.title,
      viewerCount: stream.viewer_count,
      thumbnailUrl: applyThumbnailSize(stream.thumbnail_url, 440, 248),
      startedAt: stream.started_at,
    });
  } catch (err) {
    console.error("[twitch-status]", err);
    const status = err instanceof TwitchApiError ? err.status : 502;
    return res.status(status).json({ error: "No se pudo obtener el estado de Twitch" });
  }
}
