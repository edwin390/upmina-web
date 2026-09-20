import { useEffect, useRef, useState, type TouchEvent } from "react";
import type { TikTokVideo } from "@/types";
import { wrapIndex } from "@/lib/media-ratio";
import TikTokCover from "./TikTokCover";
import { safeTikTokUrl } from "./tiktokUrl";

interface TikTokViewerProps {
  /** Vídeos del feed, en el orden de la rejilla. */
  videos: TikTokVideo[];
  /** Índice del vídeo abierto. */
  index: number;
  /** Cambia de vídeo (circular): -1 anterior, +1 siguiente. */
  onNavigate: (delta: number) => void;
  onClose: () => void;
  /** Elemento que abrió el visor; recupera el foco al cerrarlo. */
  returnFocusTo?: HTMLElement | null;
}

/** Recorrido vertical mínimo (px) para que un gesto cuente como swipe. */
export const SWIPE_THRESHOLD_PX = 60;
/** Un swipe debe ser claramente vertical: |dy| ≥ 1,5 × |dx|. */
const SWIPE_VERTICAL_BIAS = 1.5;

const dateFormat = new Intl.DateTimeFormat("es", { dateStyle: "long" });

const GLASS_BUTTON =
  "grid h-11 w-11 place-items-center rounded-full border border-white/25 bg-black/45 text-lg text-white backdrop-blur-sm transition-colors hover:border-accent-secondary hover:text-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary";

// Ancho del área 9:16: cabe en el alto disponible (dejando sitio a título y botón) y nunca
// pasa de 380 px, para que en escritorio no sea enorme. En pantallas de poco alto
// (`short`) el texto pasa al lateral y la portada usa casi todo el alto.
const FRAME_WIDTH =
  "w-[min(92vw,calc((100dvh-190px)*9/16),380px)] short:w-[min(60vw,calc((100dvh-32px)*9/16),380px)]";

/**
 * Visor vertical de TikTok dentro de Upmina Web. video.list no da un archivo reproducible,
 * así que muestra la portada 9:16 (object-cover, sin deformar) con título, fecha y enlace
 * al TikTok original.
 *
 * Navegación vertical y circular, como el feed de TikTok:
 * - Teclado: ↓ siguiente, ↑ anterior, Escape cierra.
 * - Táctil: swipe hacia arriba → siguiente, hacia abajo → anterior (umbral SWIPE_THRESHOLD_PX).
 * - Botones ↑ / ↓ discretos.
 * Mientras está abierto, el scroll del documento queda bloqueado (y `touch-action: none`
 * evita que el gesto desplace la página de detrás).
 */
