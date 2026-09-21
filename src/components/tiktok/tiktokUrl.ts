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
 * necesita el id del vídeo. Sin autoplay (el usuario pulsa Play), sin vídeos relacionados
 * ni descripción/música superpuestas.
 */
export function tikTokPlayerUrl(videoId: string): string {
  return `https://www.tiktok.com/player/v1/${encodeURIComponent(videoId)}?music_info=0&description=0&rel=0&autoplay=0`;
}
