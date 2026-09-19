import type { YouTubeVideo } from "@/types";
import { formatRelativeDate } from "@/lib/format";

interface HeroVideoProps {
  video: YouTubeVideo;
}

export default function HeroVideo({ video }: HeroVideoProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border-subtle shadow-glow-primary">
      <div className="aspect-video w-full">
        <iframe
          src={`https://www.youtube.com/embed/${video.id}`}
          title={video.title}
          allowFullScreen
          loading="lazy"
          className="h-full w-full"
        />
      </div>
      <div className="bg-bg-surface p-4">
        <p className="font-display text-xl tracking-wide text-text-primary md:text-2xl">
          {video.title}
        </p>
        <p className="mt-1 text-sm text-text-secondary">
          {formatRelativeDate(video.publishedAt)} · {video.duration}
        </p>
      </div>
    </div>
  );
}
