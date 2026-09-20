import clsx from "clsx";
import type { YouTubeVideo } from "@/types";
import { formatRelativeDate } from "@/lib/format";

interface VideoCardProps {
  video: YouTubeVideo;
  isSelected: boolean;
  onSelect: (id: string) => void;
  /** Miniatura vertical 9:16 (Shorts). Las miniaturas de YouTube traen barras negras: object-cover las recorta. */
  vertical?: boolean;
}

export default function VideoCard({
  video,
  isSelected,
  onSelect,
  vertical = false,
}: VideoCardProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(video.id)}
      className={clsx(
        "group relative overflow-hidden rounded-lg border-2 bg-bg-surface text-left transition-all hover:-translate-y-0.5",
        isSelected
          ? "border-accent-primary"
          : "border-transparent hover:border-accent-secondary",
      )}
    >
      <div className={clsx("relative", vertical ? "aspect-[9/16]" : "aspect-video")}>
        <img
          src={video.thumbnailUrl}
          alt={video.title}
          className="h-full w-full object-cover"
          loading="lazy"
        />
        <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1.5 py-0.5 text-xs text-white">
          {video.duration}
        </span>
        {isSelected && (
          <span className="absolute left-1 top-1 rounded bg-accent-primary px-1.5 py-0.5 text-xs font-semibold text-text-inverse">
            Reproduciendo
          </span>
        )}
      </div>
      <div className="p-2">
        <p className="line-clamp-2 text-sm font-medium text-text-primary">
          {video.title}
        </p>
        <p className="mt-1 text-xs text-text-muted">
          {formatRelativeDate(video.publishedAt)}
        </p>
      </div>
    </button>
  );
}
