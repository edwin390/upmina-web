/** URL del reproductor de un Short: solo youtube.com/embed con un id validado; nunca una URL arbitraria. */
export function shortEmbedUrl(id: string): string {
  return `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&rel=0`;
}
