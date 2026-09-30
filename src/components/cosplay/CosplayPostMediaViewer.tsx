import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import type { CosplayImage } from "@/types";

// Visor de fotos INLINE del detalle de una publicación de Cosplay (Fase "COSPLAY DETAIL
// REDESIGN"): antes, el detalle mostraba una rejilla de miniaturas y solo al PULSAR una se abría
// CosplayLightbox (un <dialog> a pantalla completa aparte). Inspirado en el detalle de Community
// (CommunityPostMediaViewer.tsx): AQUÍ el visor está siempre visible, sin paso adicional de
// "abrir" — una sola fotografía protagonista a la vez, con navegación anterior/siguiente cuando
// la publicación tiene más de una. Las flechas SOLO recorren las fotos de ESTA publicación; nunca
// cambian de publicación de Cosplay (eso lo decide el usuario al volver al catálogo).
//
// Reutiliza el namespace de traducción "common.lightbox" (previous/next/counter) que ya usaba
// CosplayLightbox — mismos rótulos accesibles, sin duplicar claves i18n.
//
// object-contain + una altura MÁXIMA (nunca fija, ~60-70vh según breakpoint) evita el problema de
// superposición corregido en Twitch: como las fotos de cosplay suelen ser verticales, quedan
// centradas con su proporción intacta y casi siempre dejan hueco lateral propio para las flechas,
// sin necesidad de una fila aparte.

const NAV_BUTTON =
  "grid h-11 w-11 shrink-0 place-items-center rounded-full border-2 border-accent-secondary bg-bg-base/90 text-xl text-accent-secondary shadow-glow-secondary transition-colors hover:bg-accent-secondary hover:text-text-inverse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary";

export default function CosplayPostMediaViewer({ gallery }: { gallery: CosplayImage[] }) {
  const t = useTranslations("common.lightbox");
  const [index, setIndex] = useState(0);
  const total = gallery.length;
  const canNavigate = total > 1;
  const image = gallery[Math.min(index, total - 1)];

  const goPrev = () => setIndex((current) => (current - 1 + total) % total);
  const goNext = () => setIndex((current) => (current + 1) % total);

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

  if (total === 0 || !image) return null;

  return (
    <div className="relative mt-4 flex w-full items-center justify-center overflow-hidden rounded-lg bg-black">
      <img
        src={image.url}
        alt={image.decorative ? "" : (image.alt ?? "")}
        className="max-h-[60vh] w-auto max-w-full object-contain sm:max-h-[65vh] md:max-h-[70vh]"
      />

      {canNavigate ? (
        <>
          <button
            type="button"
            onClick={goPrev}
            aria-label={t("previous")}
            className={`${NAV_BUTTON} absolute left-2 top-1/2 -translate-y-1/2 sm:left-4`}
          >
            ‹
          </button>
          <button
            type="button"
            onClick={goNext}
            aria-label={t("next")}
            className={`${NAV_BUTTON} absolute right-2 top-1/2 -translate-y-1/2 sm:right-4`}
          >
            ›
          </button>
          <p
            aria-live="polite"
            className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-bg-base/90 px-3 py-1 text-xs text-text-secondary"
          >
            {t("counter", { current: index + 1, total })}
          </p>
        </>
      ) : null}
    </div>
  );
}
