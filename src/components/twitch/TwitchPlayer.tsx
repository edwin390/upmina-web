import { useEffect, useId, useRef, useState } from "react";
import { loadTwitchPlayerApi, type TwitchPlayerInstance } from "./twitchPlayerApi";

interface TwitchPlayerProps {
  channel?: string;
  videoId?: string;
  title?: string;
  /**
   * Hay un clip abierto: el principal se pausa y se silencia (nunca compiten dos superficies
   * de Twitch). Al cerrar el clip NO se reanuda: el sonido vuelve solo con una interacción.
   */
  suspended?: boolean;
  /** El usuario activó explícitamente el principal (p. ej. con un clip abierto). */
  onActivate?: () => void;
}

/** Volumen razonable si el reproductor estaba a 0 al pedir sonido. */
const DEFAULT_VOLUME = 0.5;

/** Un foco que llega justo después de una tecla se considera navegación por teclado. */
const KEYBOARD_FOCUS_WINDOW_MS = 500;

interface PlayerState {
  alive: boolean;
  ready: boolean;
  soundRequested: boolean;
  activationPending: boolean;
  player: TwitchPlayerInstance | null;
}

function silence(player: TwitchPlayerInstance) {
  try {
    player.pause();
    player.setMuted(true);
  } catch {
    // El reproductor sigue utilizable con sus propios controles.
  }
}

/**
 * Reproductor principal de Twitch (directo o último VOD) con la API oficial `Twitch.Player`.
 *
 * Estado inicial NO intrusivo: arranca silenciado (autoplay + muted), como antes; ningún evento
 * de la página (carga, polling de estado, scroll) activa el sonido. La interacción explícita es
 * un clic dentro del reproductor: el iframe de Twitch es de otro origen, así que el clic se
 * detecta cuando el foco entra en él. Entonces se solicita, UNA vez por reproductor, play y
 * sonido. Si el navegador o Twitch lo rechazan el vídeo sigue usable con los controles de
 * Twitch: sin reintentos, sin remontajes.
 *
 * Si el script oficial no carga, se usa el iframe simple (comportamiento previo, silenciado).
 */
export default function TwitchPlayer({
  channel,
  videoId,
  title = "Twitch player",
  suspended = false,
  onActivate,
}: TwitchPlayerProps) {
  const parent = typeof window !== "undefined" ? window.location.hostname : "localhost";
  const containerId = `twitch-player-${useId().replace(/:/g, "")}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<PlayerState | null>(null);
  const propsRef = useRef({ suspended, onActivate });
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    propsRef.current = { suspended, onActivate };
  });

  useEffect(() => {
    const s = stateRef.current;
    if (!suspended || !s) return;
    // Un clip pasa a ser la superficie activa: el principal se detiene y se silencia.
    s.soundRequested = false;
    s.activationPending = false;
    if (s.ready && s.player) silence(s.player);
  }, [suspended]);

  useEffect(() => {
    if (fallback) return;
    const container = containerRef.current;
    if (!container) return;

    const s: PlayerState = {
      alive: true,
      ready: false,
      soundRequested: false,
      activationPending: false,
      player: null,
    };
    stateRef.current = s;
    let observer: IntersectionObserver | undefined;

    const requestSound = () => {
      const player = s.player;
      if (!s.alive || !player || s.soundRequested) return;
      s.soundRequested = true;
      try {
        player.play();
        player.setMuted(false);
        if (player.getVolume() === 0) player.setVolume(DEFAULT_VOLUME);
      } catch {
        // Rechazo del navegador/Twitch: se queda como está.
      }
    };

    const activate = () => {
      if (!s.alive) return;
      propsRef.current.onActivate?.();
      if (s.ready) requestSound();
      else s.activationPending = true;
    };

    // Recorrer la página con el teclado (Tab) también mete el foco en el iframe: eso no es una
    // interacción con el vídeo y no debe activar el sonido. Un clic o toque no genera ninguna
    // tecla en esta página, así que un keydown reciente delata el foco por teclado.
    let lastKeyAt = Number.NEGATIVE_INFINITY;
    const onKeyDown = () => {
      lastKeyAt = performance.now();
    };

    // Clic en el iframe de otro origen → el foco entra en él y la ventana pierde el foco.
    const onWindowBlur = () => {
      if (performance.now() - lastKeyAt < KEYBOARD_FOCUS_WINDOW_MS) return;
      const active = document.activeElement;
      if (active instanceof HTMLIFrameElement && container.contains(active)) activate();
    };

    const create = async () => {
      let Ctor;
      try {
        Ctor = await loadTwitchPlayerApi();
      } catch {
        if (s.alive) setFallback(true);
        return;
      }
      if (!s.alive) return;
      container.replaceChildren();
      const player = new Ctor(containerId, {
        width: "100%",
        height: "100%",
        ...(videoId ? { video: videoId } : { channel }),
        parent: [parent],
        autoplay: true,
        muted: true,
      });
      s.player = player;
      container.querySelector("iframe")?.setAttribute("title", title);
      player.addEventListener(Ctor.READY, () => {
        // Evento de un reproductor ya sustituido o desmontado: se ignora.
        if (!s.alive || s.player !== player || s.ready) return;
        s.ready = true;
        if (propsRef.current.suspended) {
          silence(player);
          return;
        }
        if (s.activationPending) {
          s.activationPending = false;
          requestSound();
        }
      });
      window.addEventListener("blur", onWindowBlur);
      document.addEventListener("keydown", onKeyDown, true);
    };

    // Como el iframe con loading="lazy" de antes: no se crea hasta estar cerca de la vista.
    if (typeof IntersectionObserver === "undefined") {
      void create();
    } else {
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          observer?.disconnect();
          void create();
        },
        { rootMargin: "300px" },
      );
      observer.observe(container);
    }

    return () => {
      s.alive = false;
      s.player = null;
      if (stateRef.current === s) stateRef.current = null;
      observer?.disconnect();
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("keydown", onKeyDown, true);
      container.replaceChildren();
    };
    // title solo se usa al crear: cambiarlo no debe remontar el reproductor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, videoId, parent, containerId, fallback]);

  const source = videoId ? `video=${videoId}` : `channel=${channel}`;

  return (
    <div className="aspect-video w-full overflow-hidden rounded-lg border border-border-subtle">
      {fallback ? (
        <iframe
          src={`https://player.twitch.tv/?${source}&parent=${parent}&muted=true`}
          title={title}
          allowFullScreen
          loading="lazy"
          className="h-full w-full"
        />
      ) : (
        <div id={containerId} ref={containerRef} className="h-full w-full" />
      )}
    </div>
  );
}
