import { useInfiniteQuery } from "@tanstack/react-query";
import type { CosplayPostListPage } from "@/types";
import { isDemoMode } from "@/lib/runtime";
import { COSPLAY_FIXTURE_LIST } from "@/lib/cosplay-fixtures";

// Listado paginado de /cosplay (Fase 9I-1). GET /api/content/cosplay-list?cursor=…, sin
// Authorization (endpoint público): nunca puede devolver un borrador (lo garantiza el servidor,
// no este hook — ver cosplay-handlers.ts).
//
// DIVERGE del resto de hooks con isDemoMode (useTwitchClips, useInstagramFeed, etc., que
// devuelven `[]` para no simular ningún dato): aquí, en demo, se devuelven los FIXTURES ricos de
// cosplay-fixtures.ts. Es intencional, no un descuido — Cosplay es un dominio nuevo sin datos
// reales en Production todavía, así que un `[]` en modo demo no permitiría revisar el layout
// (hero, tarjetas, traducciones, galería…) antes de que exista contenido real. El resto de
// integraciones ya tienen datos reales en Production; Cosplay, en 9I-1, no. El disparo sigue
// siendo el MISMO flag global (VITE_DEMO_MODE): no se introduce un segundo mecanismo de demo.
async function fetchCosplayList(cursor: string | null): Promise<CosplayPostListPage> {
  if (isDemoMode) return { items: COSPLAY_FIXTURE_LIST, nextCursor: null };

  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const res = await fetch(`/api/content/cosplay-list${query}`);
  if (!res.ok) throw new Error("No se pudieron obtener las publicaciones de Cosplay");
  return res.json();
}

export function useCosplayList() {
  return useInfiniteQuery({
    queryKey: ["cosplay", "list"],
    queryFn: ({ pageParam }) => fetchCosplayList(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 60_000,
  });
}
