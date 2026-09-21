import { useEffect, useRef, type TouchEvent } from "react";
import type { TwitchClip } from "@/types";
import { formatRelativeDate } from "@/lib/format";
import { wrapIndex } from "@/lib/media-ratio";
import TwitchClipPlayer from "./TwitchClipPlayer";
import { safeTwitchUrl } from "./twitchUrl";

interface TwitchClipViewerProps {
  /** Clips de la sección, en el orden de la rejilla. */
  clips: TwitchClip[];
  /** Índice del clip abierto. */
  index: number;
  /** Cambia de clip (circular): -1 anterior, +1 siguiente. */
  onNavigate: (delta: number) => void;
  onClose: () => void;
  /** Elemento que abrió el visor; recupera el foco al cerrarlo. */
  returnFocusTo?: HTMLElement | null;
}

/** Recorrido horizontal mínimo (px) para que un gesto cuente como swipe. */
export const SWIPE_THRESHOLD_PX = 60;
/** Un swipe debe ser claramente horizontal: |dx| ≥ 1,5 × |dy|. */
const SWIPE_HORIZONTAL_BIAS = 1.5;

const GLASS_BUTTON =
  "grid h-11 w-11 shrink-0 place-items-center rounded-full border border-white/25 bg-black/45 text-lg text-white backdrop-blur-sm transition-colors hover:border-accent-secondary hover:text-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary";

// Ancho del área 16:9: cabe en el alto disponible (dejando sitio a título, enlace y controles)
// y nunca pasa de 960 px. Desde `sm` las flechas van fijas a los lados, así que se dejan
// 70 px libres a cada lado. En pantallas de poco alto (`short`) el texto se compacta y el
// vídeo usa casi todo el alto.
const FRAME_WIDTH =
  "w-[min(94vw,calc((100dvh-230px)*16/9),960px)] sm:w-[min(calc(100vw-140px),calc((100dvh-230px)*16/9),960px)] short:w-[min(calc(100vw-140px),calc((100dvh-120px)*16/9),960px)]";

/**
 * Visor de clips de Twitch dentro de Upmina Web. Reproduce el clip con el reproductor oficial
 * de Twitch (un único iframe, ver TwitchClipPlayer). Título, metadatos y enlace a Twitch
 * quedan fuera del área de vídeo.
 *
 * Navegación horizontal y circular, como las publicaciones de Instagram (los clips son
 * apaisados, como sus fotos; TikTok es vertical porque sus vídeos también lo son):
 * - Teclado: → siguiente, ← anterior, Escape cierra.
 * - Táctil: swipe hacia la izquierda → siguiente, hacia la derecha → anterior (umbral
 *   SWIPE_THRESHOLD_PX), sobre las franjas laterales del reproductor o el resto del visor.
 * - Botones ← / → (siempre visibles; bajo el vídeo en móvil y a los lados en pantallas grandes).
 * Solo hay un reproductor montado a la vez: al cambiar de clip el anterior se desmonta, y al
 * cerrar también (deja de sonar). Mientras está abierto, el scroll del documento queda
 * bloqueado (y `touch-action: none` evita que el gesto desplace la página de detrás).
 */
