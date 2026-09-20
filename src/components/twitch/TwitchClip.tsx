import type { TwitchClip as TwitchClipType } from "@/types";
import { formatRelativeDate } from "@/lib/format";

interface TwitchClipProps {
  clip: TwitchClipType;
}

export default function TwitchClip({ clip }: TwitchClipProps) {
  const parent = typeof window !== "undefined" ? window.location.hostname : "localhost";

  return (
    <div className="group overflow-hidden rounded-lg border border-border-subtle bg-bg-surface transition-[transform,box-shadow,border-color] duration-350 ease-bounce hover:-translate-y-2 hover:rotate-[-1deg] hover:border-accent-primary/70 hover:shadow-glow-primary">
      <div className="relative aspect-video overflow-hidden bg-bg-elevated">
        <iframe
          src={`${clip.embedUrl}&parent=${parent}`}
          title={clip.title}
          allowFullScreen
          loading="lazy"
          className="h-full w-full"
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-tr from-accent-primary/10 via-transparent to-white/10 opacity-0 transition-opacity duration-350 group-hover:opacity-100" />
      </div>
      <div className="p-3">
        <p className="line-clamp-2 text-sm font-medium text-text-primary">{clip.title}</p>
        <p className="mt-1 text-xs text-text-muted">
          {clip.creatorName} · {clip.viewCount.toLocaleString("es")}{" "}
          {clip.viewCount === 1 ? "vista" : "vistas"} ·{" "}
          {formatRelativeDate(clip.createdAt)}
        </p>
        {/* Alternativa oficial si el iframe embebido no carga (p. ej.
            bloqueadores de contenido) o el usuario prefiere abrir Twitch. */}
        <a
          href={clip.url}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-2 inline-block text-xs font-medium text-accent-primary hover:underline"
        >
          Ver en Twitch
        </a>
      </div>
    </div>
  );
}
