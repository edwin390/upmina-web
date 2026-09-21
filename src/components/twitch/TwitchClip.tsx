import { useState } from "react";
import type { TwitchClip as TwitchClipType } from "@/types";
import { formatRelativeDate } from "@/lib/format";
import { safeTwitchUrl } from "./twitchUrl";

interface TwitchClipProps {
  clip: TwitchClipType;
  /** Abre el visor en este clip; `trigger` recupera el foco al cerrarlo. */
  onOpen: (clip: TwitchClipType, trigger: HTMLElement) => void;
}

/**
 * Miniatura del clip que rellena su contenedor 16:9 (object-cover, sin deformar). Si falla la
 * carga se usa un fondo degradado neon.
 */
export function ClipThumbnail({
  url,
  alt = "",
  className = "",
}: {
  url: string;
  alt?: string;
  className?: string;
}) {
  // Se recuerda la URL que falló: si llega otra distinta, se vuelve a intentar.
  const [failedUrl, setFailedUrl] = useState<string>();

  if (url && url !== failedUrl) {
    return (
      <img
        src={url}
        alt={alt}
        loading="lazy"
        draggable={false}
        onError={() => setFailedUrl(url)}
        className={`h-full w-full object-cover ${className}`}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className="block h-full w-full bg-gradient-to-br from-accent-primary/30 via-bg-elevated to-accent-secondary/30"
    />
  );
}

function PlayBadge() {
  return (
    <span
      aria-hidden="true"
      className="absolute left-1/2 top-1/2 grid h-12 w-12 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white ring-1 ring-white/30 backdrop-blur-sm transition-[transform,background-color,box-shadow] group-hover:scale-110 group-hover:bg-accent-primary/80 group-hover:shadow-glow-primary"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="currentColor"
        className="ml-0.5"
      >
        <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
      </svg>
    </span>
  );
}

/**
 * Tarjeta de un clip: miniatura real + metadatos, SIN reproductor. Crear 12 iframes de Twitch
 * al abrir /twitch costaba ~1 200 peticiones y ~9 MB; el reproductor solo se monta en el visor
 * (TwitchClipViewer) y solo para el clip abierto.
 */
export default function TwitchClip({ clip, onOpen }: TwitchClipProps) {
  const twitchUrl = safeTwitchUrl(clip.url);

  return (
    <div className="group overflow-hidden rounded-lg border border-border-subtle bg-bg-surface transition-[transform,box-shadow,border-color] duration-350 ease-bounce hover:-translate-y-2 hover:rotate-[-1deg] hover:border-accent-primary/70 hover:shadow-glow-primary">
      <button
        type="button"
        onClick={(event) => onOpen(clip, event.currentTarget)}
        aria-haspopup="dialog"
        aria-label={clip.title ? `Reproducir clip: ${clip.title}` : "Reproducir clip"}
        className="relative block aspect-video w-full overflow-hidden bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-secondary"
      >
        <ClipThumbnail url={clip.thumbnailUrl} />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-tr from-accent-primary/10 via-transparent to-white/10 opacity-0 transition-opacity duration-350 group-hover:opacity-100"
        />
        <PlayBadge />
      </button>
      <div className="p-3">
        <p className="line-clamp-2 text-sm font-medium text-text-primary">{clip.title}</p>
        <p className="mt-1 text-xs text-text-muted">
          {clip.creatorName} · {clip.viewCount.toLocaleString("es")}{" "}
          {clip.viewCount === 1 ? "vista" : "vistas"} ·{" "}
          {formatRelativeDate(clip.createdAt)}
        </p>
        {/* Salida opcional a twitch.tv; la reproducción normal ocurre en el visor. */}
        {twitchUrl && (
          <a
            href={twitchUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-2 inline-block text-xs font-medium text-accent-primary hover:underline"
          >
            Ver en Twitch
          </a>
        )}
      </div>
    </div>
  );
}
