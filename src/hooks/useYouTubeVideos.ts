import { useQuery } from "@tanstack/react-query";
import type { YouTubeVideo } from "@/types";
import { isDemoMode } from "@/lib/runtime";

/** `videos` = solo videos normales, `shorts` = solo Shorts, sin valor = los más recientes sin clasificar. */
export type YouTubeVideoType = "videos" | "shorts";

// Cuántos elementos pide cada lista. Vive aquí para que /youtube y Home usen EXACTAMENTE la misma
// URL (misma queryKey y misma caché de navegador y CDN). Shorts: 24 (9H-2.5) en lugar de 12 porque
// con este canal cuesta lo mismo (una página de 50 uploads = 2 unidades de cuota) y un visor con
// 12 miniaturas queda visualmente vacío en escritorio.
export const YOUTUBE_VIDEOS_LIMIT = 12;
export const YOUTUBE_SHORTS_LIMIT = 24;

async function fetchYouTubeVideos(
  maxResults = 12,
  type?: YouTubeVideoType,
): Promise<YouTubeVideo[]> {
  if (isDemoMode) return [];

  const typeParam = type ? `&type=${type}` : "";
  const res = await fetch(`/api/youtube-videos?maxResults=${maxResults}${typeParam}`);
  if (!res.ok) throw new Error("No se pudieron obtener los videos de YouTube");
  return res.json();
}

async function fetchLatestYouTubeVideo(): Promise<YouTubeVideo | null> {
  if (isDemoMode) return null;

  const res = await fetch("/api/youtube-latest");
  // 404 "Sin videos": el canal no tiene subidas. Es un vacío legítimo, no un fallo.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("No se pudo obtener el último video de YouTube");
  return res.json();
}

export function useYouTubeVideos(maxResults = 12, type?: YouTubeVideoType) {
  return useQuery({
    queryKey: ["youtube", "videos", maxResults, type ?? "all"],
    queryFn: () => fetchYouTubeVideos(maxResults, type),
    staleTime: 15 * 60_000,
  });
}

export function useLatestYouTubeVideo() {
  return useQuery({
    queryKey: ["youtube", "latest"],
    queryFn: fetchLatestYouTubeVideo,
    staleTime: 15 * 60_000,
  });
}
