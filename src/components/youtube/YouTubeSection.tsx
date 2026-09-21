import { useEffect, useMemo } from "react";
import type { YouTubeVideo } from "@/types";
import { useLatestYouTubeVideo, useYouTubeVideos } from "@/hooks/useYouTubeVideos";
import { useSearchParam } from "@/hooks/useSearchParam";
import { useContentNotice } from "@/hooks/useContentNotice";
import { isYouTubeVideoId } from "@/lib/deep-links";
import ContentNotice from "@/components/ui/ContentNotice";
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
  const latestQuery = useLatestYouTubeVideo();
  const videosQuery = useYouTubeVideos(12, "videos");
  const shortsQuery = useYouTubeVideos(12, "shorts");
  const { data: latest } = latestQuery;
  const { data: videos, isLoading: isLoadingVideos } = videosQuery;
  const { data: shorts, isLoading: isLoadingShorts } = shortsQuery;

  // La URL (?video=<id>) es la única fuente de verdad de la selección; sin ella, el último video.
  const [videoParam, setVideoParam] = useSearchParam("video");
  const notice = useContentNotice();
  const requestedId = isYouTubeVideoId(videoParam) ? videoParam : null;

  // Solo se reproduce contenido del propio canal: el id debe estar en las listas (o ser el último).
  const requested = useMemo(() => {
    if (!requestedId) return undefined;
    return (
      videos?.find((v) => v.id === requestedId) ??
      shorts?.find((v) => v.id === requestedId) ??
      (latest?.id === requestedId ? latest : undefined)
    );
  }, [requestedId, videos, shorts, latest]);

  // Solo se concluye "ya no está" con las tres consultas resueltas con éxito: mientras cargan,
  // o si alguna falla (fallo temporal), el deep link se conserva.
  const allSettled =
    latestQuery.isSuccess && videosQuery.isSuccess && shortsQuery.isSuccess;
  const stillLoading =
    latestQuery.isPending || videosQuery.isPending || shortsQuery.isPending;
  const unavailable =
    videoParam !== null && (requestedId === null || (!requested && allSettled));

  const showNotice = notice.show;
  useEffect(() => {
    if (!unavailable) return;
    showNotice();
    setVideoParam(null);
  }, [unavailable, showNotice, setVideoParam]);

  // Con un id válido aún sin resolver no se monta el último video (evita cargar uno equivocado).
  const waitingForRequested = requestedId !== null && !requested && stillLoading;
  const activeVideo = requested ?? latest;
  const selectedId = waitingForRequested ? "" : (activeVideo?.id ?? "");

  return (
    <section className="mx-auto max-w-6xl px-4 py-16">
      <h2 className="mb-6 font-display text-3xl tracking-wide">YOUTUBE</h2>

      {notice.visible && <ContentNotice />}

      {waitingForRequested ? (
        <div
          aria-hidden="true"
          className="aspect-video w-full animate-pulse rounded-lg border border-border-subtle bg-bg-surface"
        />
      ) : (
        activeVideo && <HeroVideo video={activeVideo} />
      )}

      <VideoGroup
        title="Más videos"
        loadingText="Cargando videos…"
        videos={videos}
        isLoading={isLoadingVideos}
        selectedVideoId={selectedId}
        onSelect={setVideoParam}
      />

      <VideoGroup
        title="Shorts"
        loadingText="Cargando Shorts…"
        variant="short"
        videos={shorts}
        isLoading={isLoadingShorts}
        selectedVideoId={selectedId}
        onSelect={setVideoParam}
      />
    </section>
  );
}
