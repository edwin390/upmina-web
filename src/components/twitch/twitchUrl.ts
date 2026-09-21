/** Solo se enlaza a URLs https de twitch.tv (o subdominios como www.twitch.tv). */
export function safeTwitchUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const isTwitch = url.hostname === "twitch.tv" || url.hostname.endsWith(".twitch.tv");
    return url.protocol === "https:" && isTwitch ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * URL del embed oficial de un clip (`clips.twitch.tv/embed`). Twitch exige `parent` con el
 * dominio que lo aloja. `embedUrl` viene de nuestro propio /api/twitch-clips; si no es un
 * https://clips.twitch.tv válido se reconstruye a partir del id del clip. Sin
 * autoplay: el clip carga y el usuario pulsa Play, como en el comportamiento anterior.
 */
export function twitchClipEmbedUrl(
  clip: { id: string; embedUrl: string },
  parent: string,
): string {
  let url: URL;
  try {
    url = new URL(clip.embedUrl);
    if (url.protocol !== "https:" || url.hostname !== "clips.twitch.tv") {
      throw new Error("embed no oficial");
    }
  } catch {
    url = new URL("https://clips.twitch.tv/embed");
    url.searchParams.set("clip", clip.id);
  }
  url.searchParams.set("parent", parent);
  return url.href;
}
