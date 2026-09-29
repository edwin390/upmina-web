import { useInfiniteQuery } from "@tanstack/react-query";
import type { CommunityFeedPage } from "@/types";

// Feed público de /community (Fase 9J-2A). GET /api/content?resource=community-feed&cursor=…, sin
// Authorization (endpoint público): nunca puede devolver una publicación 'hidden' ni una borrada
// (lo garantiza el servidor, no este hook — ver community-feed-handlers.ts).
async function fetchCommunityFeed(cursor: string | null): Promise<CommunityFeedPage> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const res = await fetch(`/api/content/community-feed${query}`);
  if (!res.ok) throw new Error("No se pudo obtener el feed de Comunidad");
  return res.json();
}

export function useCommunityFeed() {
  return useInfiniteQuery({
    queryKey: ["community", "feed"],
    queryFn: ({ pageParam }) => fetchCommunityFeed(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 30_000,
  });
}
