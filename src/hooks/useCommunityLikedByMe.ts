import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { fetchCommunityLikedByMe } from "@/lib/community-client";

// Estado de "¿dio like el usuario ACTUAL?" para un lote de publicaciones (Fase 9J-2C). Separado a
// propósito de los datos públicos (feed/perfil/detalle, que solo traen likeCount): esos endpoints
// llevan Cache-Control público y son IDÉNTICOS para cualquier visitante — mezclar ahí el estado de
// un usuario concreto arriesgaría que un CDN sirva el "me gusta" de una persona a otra. Este hook
// combina, en el cliente, likeCount (público) con likedByMe (privado, de esta llamada aparte).
//
// Sin sesión: siempre {} (visitante, nunca se consulta el backend — coincide con "likedByMe =
// false/unavailable" del checkpoint). postIds vacío: tampoco consulta.

export function useCommunityLikedByMe(postIds: string[]) {
  const { session, loading } = useAuth();
  const hasSession = Boolean(session);
  // Clave estable independiente del orden de llegada (evita refetch cuando solo cambia el orden).
  const sortedIds = [...new Set(postIds)].sort();
  const key = sortedIds.join(",");

  const query = useQuery<Set<string>>({
    queryKey: ["community", "liked-by-me", key],
    queryFn: async () => {
      const { likedPostIds } = await fetchCommunityLikedByMe(sortedIds);
      return new Set(likedPostIds);
    },
    enabled: !loading && hasSession && sortedIds.length > 0,
    staleTime: 15_000,
  });

  return {
    likedByMe: hasSession ? (query.data ?? null) : new Set<string>(),
    isLoading: hasSession && query.isLoading,
  };
}
