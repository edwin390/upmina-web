import { useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import type { YouTubeVideo } from "@/types";
import { isYouTubeVideoId } from "@/lib/deep-links";
import { formatRelativeDate } from "@/lib/format";
import { wrapIndex } from "@/lib/media-ratio";
import { shortEmbedUrl } from "./youtubeUrl";

// Visor de Shorts de YouTube (Fase 9H-2.5): una experiencia vertical INDEPENDIENTE del reproductor
// principal. Un Short nunca se reproduce en el hero ni cambia su selección, y el hero nunca cambia
// el Short elegido: la selección de Shorts es un estado propio de la sección (id), no la URL de
// los videos largos.
//
// Patrón tomado del visor de TikTok solo en lo genérico (navegación circular con `wrapIndex`,
// portada 9:16, controles anterior/siguiente); no comparte tipos, URLs ni el reproductor de TikTok.
// A diferencia de aquel, NO es una superposición a pantalla completa: vive dentro de la página.
//
// Reproducción: el reproductor nativo de YouTube (iframe youtube.com/embed) solo se monta cuando la
// persona pulsa "Reproducir" y ÚNICAMENTE para el Short seleccionado; al cambiar de Short el
// iframe anterior se desmonta (`key`) y nunca hay dos activos. Antes de pulsar solo hay una portada
// (no se carga el reproductor de YouTube para un Short que quizá nadie vea).

interface ShortsViewerProps {
  shorts: YouTubeVideo[];
  /** Id del Short seleccionado; si no está en la lista se usa el primero. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Id del encabezado que da nombre al grupo (accesibilidad). */
  headingId: string;
}

const NAV_BUTTON_CLASS =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border-subtle text-lg font-semibold text-text-secondary transition-colors duration-200 hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none";

export default function ShortsViewer({
  shorts,
  selectedId,
  onSelect,
  headingId,
}: ShortsViewerProps) {
  // Una vez pulsado "Reproducir", los Shorts siguientes se reproducen al navegar (decisión de la
  // persona); antes de eso solo se muestra la portada.
  const [playing, setPlaying] = useState(false);

  // Un id que no parece de YouTube nunca llega a un iframe.
  const playable = shorts.filter((short) => isYouTubeVideoId(short.id));
  if (playable.length === 0) return null;

  const index = Math.max(
    0,
    playable.findIndex((short) => short.id === selectedId),
  );
  const current = playable[index];
  const go = (delta: number) =>
    onSelect(playable[wrapIndex(index, delta, playable.length)].id);
  const single = playable.length < 2;

  // Solo las flechas laterales y solo con el foco dentro del visor: no se secuestra el scroll
  // vertical de la página ni se atrapa el foco.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (single || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      go(1);
    }
  };

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      className="rounded-xl border border-border-subtle bg-bg-surface p-4 sm:p-6"
    >
      <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-center md:gap-10">
        {/* Columna del reproductor: 9:16 acotado (no crece sin límite en escritorio). */}
        <div className="mx-auto w-full max-w-[280px] shrink-0 sm:max-w-[300px] md:mx-0">
          <div
            data-testid="short-frame"
            className="relative aspect-[9/16] w-full overflow-hidden rounded-xl border border-border-subtle bg-black shadow-glow-primary"
          >
            {playing ? (
              <iframe
                key={current.id}
                src={shortEmbedUrl(current.id)}
                title={`Short de YouTube: ${current.title}`}
                allow="autoplay; encrypted-media; fullscreen"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                className="absolute inset-0 h-full w-full border-0"
              />
            ) : (
              <button
                key={current.id}
                type="button"
                onClick={() => setPlaying(true)}
                aria-label={`Reproducir Short: ${current.title}`}
                className="group absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-secondary"
              >
                {current.thumbnailUrl && (
                  <img
                    src={current.thumbnailUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                )}
                <span
                  aria-hidden="true"
                  className="absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/70 text-2xl text-white transition-transform duration-200 group-hover:scale-110 motion-reduce:transition-none"
                >
                  ▶
                </span>
              </button>
            )}
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => go(-1)}
              disabled={single}
              aria-label="Short anterior"
              className={NAV_BUTTON_CLASS}
            >
              <span aria-hidden="true">‹</span>
            </button>
            <p aria-live="polite" className="text-sm text-text-secondary">
              {index + 1} de {playable.length}
            </p>
            <button
              type="button"
              onClick={() => go(1)}
              disabled={single}
              aria-label="Short siguiente"
              className={NAV_BUTTON_CLASS}
            >
              <span aria-hidden="true">›</span>
            </button>
          </div>
        </div>

        {/* Columna de información y lista: en móvil queda debajo del reproductor. */}
        <div className="min-w-0 md:max-w-sm md:flex-1">
          <p className="line-clamp-3 font-display text-xl tracking-wide text-text-primary">
            {current.title}
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            {formatRelativeDate(current.publishedAt)} · {current.duration}
          </p>

          {!single && (
            <ul
              aria-label="Lista de Shorts"
              className="mt-4 flex max-w-full gap-2 overflow-x-auto overscroll-x-contain pb-2 md:flex-wrap md:overflow-visible"
            >
              {playable.map((short) => {
                const isCurrent = short.id === current.id;
                return (
                  <li key={short.id} className="shrink-0">
                    <button
                      type="button"
                      onClick={() => onSelect(short.id)}
                      aria-label={`Ver Short: ${short.title}`}
                      aria-current={isCurrent ? "true" : undefined}
                      className={clsx(
                        "block w-14 overflow-hidden rounded-md border-2 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary motion-reduce:transition-none",
                        isCurrent
                          ? "border-accent-primary"
                          : "border-transparent hover:border-accent-secondary",
                      )}
                    >
                      {short.thumbnailUrl ? (
                        <img
                          src={short.thumbnailUrl}
                          alt=""
                          loading="lazy"
                          className="aspect-[9/16] w-full object-cover"
                        />
                      ) : (
                        <span className="block aspect-[9/16] w-full bg-bg-base" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