export default function TikTokViewer({
  videos,
  index,
  onNavigate,
  onClose,
  returnFocusTo,
}: TikTokViewerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pressStartedOnBackdrop = useRef(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  // Sentido del último cambio, solo para la transición de entrada.
  const [direction, setDirection] = useState<1 | -1 | 0>(0);

  const video = videos[index];
  const total = videos.length;
  const canNavigate = total > 1;

  const go = (delta: 1 | -1) => {
    if (!canNavigate) return;
    setDirection(delta);
    onNavigate(delta);
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

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      // Escape explícito: no depende de que el navegador dispare `cancel`.
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as Element | null;
      if (target?.closest?.("input, textarea, select, [contenteditable]")) return;

      // Siempre se evita el scroll nativo; mantener pulsada la tecla no encadena saltos.
      event.preventDefault();
      if (event.repeat) return;
      goRef.current(event.key === "ArrowDown" ? 1 : -1);
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      // Diferido un frame y solo si el diálogo ya salió del DOM (desmontaje real,
      // no la simulación de StrictMode): el foco vuelve a la tarjeta que lo abrió.
      requestAnimationFrame(() => {
        if (!dialog.isConnected) returnFocusTo?.focus?.();
      });
    };
  }, [returnFocusTo]);

  // Precarga solo las portadas de los dos vecinos (sin peticiones a la API).
  useEffect(() => {
    if (total < 2) return;
    for (const i of new Set([wrapIndex(index, -1, total), wrapIndex(index, 1, total)])) {
      if (i !== index) new Image().src = videos[i].coverImageUrl;
    }
  }, [index, videos, total]);

  if (!video) return null;

  const title = video.title.trim();
  const href = safeTikTokUrl(video.embedUrl);
  const date = new Date(video.createTime);
  const hasDate = !Number.isNaN(date.getTime());
  const enter =
    direction === 1
      ? "animate-tt-in-up motion-reduce:animate-none"
      : direction === -1
        ? "animate-tt-in-down motion-reduce:animate-none"
        : "";

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

    const dy = touch.clientY - start.y;
    const dx = touch.clientX - start.x;
    // Gestos cortos o diagonales no cambian de vídeo.
    if (Math.abs(dy) < SWIPE_THRESHOLD_PX) return;
    if (Math.abs(dy) < Math.abs(dx) * SWIPE_VERTICAL_BIAS) return;
    // Dedo hacia arriba → siguiente (como TikTok); hacia abajo → anterior.
    go(dy < 0 ? 1 : -1);
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="tt-viewer-title"
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
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none touch-none overflow-hidden overscroll-contain bg-transparent p-0 text-text-primary backdrop:bg-black/85 backdrop:backdrop-blur-sm"
    >
      <div
        data-tt-backdrop
        className="flex h-full w-full items-center justify-center overflow-hidden px-2 py-3"
      >
        {/* Se remonta al cambiar de vídeo: entra con una transición vertical corta. */}
        <div
          key={video.id}
          className={`flex min-w-0 flex-col items-center gap-3 short:flex-row short:gap-5 ${enter}`}
        >
          <div
            className={`relative aspect-[9/16] shrink-0 overflow-hidden rounded-2xl border border-border-strong bg-bg-surface shadow-glow-secondary ${FRAME_WIDTH}`}
          >
            <TikTokCover
              url={video.coverImageUrl}
              alt={title ? `Portada: ${title}` : "Portada del video de TikTok"}
            />
          </div>

          <div className="flex min-w-[14rem] max-w-[92vw] flex-col items-center gap-2 text-center short:w-56 short:min-w-0 short:items-start short:text-left">
            <h2
              id="tt-viewer-title"
              className={
                title
                  ? "line-clamp-2 break-words text-sm font-semibold text-text-primary"
                  : "sr-only"
              }
            >
              {title || "Video de TikTok"}
            </h2>
            {hasDate && (
              <time dateTime={video.createTime} className="text-xs text-text-muted">
                {dateFormat.format(date)}
              </time>
            )}
            {href && (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-black/40 px-4 py-2 text-sm font-medium text-text-primary backdrop-blur-sm transition-colors hover:border-accent-primary hover:text-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
              >
                Ver en TikTok <span aria-hidden="true">↗</span>
                <span className="sr-only">(se abre en una pestaña nueva)</span>
              </a>
            )}
          </div>
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
        <>
          <p
            aria-hidden="true"
            className="fixed left-4 top-5 text-xs font-medium text-white/70"
          >
            {index + 1} / {total}
          </p>
          {/* Controles discretos ↑ / ↓ (la navegación principal es teclado y swipe). */}
          <div className="fixed right-2 top-1/2 flex -translate-y-1/2 flex-col gap-3 sm:right-4">
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label="Video anterior"
              className={GLASS_BUTTON}
            >
              <span aria-hidden="true">↑</span>
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="Video siguiente"
              className={GLASS_BUTTON}
            >
              <span aria-hidden="true">↓</span>
            </button>
          </div>
        </>
      )}

      <p className="sr-only" aria-live="polite">
        {canNavigate ? `Video ${index + 1} de ${total}` : ""}
      </p>
    </dialog>
  );
}

// El "fondo" es el propio <dialog> (transparente, a pantalla completa) o su contenedor
// centrador: cualquier clic fuera del contenido.
function isBackdrop(target: EventTarget, dialog: HTMLElement): boolean {
  return target === dialog || (target as HTMLElement).dataset?.ttBackdrop !== undefined;
}
