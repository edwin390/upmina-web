import { useState, type KeyboardEvent } from "react";
import { clampAspectRatio, wrapIndex } from "@/lib/media-ratio";

export interface ViewerSlide {
  id: string;
  type: "IMAGE" | "VIDEO";
  imageUrl?: string;
  videoUrl?: string;
}

interface InstagramMediaViewerProps {
  slides: ViewerSlide[];
  /** Descripción accesible del contenido (p. ej. el caption). */
  label: string;
  /** Proporción real del primer elemento, en cuanto el recurso carga. */
  onRatio?: (ratio: number) => void;
}

const NAV_BUTTON =
  "absolute top-1/2 z-10 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-black/60 text-base text-white backdrop-blur transition-colors hover:bg-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary";

/**
 * Visor de UNA publicación. Nivel "elementos del carrusel": flechas pequeñas sobre
 * la media, puntos y teclado ← →. Rellena el contenedor que le da el modal y muestra
 * la media completa (object-contain), sin recortar ni deformar.
 *
 * Regla de teclado: mientras el foco esté dentro del visor y haya varios elementos,
 * ← → cambian de elemento y el evento se consume (preventDefault), de modo que el
 * modal NO cambia de publicación. Con un solo elemento el visor no consume nada.
 */
export default function InstagramMediaViewer({
  slides,
  label,
  onRatio,
}: InstagramMediaViewerProps) {
  const [requestedIndex, setIndex] = useState(0);
  // Si la lista de slides cambia (llegan los children), el índice sigue siendo válido.
  const index = Math.min(requestedIndex, Math.max(slides.length - 1, 0));
  const slide = slides[index];
  const multiple = slides.length > 1;

  const go = (delta: number) => setIndex(wrapIndex(index, delta, slides.length));

  // En un carrusel todos los elementos comparten la proporción del primero.
  const report = (width: number, height: number) => {
    if (index !== 0) return;
    const ratio = clampAspectRatio(width, height);
    if (ratio !== null) onRatio?.(ratio);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!multiple || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      go(1);
    }
  };

  if (!slide) return null;

  return (
    <div
      role="group"
      aria-roledescription={multiple ? "carrusel" : undefined}
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="absolute inset-0 flex items-center justify-center overflow-hidden bg-black focus:outline-none"
    >
      {slide.type === "VIDEO" && slide.videoUrl ? (
        <video
          // Al cambiar de slide se desmonta el video anterior y se detiene.
          key={slide.id}
          src={slide.videoUrl}
          poster={slide.imageUrl}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={(event) =>
            report(event.currentTarget.videoWidth, event.currentTarget.videoHeight)
          }
          className="h-full w-full object-contain"
        />
      ) : (
        slide.imageUrl && (
          <img
            key={slide.id}
            src={slide.imageUrl}
            alt={label}
            onLoad={(event) =>
              report(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)
            }
            className="h-full w-full object-contain"
          />
        )
      )}

      {multiple && (
        <>
          <button
            type="button"
            aria-label="Elemento anterior"
            onClick={() => go(-1)}
            className={`${NAV_BUTTON} left-2`}
          >
            ←
          </button>
          <button
            type="button"
            aria-label="Elemento siguiente"
            onClick={() => go(1)}
            className={`${NAV_BUTTON} right-2`}
          >
            →
          </button>
          <span className="absolute right-3 top-3 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white">
            {index + 1}/{slides.length}
          </span>
          <div className="absolute inset-x-0 bottom-3 z-10 flex justify-center gap-1.5">
            {slides.map((s, i) => (
              <button
                key={s.id}
                type="button"
                aria-label={`Ir al elemento ${i + 1} de ${slides.length}`}
                aria-current={i === index}
                onClick={() => setIndex(i)}
                className={`h-2 w-2 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary ${
                  i === index ? "bg-accent-primary" : "bg-white/50 hover:bg-white/80"
                }`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
