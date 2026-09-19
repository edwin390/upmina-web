import { useState, useMemo } from "react";
import { useLatestYouTubeVideo, useYouTubeVideos } from "@/hooks/useYouTubeVideos";
import HeroVideo from "./HeroVideo";
import VideoGrid from "./VideoGrid";

export default function YouTubeSection() {
  const { data: latest } = useLatestYouTubeVideo();
  const { data: videos, isLoading } = useYouTubeVideos(12);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);

  const activeVideo = useMemo(() => {
    if (selectedVideoId) {
      return videos?.find((v) => v.id === selectedVideoId) ?? latest;
    }
    return latest;
  }, [selectedVideoId, videos, latest]);

  return (
    <section className="mx-auto max-w-6xl px-4 py-16">
      <h2 className="mb-6 font-display text-3xl tracking-wide">YOUTUBE</h2>

      {activeVideo && <HeroVideo video={activeVideo} />}

      <h3 className="mb-4 mt-10 text-lg font-semibold text-text-primary">Más videos</h3>

      {isLoading && <p className="text-text-muted">Cargando videos…</p>}

      {videos && (
        <VideoGrid
          videos={videos}
          selectedVideoId={activeVideo?.id ?? ""}
          onSelect={setSelectedVideoId}
        />
      )}
    </section>
  );
}
