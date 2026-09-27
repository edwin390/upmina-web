import { useQuery } from "@tanstack/react-query";
import type { CosplayPostDetail } from "@/types";
import { isDemoMode } from "@/lib/runtime";
import { findCosplayFixtureBySlug } from "@/lib/cosplay-fixtures";

/** `null` = no encontrado (404 público: no existe o es un borrador — el servidor nunca distingue
 *  los dos casos, ver cosplay-handlers.ts). NUNCA `undefined`: TanStack Query v5 no admite
 *  `undefined` como dato de una query (lo trata como "sin resultado", y `isSuccess` no llega a
 *  ser true), igual que ya hace fetchTwitchLatestVideo/fetchLatestYouTubeVideo en este proyecto.
 *  Un error de red/servidor lanza en su lugar, para que la UI pueda distinguir "no existe" de
 *  "no se pudo cargar". */
async function fetchCosplayPost(slug: string): Promise<CosplayPostDetail | null> {
  // Mismo flag global que useCosplayList (ver su comentario): en demo se sirven los fixtures
  // ricos en vez de `null`, para poder revisar la página de detalle sin datos reales.
  if (isDemoMode) return findCosplayFixtureBySlug(slug);

  const res = await fetch(`/api/content/cosplay-post?slug=${encodeURIComponent(slug)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("No se pudo obtener la publicación de Cosplay");
  return res.json();
}

export function useCosplayPost(slug: string | undefined) {
  return useQuery({
    queryKey: ["cosplay", "post", slug],
    queryFn: () => fetchCosplayPost(slug as string),
    enabled: Boolean(slug),
    staleTime: 60_000,
  });
}
