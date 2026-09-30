import { useEffect, useRef, useState } from "react";
import type { CommunityFeedPost } from "@/types";

// Visor de media del detalle de una publicación (Fase 9J-3 follow-up "POST DETAIL MEDIA VIEWER"):
// antes (PostDetailPage.tsx) TODA la media de un post se apilaba verticalmente a ancho completo,
// así que un vídeo/imagen vertical (9:16) podía ocupar varias pantallas de alto. Se inspeccionó el
// visor existente de Cosplay (CosplayLightbox.tsx) para reutilizar su patrón de interacción
// (prev/next, contador, teclado ArrowLeft/ArrowRight con el mismo guard de inputs) — pero NO se
// reutiliza el componente en sí: CosplayLightbox está fuertemente acoplado a CosplayImage (sin
// noción de vídeo), es un <dialog> a pantalla completa abierto por clic sobre una miniatura, y aquí
// hace falta un visor SIEMPRE visible e inline dentro del detalle (nunca un paso adicional de
// "abrir"). Por eso este componente es específico de Comunidad, reproduciendo el mismo lenguaje
// visual/interacción con un componente pequeño y propio.
//
// Solo UN media visible a la vez (nunca todos apilados); mantiene el orden definido por el autor.
// object-contain + una altura MÁXIMA (nunca fija) evita que un archivo vertical requiera scroll
// para verse completo, sin recortar ni deformar. Al navegar, el vídeo activo se pausa explícitamente
// antes de desmontarse (nunca sigue reproduciéndose fuera de pantalla).

const NAV_BUTTON =
  "absolute top-1/2 z-10 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border-2 border-accent-secondary bg-bg-base/90 text-xl text-accent-secondary shadow-glow-secondary transition-colors hover:bg-accent-secondary hover:text-text-inverse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary";

const MEDIA_CLASS =
  "max-h-[60vh] w-auto max-w-full object-contain sm:max-h-[65vh] md:max-h-[70vh]";

export default function CommunityPostMediaViewer({
  media,
}: {
  media: CommunityFeedPost["media"];
}) {
  const [index, setIndex] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const total = media.length;
  const canNavigate = total > 1;
  const item = media[Math.min(index, total - 1)];

  const goTo = (nextIndex: number) => {
    videoRef.current?.pause();
    setIndex(nextIndex);
  };
  const goPrev = () => goTo((index - 1 + total) % total);
  const goNext = () => goTo((index + 1) % total);

  const goPrevRef = useRef(goPrev);
  const goNextRef = useRef(goNext);
  const canNavigateRef = useRef(canNavigate);
  useEffect(() => {
    goPrevRef.current = goPrev;
    goNextRef.current = goNext;
    canNavigateRef.current = canNavigate;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (!canNavigateRef.current) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as Element | null;
      if (target?.closest?.("input, textarea, select, [contenteditable]")) return;

      event.preventDefault();
      if (event.key === "ArrowLeft") goPrevRef.current();
      else goNextRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  if (total === 0 || !item) return null;

  return (
    <div className="relative mt-4 flex w-full items-center justify-center overflow-hidden rounded-lg bg-black">
      {item.kind === "video" ? (
        <video
          key={item.id}
          ref={videoRef}
          src={item.url}
          controls
          muted
          playsInline
          preload="metadata"
          className={MEDIA_CLASS}
        />
      ) : (
        <img key={item.id} src={item.url} alt="" className={MEDIA_CLASS} />
      )}

      {canNavigate ? (
        <>
          <button
            type="button"
            onClick={goPrev}
            aria-label="Anterior"
            className={`${NAV_BUTTON} left-2 sm:left-4`}
          >
            ‹
          </button>
          <button
            type="button"
            onClick={goNext}
            aria-label="Siguiente"
            className={`${NAV_BUTTON} right-2 sm:right-4`}
          >
            ›
          </button>
          <p
            aria-live="polite"
            className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-bg-base/90 px-3 py-1 text-xs text-text-secondary"
          >
            {index + 1} / {total}
          </p>
        </>
      ) : null}
    </div>
  );
}
