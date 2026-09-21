// Deep links de contenido desde Home: /youtube?video=<id> y /twitch?clip=<id>. La URL es la única
// fuente de verdad de la selección; aquí solo se validan los ids y se construyen las rutas.

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const TWITCH_CLIP_ID = /^[A-Za-z0-9_-]{1,100}$/;

export const CONTENT_UNAVAILABLE_MESSAGE =
  "Este contenido ya no está disponible entre los más recientes.";

export function isYouTubeVideoId(value: unknown): value is string {
  return typeof value === "string" && YOUTUBE_VIDEO_ID.test(value);
}

export function isTwitchClipId(value: unknown): value is string {
  return typeof value === "string" && TWITCH_CLIP_ID.test(value);
}

/** `/youtube?video=<id>`; sin id válido, la ruta normal (nunca `undefined` ni `null` en la URL). */
export function youTubeVideoPath(id: string | null | undefined): string {
  return isYouTubeVideoId(id) ? `/youtube?video=${id}` : "/youtube";
}

/** `/twitch?clip=<id>`; sin id válido, la ruta normal. */
export function twitchClipPath(id: string | null | undefined): string {
  return isTwitchClipId(id) ? `/twitch?clip=${id}` : "/twitch";
}