export default function TwitchClipViewer({
  clips,
  index,
  onNavigate,
  onClose,
  returnFocusTo,
}: TwitchClipViewerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pressStartedOnBackdrop = useRef(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const clip = clips[index];
  const total = clips.length;
  const canNavigate = total > 1;

  const go = (delta: 1 | -1) => {
    if (canNavigate) onNavigate(delta);
  };

  // El padre pasa callbacks nuevos en cada render; los efectos no deben reiniciarse por eso.
  const goRef = useRef(go);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    goRef.current = go;
    onCloseRef.current = onClose;
  });

  // showModal() da focus trap y fondo inerte de forma nativa.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();

    // Bloqueo del scroll del documento (se restaura tal cual estaba).
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Marca de la última pulsación de Tab: quien navega con teclado no pierde el foco.
    let lastTabAt = 0;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") lastTabAt = Date.now();
      if (event.defaultPrevented) return;

      // Escape explícito: no depende de que el navegador dispare `cancel`.
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as Element | null;
      if (target?.closest?.("input, textarea, select, [contenteditable]")) return;

      // Mantener pulsada la tecla no encadena saltos.
      event.preventDefault();
      if (event.repeat) return;
      goRef.current(event.key === "ArrowRight" ? 1 : -1);
    };
    document.addEventListener("keydown", onKeyDown);

    // El reproductor es un iframe de otro origen: tras un clic (Play, volumen…) se queda con
    // el foco y se traga ← / → / Escape. Al perder la ventana el foco hacia el iframe, se
    // devuelve al visor (el clip sigue sonando; solo cambia quién recibe el teclado).
    const onWindowBlur = () => {
      window.setTimeout(() => {
        if (Date.now() - lastTabAt < 500) return;
        const active = document.activeElement;
        if (active instanceof HTMLIFrameElement && dialog.contains(active)) {
          dialog.focus({ preventScroll: true });
        }
      }, 0);
    };
    window.addEventListener("blur", onWindowBlur);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onWindowBlur);
      document.body.style.overflow = previousOverflow;
      // Diferido un frame y solo si el diálogo ya salió del DOM (desmontaje real,
      // no la simulación de StrictMode): el foco vuelve a la tarjeta que lo abrió.
      requestAnimationFrame(() => {
        if (!dialog.isConnected) returnFocusTo?.focus?.();
      });
    };
  }, [returnFocusTo]);

  // Precarga solo las miniaturas de los dos vecinos (imágenes, nunca reproductores).
  useEffect(() => {
    if (total < 2) return;
    for (const i of new Set([wrapIndex(index, -1, total), wrapIndex(index, 1, total)])) {
      if (i !== index && clips[i].thumbnailUrl) new Image().src = clips[i].thumbnailUrl;
    }
  }, [index, clips, total]);

  if (!clip) return null;

  const title = clip.title.trim();
  const href = safeTwitchUrl(clip.url);

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    touchStart.current =
      canNavigate && event.touches.length === 1 && touch
        ? { x: touch.clientX, y: touch.clientY }
        : null;
  };

  const onTouchEnd = (event: TouchEvent) => {
    const start = touchStart.current;
    const touch = event.changedTouches[0];
    touchStart.current = null;
    if (!start || !touch) return;

    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    // Gestos cortos o diagonales no cambian de clip.
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
    if (Math.abs(dx) < Math.abs(dy) * SWIPE_HORIZONTAL_BIAS) return;
    // Dedo hacia la izquierda → siguiente; hacia la derecha → anterior.
    go(dx < 0 ? 1 : -1);
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="tw-viewer-title"
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        pressStartedOnBackdrop.current = isBackdrop(event.target, event.currentTarget);
      }}
      onClick={(event) => {
        // Solo cierra si pulsar y soltar fueron ambos sobre el fondo.
        if (
          pressStartedOnBackdrop.current &&
          isBackdrop(event.target, event.currentTarget)
        ) {
          onClose();
        }
      }}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={() => {
        touchStart.current = null;
      }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none touch-none overflow-hidden overscroll-contain bg-transparent p-0 outline-none text-text-primary backdrop:bg-black/85 backdrop:backdrop-blur-sm"
    >
      <div
        data-tw-backdrop
        className="flex h-full w-full items-center justify-center overflow-hidden px-2 py-3"
      >
        <div className="flex min-w-0 flex-col items-center gap-3 short:gap-2">
          {/* `key`: un iframe nuevo por clip; el anterior se desmonta por completo. */}
          <div
            key={clip.id}
            className={`relative aspect-video shrink-0 overflow-hidden rounded-2xl border border-border-strong bg-bg-surface shadow-glow-secondary ${FRAME_WIDTH}`}
          >
            <TwitchClipPlayer clip={clip} />
          </div>

          <div className="flex min-w-[14rem] max-w-[92vw] flex-col items-center gap-1.5 text-center short:gap-1">
            <h2
              id="tw-viewer-title"
              className={
                title
                  ? "line-clamp-2 break-words text-sm font-semibold text-text-primary short:line-clamp-1"
                  : "sr-only"
              }
            >
              {title || "Clip de Twitch"}
            </h2>
            <p className="text-xs text-text-muted">
              {clip.creatorName} · {clip.viewCount.toLocaleString("es")}{" "}
              {clip.viewCount === 1 ? "vista" : "vistas"} ·{" "}
              {formatRelativeDate(clip.createdAt)}
            </p>
            {href && (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-black/40 px-4 py-2 text-sm font-medium text-text-primary backdrop-blur-sm transition-colors hover:border-accent-primary hover:text-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary short:py-1"
              >
                Ver en Twitch <span aria-hidden="true">↗</span>
                <span className="sr-only">(se abre en una pestaña nueva)</span>
              </a>
            )}
          </div>

          {canNavigate && (
            /* Móvil: fila bajo el vídeo. Pantallas grandes: flechas fijas a los lados. */
            <div className="flex items-center justify-center gap-4">
              <button
                type="button"
                onClick={() => go(-1)}
                aria-label="Clip anterior"
                className={`${GLASS_BUTTON} sm:fixed sm:left-4 sm:top-1/2 sm:-translate-y-1/2`}
              >
                <span aria-hidden="true">←</span>
              </button>
              <p
                aria-hidden="true"
                className="text-xs font-medium text-white/70 sm:hidden"
              >
                {index + 1} / {total}
              </p>
              <button
                type="button"
                onClick={() => go(1)}
                aria-label="Clip siguiente"
                className={`${GLASS_BUTTON} sm:fixed sm:right-4 sm:top-1/2 sm:-translate-y-1/2`}
              >
                <span aria-hidden="true">→</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={onClose}
        aria-label="Cerrar"
        data-autofocus
        className={`${GLASS_BUTTON} fixed right-3 top-3`}
      >
        <span aria-hidden="true">✕</span>
      </button>

      {canNavigate && (
        <p
          aria-hidden="true"
          className="fixed left-4 top-5 hidden text-xs font-medium text-white/70 sm:block"
        >
          {index + 1} / {total}
        </p>
      )}

      <p className="sr-only" aria-live="polite">
        {canNavigate ? `Clip ${index + 1} de ${total}` : ""}
      </p>
    </dialog>
  );
}

// El "fondo" es el propio <dialog> (transparente, a pantalla completa) o su contenedor
// centrador: cualquier clic fuera del contenido.
function isBackdrop(target: EventTarget, dialog: HTMLElement): boolean {
  return target === dialog || (target as HTMLElement).dataset?.twBackdrop !== undefined;
}
