import { useEffect, useRef } from "react";
import { useTranslations } from "use-intl";
import type { CosplayImage } from "@/types";

interface CosplayLightboxProps {
  images: CosplayImage[];
  index: number;
  /** Navegación circular: -1 anterior, +1 siguiente. */
  onNavigate: (delta: number) => void;
  onClose: () => void;
  /** Elemento que abrió el visor; recupera el foco al cerrarlo. */
  returnFocusTo?: HTMLElement | null;
}

// Compartido por anterior/siguiente Y cerrar (Fase "COSPLAY CYAN CLOSE BUTTON"): antes el botón
// de cerrar era gris neutro (sin borde ni glow), visualmente desligado de las flechas cian-neón.
// Ahora los tres controles pertenecen a la misma familia visual.
const NAV_BUTTON =
  "grid h-11 w-11 shrink-0 place-items-center rounded-full border-2 border-accent-secondary bg-bg-base/90 text-xl text-accent-secondary shadow-glow-secondary transition-colors hover:bg-accent-secondary hover:text-text-inverse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary";

/** Visor a pantalla completa de la galería de UNA publicación (Fase 9I-1). Mismo patrón que
 *  InstagramPostModal: <dialog>.showModal() da focus trap y fondo inerte nativos, Escape
 *  explícito, foco inicial en el botón de cerrar y devuelto al elemento que abrió el visor al
 *  desmontarse. Sin dependencia de galería externa: el visor cabe en unas ~150 líneas. */
export default function CosplayLightbox({
  images,
  index,
  onNavigate,
  onClose,
  returnFocusTo,
}: CosplayLightboxProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const touchStartX = useRef<number | null>(null);
  const t = useTranslations("common.lightbox");

  const total = images.length;
  const canNavigate = total > 1;
  const image = images[index];

  const onCloseRef = useRef(onClose);
  const onNavigateRef = useRef(onNavigate);
  const canNavigateRef = useRef(canNavigate);
  useEffect(() => {
    onCloseRef.current = onClose;
    onNavigateRef.current = onNavigate;
    canNavigateRef.current = canNavigate;
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (!canNavigateRef.current) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as Element | null;
      if (target?.closest?.("input, textarea, select, [contenteditable]")) return;

      event.preventDefault();
      onNavigateRef.current(event.key === "ArrowLeft" ? -1 : 1);
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      requestAnimationFrame(() => {
        if (!dialog.isConnected) returnFocusTo?.focus?.();
      });
    };
  }, [returnFocusTo]);

  if (!image) return null;

  return (
    <dialog
      ref={dialogRef}
      aria-label={t("dialogLabel")}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onTouchStart={(event) => {
        touchStartX.current = event.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(event) => {
        const start = touchStartX.current;
        touchStartX.current = null;
        if (start === null || !canNavigate) return;
        const delta = (event.changedTouches[0]?.clientX ?? start) - start;
        if (Math.abs(delta) < 40) return; // deslizamiento demasiado corto: no cuenta
        onNavigate(delta > 0 ? -1 : 1);
      }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden bg-transparent p-0 text-text-primary backdrop:bg-black/85 backdrop:backdrop-blur-sm"
    >
      <div className="grid h-full w-full place-items-center p-2">
        <figure className="relative flex max-h-full max-w-5xl flex-col items-center gap-3">
          <img
            src={image.url}
            alt={image.alt ?? ""}
            className="max-h-[78dvh] max-w-full rounded-lg object-contain shadow-glow-secondary"
          />
          {image.caption && (
            <figcaption className="max-w-prose text-center text-sm text-text-secondary">
              {image.caption}
            </figcaption>
          )}
        </figure>
      </div>

      <button
        type="button"
        onClick={onClose}
        aria-label={t("close")}
        data-autofocus
        className={`${NAV_BUTTON} fixed right-3 top-3`}
      >
        ✕
      </button>

      {canNavigate && (
        <>
          <button
            type="button"
            onClick={() => onNavigate(-1)}
            aria-label={t("previous")}
            className={`${NAV_BUTTON} fixed left-2 top-1/2 -translate-y-1/2 sm:left-4`}
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => onNavigate(1)}
            aria-label={t("next")}
            className={`${NAV_BUTTON} fixed right-2 top-1/2 -translate-y-1/2 sm:right-4`}
          >
            ›
          </button>
          <p
            className="fixed bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-bg-base/90 px-3 py-1 text-xs text-text-secondary"
            aria-live="polite"
          >
            {t("counter", { current: index + 1, total })}
          </p>
        </>
      )}
    </dialog>
  );
}
