import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { useEffect, useRef } from "react";
import type { AuthorPost } from "@/lib/community-author-contract";
import { listOwnCommunityPosts } from "@/lib/community-client";

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
  const { user, session, loading } = useAuth();
  const deadlineRef = useRef<number | null>(null);

  const query = useQuery<AuthorPost[]>({
    queryKey: [...OWN_COMMUNITY_POSTS_QUERY_KEY, user?.id],
    queryFn: async () => {
      const started = performance.now();
      const { items, serverNow } = await listOwnCommunityPosts();
      const deadlines = items
        .map((p) => p.moderation?.deadline)
        .filter((x): x is string => Boolean(x));
      deadlineRef.current =
        serverNow && deadlines.length
          ? performance.now() +
            Math.max(
              0,
              Math.min(...deadlines.map((d) => Date.parse(d))) -
                Date.parse(serverNow) -
                (performance.now() - started),
            )
          : null;
      return items;
    },
    enabled: enabled && !loading && Boolean(user && session),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  // Deadline display cleanup is a one-shot authoritative re-read, never a browser access grant.
  useEffect(() => {
    if (deadlineRef.current === null) return;
    // Server already filters expiry. A fresh read on focus/mount and at the next deadline avoids stale tiles.
    const ms = Math.max(0, deadlineRef.current - performance.now());
    const timer = setTimeout(
      () => {
        deadlineRef.current = null;
        queryClient.setQueryData<AuthorPost[]>(
          [...OWN_COMMUNITY_POSTS_QUERY_KEY, user?.id],
          (items) => items?.filter((p) => p.status !== "removed_pending_purge"),
        );
        void queryClient.invalidateQueries({ queryKey: OWN_COMMUNITY_POSTS_QUERY_KEY });
      },
      Math.min(ms, 2147483647),
    );
    return () => clearTimeout(timer);
  }, [query.data, queryClient, user?.id]);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: OWN_COMMUNITY_POSTS_QUERY_KEY });

  return {
    ...query,
    data: enabled && Boolean(user && session) ? query.data : undefined,
    invalidate,
  };
}
