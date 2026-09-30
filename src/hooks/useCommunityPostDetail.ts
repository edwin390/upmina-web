import { useQuery } from "@tanstack/react-query";
import type { CommunityFeedPost } from "@/types";

// Detalle público de UNA publicación de Comunidad (Fase 9J-2B.1). GET
// /api/content/community-post-detail?postId=, sin Authorization (endpoint público). Mismo patrón
// "404 → null, distinto de un error de red/servidor" que useCosplayPost.ts/useCommunityProfile.ts:
// la UI necesita distinguir "esta publicación no existe/no es pública" de "no se pudo cargar".
async function fetchCommunityPostDetail(
  postId: string,
): Promise<CommunityFeedPost | null> {
  const res = await fetch(
    `/api/content/community-post-detail?postId=${encodeURIComponent(postId)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("No se pudo obtener la publicación");
  const body = (await res.json()) as { post: CommunityFeedPost };
  return body.post;
}

export function useCommunityPostDetail(postId: string | undefined) {
  return useQuery({
    queryKey: ["community", "post-detail", postId],
    queryFn: () => fetchCommunityPostDetail(postId as string),
    enabled: Boolean(postId),
    staleTime: 30_000,
  });
}
