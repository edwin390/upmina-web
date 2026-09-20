import type { InstagramMediaItem } from "@/types";
import { rememberAspectRatio } from "@/lib/media-ratio";
import { CommentIcon, HeartIcon } from "./InstagramIcons";

interface InstagramGridProps {
  items: InstagramMediaItem[];
  onSelect: (item: InstagramMediaItem, trigger: HTMLElement) => void;
}

const TYPE_LABEL: Record<InstagramMediaItem["mediaType"], string> = {
  IMAGE: "Foto",
  VIDEO: "Video",
  CAROUSEL_ALBUM: "Carrusel",
};

const TYPE_ICON: Partial<Record<InstagramMediaItem["mediaType"], string>> = {
  VIDEO: "▶",
  CAROUSEL_ALBUM: "❐",
};

export default function InstagramGrid({ items, onSelect }: InstagramGridProps) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
      {items.map((item) => {
        const icon = TYPE_ICON[item.mediaType];
        const isReel = item.productType === "REELS";
        const label = isReel ? "Reel" : TYPE_LABEL[item.mediaType];
        const description = item.caption ?? "Publicación de Instagram";
        const hasStats = item.likeCount !== undefined || item.commentsCount !== undefined;

        return (
          <button
            key={item.id}
            type="button"
            onClick={(event) => onSelect(item, event.currentTarget)}
            aria-haspopup="dialog"
            aria-label={`${label}: ${description}. Abrir publicación`}
            className="group relative aspect-[4/5] overflow-hidden rounded-md border border-transparent bg-bg-surface text-left transition-[border-color,box-shadow] hover:border-accent-primary/70 hover:shadow-glow-primary focus-visible:border-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
          >
            <img
              src={item.imageUrl}
              alt=""
              loading="lazy"
              // Proporción real del recurso: el modal se abre ya con el tamaño correcto.
              onLoad={(event) =>
                rememberAspectRatio(
                  item.id,
                  event.currentTarget.naturalWidth,
                  event.currentTarget.naturalHeight,
                )
              }
              className="h-full w-full object-cover transition-transform group-hover:scale-105"
            />
            {(icon || isReel) && (
              <span
                aria-hidden="true"
                className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white"
              >
                {isReel ? "Reel ▶" : icon}
              </span>
            )}
            {(hasStats || item.caption) && (
              <span
                aria-hidden="true"
                className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/85 to-transparent p-2 pt-10 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              >
                {hasStats && (
                  <span className="flex gap-3 font-semibold">
                    {item.likeCount !== undefined && (
                      <span className="inline-flex items-center gap-1">
                        <HeartIcon /> {item.likeCount}
                      </span>
                    )}
                    {item.commentsCount !== undefined && (
                      <span className="inline-flex items-center gap-1">
                        <CommentIcon /> {item.commentsCount}
                      </span>
                    )}
                  </span>
                )}
                {item.caption && <span className="line-clamp-2">{item.caption}</span>}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
