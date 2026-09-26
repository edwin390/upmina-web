/**
 * Twitch Embed JS API (`Twitch.Player`, https://dev.twitch.tv/docs/embed/video-and-clips/).
 * Solo se usa para el reproductor PRINCIPAL (directo / VOD): es lo único que permite pedir
 * sonido tras una interacción, porque un iframe simple de player.twitch.tv no expone comandos
 * documentados. Los clips NO admiten esta API (la documentación lo dice expresamente).
 */
export const TWITCH_PLAYER_SCRIPT_URL = "https://player.twitch.tv/js/embed/v1.js";

/** Subconjunto documentado de `Twitch.Player` que usa la aplicación. */
export interface TwitchPlayerInstance {
  play(): void;
  pause(): void;
  setMuted(muted: boolean): void;
  getMuted(): boolean;
  setVolume(level: number): void;
  getVolume(): number;
  addEventListener(event: string, callback: () => void): void;
}

export interface TwitchPlayerOptions {
  width: string | number;
  height: string | number;
  channel?: string;
  video?: string;
  parent: string[];
  autoplay: boolean;
  muted: boolean;
}

export interface TwitchPlayerConstructor {
  new (elementId: string, options: TwitchPlayerOptions): TwitchPlayerInstance;
  readonly READY: string;
}

declare global {
  interface Window {
    Twitch?: { Player?: TwitchPlayerConstructor };
  }
}

/** Si el script no termina de cargar en este tiempo, se usa el iframe simple de siempre. */
export const TWITCH_API_TIMEOUT_MS = 8_000;

let pending: Promise<TwitchPlayerConstructor> | null = null;

/** Carga el script oficial una sola vez (se reintenta en la siguiente petición si falló). */
export function loadTwitchPlayerApi(): Promise<TwitchPlayerConstructor> {
  const ready = window.Twitch?.Player;
  if (ready) return Promise.resolve(ready);
  if (pending) return pending;

  pending = new Promise<TwitchPlayerConstructor>((resolve, reject) => {
    const fail = () => {
      pending = null;
      reject(new Error("Twitch API no disponible"));
    };
    const timer = setTimeout(fail, TWITCH_API_TIMEOUT_MS);
    const script = document.createElement("script");
    script.src = TWITCH_PLAYER_SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      clearTimeout(timer);
      const ctor = window.Twitch?.Player;
      if (ctor) resolve(ctor);
      else fail();
    };
    script.onerror = () => {
      clearTimeout(timer);
      fail();
    };
    document.head.appendChild(script);
  });
  return pending;
}

/** Solo para tests: olvida la carga en curso. */
export function resetTwitchPlayerApiForTests(): void {
  pending = null;
}
