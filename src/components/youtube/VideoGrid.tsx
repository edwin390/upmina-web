import type { YouTubeVideo } from "@/types";
import VideoCard from "./VideoCard";

interface VideoGridProps {
  videos: YouTubeVideo[];
  selectedVideoId: string;
  onSelect: (id: string) => void;
}

export default function VideoGrid({ videos, selectedVideoId, onSelect }: VideoGridProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
      {videos.map((video) => (
        <VideoCard
          key={video.id}
          video={video}
          isSelected={video.id === selectedVideoId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
