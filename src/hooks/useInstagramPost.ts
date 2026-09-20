import { queryOptions, useQuery } from "@tanstack/react-query";
import type { InstagramChild, InstagramComments } from "@/types";
import { isDemoMode } from "@/lib/runtime";

// Datos "pesados" de una publicación: se piden solo al abrirla (enabled), no para
// todo el feed.

/** El backend respondió 403: el token no puede leer los comentarios (falta permiso). */
export class InstagramCommentsPermissionError extends Error {
  constructor() {
    super("Sin permiso para leer los comentarios de Instagram");
    this.name = "InstagramCommentsPermissionError";
  }
}

async function fetchChildren(mediaId: string): Promise<InstagramChild[]> {
  if (isDemoMode) return [];

  const res = await fetch(`/api/instagram-media?id=${encodeURIComponent(mediaId)}`);
  if (!res.ok) throw new Error("No se pudo obtener la publicación de Instagram");
  const body = (await res.json()) as { children?: InstagramChild[] };
  return body.children ?? [];
}

async function fetchComments(mediaId: string): Promise<InstagramComments> {
  if (isDemoMode) return { comments: [] };

  const res = await fetch(`/api/instagram-comments?id=${encodeURIComponent(mediaId)}`);
  if (res.status === 403) throw new InstagramCommentsPermissionError();
  if (!res.ok) throw new Error("No se pudieron obtener los comentarios de Instagram");
  return res.json();
}

/** Opciones compartidas para usar el mismo caché al pedir y al precargar los children. */
export const instagramChildrenQuery = (mediaId: string) =>
  queryOptions({
    queryKey: ["instagram", "children", mediaId],
    queryFn: () => fetchChildren(mediaId),
    staleTime: 15 * 60_000,
    retry: 1,
  });

export function useInstagramChildren(mediaId: string, enabled: boolean) {
  return useQuery({ ...instagramChildrenQuery(mediaId), enabled });
}

export function useInstagramComments(mediaId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["instagram", "comments", mediaId],
    queryFn: () => fetchComments(mediaId),
    enabled,
    staleTime: 5 * 60_000,
    // Un 403 no se arregla reintentando: falta un permiso en Meta.
    retry: (failureCount, error) =>
      !(error instanceof InstagramCommentsPermissionError) && failureCount < 1,
  });
}
