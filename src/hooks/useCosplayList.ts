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
// `cacheBust` (Fase 9I-3, ajuste posterior): el endpoint responde con
// `Cache-Control: public, s-maxage=60` (ver cosplay-handlers.ts) para que la Edge Network de
// Vercel sirva el listado desde CDN — deliberado, y NO se toca aquí. El problema es que esa
// caché es POR URL: un refetch disparado justo después de publicar pide la MISMA URL y, dentro de
// esos 60s, recibe la MISMA respuesta cacheada sin la publicación nueva, aunque
// invalidateQueries/refetch de TanStack Query funcionen perfectamente en el cliente (por eso
// "recargar la página" tampoco ayudaba si se hacía antes de que expirara la caché de CDN). Cuando
// `cacheBust` es un entero > 0 (CosplaySection lo incrementa tras onPostChanged), se añade como
// query param SOLO en ese momento: la URL cambia, la CDN la trata como un recurso nunca visto
// (cache MISS garantizado) y el origin server responde con datos frescos de Postgres. Con
// `cacheBust` en 0 (uso normal, sin publicar nada) la URL es idéntica a antes — cero cambio de
// comportamiento de caché para la navegación normal.
async function fetchCosplayList(
  cursor: string | null,
  cacheBust: number,
): Promise<CosplayPostListPage> {
  if (isDemoMode) return { items: COSPLAY_FIXTURE_LIST, nextCursor: null };

  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (cacheBust > 0) params.set("_r", String(cacheBust));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const res = await fetch(`/api/content/cosplay-list${query}`);
  if (!res.ok) throw new Error("No se pudieron obtener las publicaciones de Cosplay");
  return res.json();
}

/** `cacheBust`: pásalo desde un contador que solo cambia cuando de verdad hace falta forzar un
 *  MISS de CDN (justo después de publicar/borrar/editar desde el editor ADMIN) — ver el
 *  comentario de fetchCosplayList. En 0 (valor por defecto) el hook se comporta exactamente igual
 *  que antes. */
export function useCosplayList(cacheBust = 0) {
  return useInfiniteQuery({
    queryKey: ["cosplay", "list", cacheBust],
    queryFn: ({ pageParam }) => fetchCosplayList(pageParam, cacheBust),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 60_000,
  });
}
