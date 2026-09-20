import type { TikTokVideo } from "@/types";
import { formatRelativeDate } from "@/lib/format";
import TikTokCover from "./TikTokCover";

interface TikTokCardProps {
  video: TikTokVideo;
  /** Abre el visor en este vídeo; `trigger` recupera el foco al cerrarlo. */
  onOpen: (video: TikTokVideo, trigger: HTMLElement) => void;
}

function PlayBadge() {
  return (
    <span
      aria-hidden="true"
      className="absolute left-1/2 top-1/2 grid h-12 w-12 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white ring-1 ring-white/30 backdrop-blur-sm transition-[transform,background-color,box-shadow] group-hover:scale-110 group-hover:bg-accent-primary/80 group-hover:shadow-glow-primary group-focus-visible:scale-110"
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
 * Tarjeta vertical 9:16 tipo feed de TikTok. video.list no entrega un archivo de vídeo
 * reproducible, así que la portada es la presentación principal; al hacer clic se abre el
 * visor interno (TikTokViewer). Título y fecha van fuera del área 9:16.
 */
export default function TikTokCard({ video, onOpen }: TikTokCardProps) {
  const title = video.title.trim();
  const label = title ? `Abrir TikTok: ${title}` : "Abrir video de TikTok";

  return (
    <article className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        onClick={(event) => onOpen(video, event.currentTarget)}
        aria-haspopup="dialog"
        aria-label={label}
        className="group relative block aspect-[9/16] w-full overflow-hidden rounded-lg border border-border-subtle bg-bg-surface transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-accent-primary/70 hover:shadow-glow-primary focus-visible:border-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
      >
        <TikTokCover
          url={video.coverImageUrl}
          className="transition-transform duration-300 group-hover:scale-105"
        />
        <PlayBadge />
      </button>
      <div className="px-0.5">
        {title && (
          <p className="line-clamp-2 break-words text-sm font-medium text-text-primary">
            {title}
          </p>
        )}
        <p className="mt-0.5 text-xs text-text-muted">
          {formatRelativeDate(video.createTime)}
        </p>
      </div>
    </article>
  );
}
