import { useState, useMemo } from "react";
import type { YouTubeVideo } from "@/types";
import { useLatestYouTubeVideo, useYouTubeVideos } from "@/hooks/useYouTubeVideos";
import HeroVideo from "./HeroVideo";
import VideoGrid from "./VideoGrid";

interface VideoGroupProps {
  title: string;
  loadingText: string;
  variant?: "video" | "short";
  videos: YouTubeVideo[] | undefined;
  isLoading: boolean;
  selectedVideoId: string;
  onSelect: (id: string) => void;
}

// Sin datos (lista vacía o error de la API) el grupo no se pinta: nunca se
// muestran errores técnicos y el resto de la sección sigue funcionando.
function VideoGroup({
  title,
  loadingText,
  variant,
  videos,
  isLoading,
  selectedVideoId,
  onSelect,
}: VideoGroupProps) {
  const hasVideos = !!videos && videos.length > 0;
  if (!isLoading && !hasVideos) return null;

  return (
    <>
      <h3 className="mb-4 mt-10 text-lg font-semibold text-text-primary">{title}</h3>
      {isLoading && <p className="text-text-muted">{loadingText}</p>}
      {hasVideos && (
        <VideoGrid
          videos={videos}
          variant={variant}
          selectedVideoId={selectedVideoId}
          onSelect={onSelect}
        />
      )}
    </>
  );
}

export default function YouTubeSection() {
  const { data: latest } = useLatestYouTubeVideo();
  const { data: videos, isLoading: isLoadingVideos } = useYouTubeVideos(12, "videos");
  const { data: shorts, isLoading: isLoadingShorts } = useYouTubeVideos(12, "shorts");
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);

  const activeVideo = useMemo(() => {
    if (selectedVideoId) {
      return (
        videos?.find((v) => v.id === selectedVideoId) ??
        shorts?.find((v) => v.id === selectedVideoId) ??
        latest
      );
    }
    return latest;
  }, [selectedVideoId, videos, shorts, latest]);

  return (
    <section className="mx-auto max-w-6xl px-4 py-16">
      <h2 className="mb-6 font-display text-3xl tracking-wide">YOUTUBE</h2>

      {activeVideo && <HeroVideo video={activeVideo} />}

      <VideoGroup
        title="Más videos"
        loadingText="Cargando videos…"
        videos={videos}
        isLoading={isLoadingVideos}
        selectedVideoId={activeVideo?.id ?? ""}
        onSelect={setSelectedVideoId}
      />

      <VideoGroup
        title="Shorts"
        loadingText="Cargando Shorts…"
        variant="short"
        videos={shorts}
        isLoading={isLoadingShorts}
        selectedVideoId={activeVideo?.id ?? ""}
        onSelect={setSelectedVideoId}
      />
    </section>
  );
}
