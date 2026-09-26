/**
 * Protocolo postMessage del Embed Player oficial de TikTok
 * (https://developers.tiktok.com/doc/embed-player). Solo se usan los mensajes documentados.
 * La documentación usa "*" en sus ejemplos y recomienda indicar el origen exacto en producción:
 * aquí siempre se usa el origen concreto del reproductor.
 */
export const TIKTOK_PLAYER_ORIGIN = "https://www.tiktok.com";

/** Comandos documentados host → reproductor que usa la aplicación. */
export type TikTokPlayerCommand = "play" | "unMute";

/** Mensajes documentados reproductor → host. */
const KNOWN_PLAYER_EVENTS = new Set([
  "onPlayerReady",
  "onStateChange",
  "onCurrentTime",
  "onMute",
  "onVolumeChange",
  "onPlayerError",
  "onImageChange",
]);

export interface TikTokPlayerEvent {
  type: string;
  value?: unknown;
}

/**
 * Valida un `message` de window: origen de TikTok, emitido por el iframe ACTUAL, con la marca
 * `x-tiktok-player` y un tipo documentado. Cualquier otra cosa se ignora (no se confía en
 * payloads arbitrarios).
 */
export function readTikTokPlayerEvent(
  event: MessageEvent,
  frame: HTMLIFrameElement | null,
): TikTokPlayerEvent | null {
  if (event.origin !== TIKTOK_PLAYER_ORIGIN) return null;
  if (!frame || !frame.contentWindow || event.source !== frame.contentWindow) return null;
  const data: unknown = event.data;
  if (!data || typeof data !== "object") return null;
  const msg = data as Record<string, unknown>;
  if (msg["x-tiktok-player"] !== true) return null;
  if (typeof msg.type !== "string" || !KNOWN_PLAYER_EVENTS.has(msg.type)) return null;
  return { type: msg.type, value: msg.value };
}

/** Envía un comando documentado al iframe indicado (nunca con destino "*"). */
export function sendTikTokPlayerCommand(
  frame: HTMLIFrameElement | null,
  type: TikTokPlayerCommand,
): void {
  try {
    frame?.contentWindow?.postMessage(
      { type, value: undefined, "x-tiktok-player": true },
      TIKTOK_PLAYER_ORIGIN,
    );
  } catch {
    // El reproductor sigue utilizable con sus propios controles.
  }
}
