import { useInfiniteQuery } from "@tanstack/react-query";
import type { CommunityProfilePage } from "@/types";

// Perfil público /@username (Fase 9J-2B). GET /api/content/community-profile?username=&cursor=,
// sin Authorization (endpoint público). Mismo patrón "404 → null, distinto de un error de red/
// servidor" que useCosplayPost.ts: la UI necesita distinguir "este perfil no existe" de "no se
// pudo cargar" para mostrar el estado correcto (ver PublicProfilePage.tsx).
async function fetchCommunityProfilePage(
  username: string,
  cursor: string | null,
): Promise<CommunityProfilePage | null> {
  const params = new URLSearchParams({ username });
  if (cursor) params.set("cursor", cursor);
  const res = await fetch(`/api/content/community-profile?${params.toString()}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("No se pudo obtener el perfil de Comunidad");
  return res.json();
}

export function useCommunityProfile(username: string) {
  return useInfiniteQuery({
    queryKey: ["community", "profile", username],
    queryFn: ({ pageParam }) => fetchCommunityProfilePage(username, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage?.posts.nextCursor ?? null,
    enabled: username.length > 0,
    staleTime: 30_000,
  });
}
