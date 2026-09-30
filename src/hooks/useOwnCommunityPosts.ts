import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listOwnCommunityPosts, type CommunityOwnPost } from "@/lib/community-client";

// Publicaciones PROPIAS de Comunidad (Fase 9J-2B.1), vía TanStack Query — mismo cliente
// (listOwnCommunityPosts) que ya usa CommunityPostsSection.tsx en /account, nunca una segunda
// implementación. Se usa en el perfil público /@username SOLO cuando el visitante es el propio
// dueño del perfil (ver ProfilePage.tsx): a diferencia del feed público paginado, esta lista
// autenticada ya trae `version` por publicación (necesaria para las mutaciones de dueño —
// editar/borrar — con concurrencia optimista) y no necesita re-normalizar una segunda vez desde
// el contrato público sin privilegios.

export const OWN_COMMUNITY_POSTS_QUERY_KEY = ["community", "own-posts"] as const;

export function useOwnCommunityPosts(enabled: boolean) {
  const queryClient = useQueryClient();

  const query = useQuery<CommunityOwnPost[]>({
    queryKey: OWN_COMMUNITY_POSTS_QUERY_KEY,
    queryFn: async () => {
      const { items } = await listOwnCommunityPosts();
      return Array.isArray(items) ? items : [];
    },
    enabled,
    staleTime: 15_000,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: OWN_COMMUNITY_POSTS_QUERY_KEY });

  return { ...query, invalidate };
}
