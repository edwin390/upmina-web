import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TwitchStream } from "../src/types/api.js";
import { applyThumbnailSize } from "../src/lib/format.js";
import { readProviderJson, sendProviderFailure } from "../src/lib/provider-http.js";
import {
  fetchTwitchHelix,
  getTwitchConfig,
  twitchResponseError,
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
      throw twitchResponseError(
        streamRes,
        `Twitch streams: ${body?.message ?? streamRes.statusText}`,
      );
    }

    const { data } = await readProviderJson<{ data?: TwitchStream[] }>(
      streamRes,
      "Twitch streams",
    );
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
    return sendProviderFailure(res, err, "No se pudo obtener el estado de Twitch");
  }
}
