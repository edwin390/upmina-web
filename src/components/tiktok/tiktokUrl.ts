/** Solo se enlaza a URLs https de tiktok.com (o subdominios como vm.tiktok.com). */
export function safeTikTokUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const isTikTok =
      url.hostname === "tiktok.com" || url.hostname.endsWith(".tiktok.com");
    return url.protocol === "https:" && isTikTok ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Id numérico de un vídeo a partir de su `share_url` (`https://www.tiktok.com/@user/video/<id>`).
 * Es el mismo dato que ya usaba react-social-media-embed (`data-video-id`). Los enlaces cortos
 * (vm.tiktok.com/…) no lo contienen: se devuelve `undefined` y el visor solo muestra la portada.
 */
export function tikTokVideoId(embedUrl: string): string | undefined {
  const safe = safeTikTokUrl(embedUrl);
  if (!safe) return undefined;
  return new URL(safe).pathname.match(/^\/@[^/]+\/video\/(\d+)\/?$/)?.[1];
}

/**
 * Reproductor oficial de TikTok (Embed Player): un iframe alojado por TikTok que solo
 * necesita el id del vídeo. `autoplay=1` (parámetro documentado): el reproductor SOLO se monta tras
 * un gesto explícito (abrir el visor o navegar en él), así que ese gesto es la intención de
 * reproducir. El navegador/TikTok siguen mandando: si bloquean el autoplay con sonido, el
 * reproductor muestra su propio Play. No se fuerza `muted` (desactivaría el control de volumen).
 * Sin vídeos relacionados ni descripción/música superpuestas.
 */
export function tikTokPlayerUrl(videoId: string): string {
  return `https://www.tiktok.com/player/v1/${encodeURIComponent(videoId)}?music_info=0&description=0&rel=0&autoplay=1`;
}
