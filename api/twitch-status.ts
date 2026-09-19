import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TwitchStream } from "../src/types/api.js";
import { getAppAccessToken, getTwitchClientId, TwitchApiError } from "./twitch.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    const token = await getAppAccessToken();
    const clientId = getTwitchClientId();
    const channel = process.env.TWITCH_CHANNEL?.trim() || "upminaa";

    const streamRes = await fetch(
      `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(channel)}`,
      {
        headers: {
          "Client-Id": clientId,
          Authorization: `Bearer ${token}`,
        },
      },
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
      return res.status(200).json({ isLive: false });
    }

    return res.status(200).json({
      isLive: true,
      title: stream.title,
      viewerCount: stream.viewer_count,
      thumbnailUrl: stream.thumbnail_url
        .replace("{width}", "440")
        .replace("{height}", "248"),
      startedAt: stream.started_at,
    });
  } catch (err) {
    console.error("[twitch-status]", err);
    const status = err instanceof TwitchApiError ? err.status : 502;
    return res.status(status).json({ error: "No se pudo obtener el estado de Twitch" });
  }
}
