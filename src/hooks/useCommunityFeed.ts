import { useInfiniteQuery } from "@tanstack/react-query";
import type { CommunityFeedPage } from "@/types";

// Feed público de /community (Fase 9J-2A, ampliado en 9J-2C con `mode`). GET
// /api/content?resource=community-feed&mode=&cursor=…, sin Authorization (endpoint público): nunca
// puede devolver una publicación 'hidden' ni una borrada (lo garantiza el servidor, no este hook —
// ver community-feed-handlers.ts).
export type CommunityFeedMode = "recent" | "popular";

async function fetchCommunityFeed(
  mode: CommunityFeedMode,
  cursor: string | null,
): Promise<CommunityFeedPage> {
  const params = new URLSearchParams({ mode });
  if (cursor) params.set("cursor", cursor);
  const res = await fetch(`/api/content/community-feed?${params.toString()}`);
  if (!res.ok) throw new Error("No se pudo obtener el feed de Comunidad");
  return res.json();
}

export function useCommunityFeed(mode: CommunityFeedMode = "recent") {
  return useInfiniteQuery({
    queryKey: ["community", "feed", mode],
    queryFn: ({ pageParam }) => fetchCommunityFeed(mode, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 30_000,
  });
}
