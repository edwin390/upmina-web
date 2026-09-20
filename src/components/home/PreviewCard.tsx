import { Link } from "react-router-dom";
import { CARD_CLASS } from "./cardStyles";

interface PreviewCardProps {
  to: string;
  /** Plataforma y tipo, p. ej. "YouTube · Short". */
  badge: string;
  title: string;
  thumbnailUrl?: string;
  /** Miniatura vertical 9:16 (Shorts) centrada sobre un fondo difuminado. */
  vertical?: boolean;
  duration?: string;
  meta?: string;
  cta: string;
  /** Proporción de la miniatura (por defecto 16:9). */
  mediaClassName?: string;
}

export default function PreviewCard({
  to,
  badge,
  title,
  thumbnailUrl,
  vertical = false,
  duration,
  meta,
  cta,
  mediaClassName = "aspect-video",
}: PreviewCardProps) {
  return (
    <Link to={to} className={CARD_CLASS}>
      <div className={`relative overflow-hidden bg-bg-elevated ${mediaClassName}`}>
        {thumbnailUrl &&
          (vertical ? (
            <>
              <img
                src={thumbnailUrl}
                alt=""
                aria-hidden="true"
                className="absolute inset-0 h-full w-full scale-125 object-cover opacity-40 blur-xl"
              />
              <img
                src={thumbnailUrl}
                alt=""
                className="relative mx-auto aspect-[9/16] h-full object-cover"
              />
            </>
          ) : (
            <img src={thumbnailUrl} alt="" className="h-full w-full object-cover" />
          ))}
        <span className="absolute left-2 top-2 rounded bg-accent-primary px-2 py-0.5 text-xs font-semibold text-text-inverse">
          {badge}
        </span>
        {duration && (
          <span className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-xs text-white">
            {duration}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col p-3">
        <p className="line-clamp-2 text-sm font-medium text-text-primary">{title}</p>
        {meta && <p className="mt-1 text-xs text-text-muted">{meta}</p>}
        <span className="mt-auto pt-3 text-sm font-semibold text-accent-primary transition-transform duration-200 group-hover:translate-x-1">
          {cta} →
        </span>
      </div>
    </Link>
  );
}

export function PreviewCardSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-lg border border-border-subtle bg-bg-surface"
    >
      <div className="aspect-video animate-pulse bg-bg-elevated" />
      <div className="space-y-2 p-3">
        <div className="h-4 w-4/5 animate-pulse rounded bg-bg-elevated" />
        <div className="h-3 w-1/3 animate-pulse rounded bg-bg-elevated" />
      </div>
    </div>
  );
}
