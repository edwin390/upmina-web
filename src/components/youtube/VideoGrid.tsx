import clsx from "clsx";
import type { YouTubeVideo } from "@/types";
import VideoCard from "./VideoCard";

interface VideoGridProps {
  videos: YouTubeVideo[];
  selectedVideoId: string;
  onSelect: (id: string) => void;
  /** "short" usa tarjetas verticales 9:16 en una rejilla más densa. */
  variant?: "video" | "short";
}

export default function VideoGrid({
  videos,
  selectedVideoId,
  onSelect,
  variant = "video",
}: VideoGridProps) {
  return (
    <div
      className={clsx(
        "grid gap-4",
        variant === "short"
          ? "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
          : "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4",
      )}
    >
      {videos.map((video) => (
        <VideoCard
          key={video.id}
          video={video}
          isSelected={video.id === selectedVideoId}
          onSelect={onSelect}
          vertical={variant === "short"}
        />
      ))}
    </div>
  );
}
