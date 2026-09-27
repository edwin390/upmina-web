import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createDeadline, sendProviderFailure } from "../src/lib/provider-http.js";
import {
  openSnapshot,
  sendSnapshotHeaders,
} from "../src/lib/public-snapshot-fallback.js";
import { SNAPSHOT_OPERATION_TIMEOUT_MS } from "../src/lib/public-snapshots.js";
import { twitchSourceId } from "../src/lib/public-snapshot-resources.js";
import {
  getBroadcasterId,
  getTwitchChannel,
  logTwitchError,
} from "../src/lib/twitch-shared.js";
import { TWITCH_CLIPS_DEADLINE_MS, getRecentClips } from "../src/lib/twitch-clips.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  // Lectura del último snapshot bueno EN PARALELO con el proveedor (ver public-snapshot-fallback).
  const snapshot = openSnapshot("twitch-clips", twitchSourceId(getTwitchChannel()));

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

    // Solo una lista COMPLETA es el último estado bueno: una parcial (el proveedor falló a mitad)
    // se sirve fresca pero NO sustituye al snapshot completo. Si queda menos plazo que lo que puede
    // tardar la escritura no se intenta: un snapshot no debe convertir un éxito en un 504.
    // `[]` completo es un vacío autoritativo y también se guarda (un clip borrado no resucita).
    if (!incomplete && deadline.remainingMs() >= SNAPSHOT_OPERATION_TIMEOUT_MS) {
      await snapshot.save(clips);
    }

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
    const stale = await snapshot.fallback(err);
    if (stale) {
      sendSnapshotHeaders(res);
      return res.status(200).json(stale.value);
    }
    return sendProviderFailure(res, err, "No se pudieron obtener los clips de Twitch");
  }
}
