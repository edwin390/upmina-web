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
  isError: boolean;
  errorText: string;
  selectedVideoId: string;
  onSelect: (id: string) => void;
}

// Una lista vacía y válida no pinta el grupo (vacío intencional). Un FALLO de la API sí se
// comunica, con un texto breve y sin detalles técnicos, para no confundirlo con un canal sin
// contenido; el resto de la sección sigue funcionando.
function VideoGroup({
  title,
  loadingText,
  variant,
  videos,
  isLoading,
  isError,
  errorText,
  selectedVideoId,
  onSelect,
}: VideoGroupProps) {
  const hasVideos = !!videos && videos.length > 0;
  const showError = isError && !hasVideos;
  if (!isLoading && !hasVideos && !showError) return null;

  return (
    <>
      <h3 className="mb-4 mt-10 text-lg font-semibold text-text-primary">{title}</h3>
      {isLoading && <p className="text-text-muted">{loadingText}</p>}
      {showError && (
        <p role="status" className="text-text-muted">
          {errorText}
        </p>
      )}
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
  // Fallo del último video (sin uno solicitado que mostrar): se avisa en su hueco. Un canal sin
  // subidas (404 → null) no es un fallo y no muestra nada.
  const latestFailed = latestQuery.isError && !activeVideo && !waitingForRequested;
  // Si las tres consultas fallan se muestra un único aviso en lugar de tres.
  const allFailed = latestQuery.isError && videosQuery.isError && shortsQuery.isError;
  const selectedId = waitingForRequested ? "" : (activeVideo?.id ?? "");

  return (
    <section className="mx-auto max-w-6xl px-4 py-16">
      <h2 className="mb-6 font-display text-3xl tracking-wide">YOUTUBE</h2>

      {notice.visible && <ContentNotice />}

      {allFailed && !activeVideo ? (
        <p role="status" className="text-text-muted">
          No se pudo cargar el contenido de YouTube ahora mismo. Inténtalo de nuevo más
          tarde.
        </p>
      ) : (
        <>
          {waitingForRequested ? (
            <div
              aria-hidden="true"
              className="aspect-video w-full animate-pulse rounded-lg border border-border-subtle bg-bg-surface"
            />
          ) : latestFailed ? (
            <div
              role="status"
              className="flex aspect-video items-center justify-center rounded-lg border border-border-subtle bg-bg-surface px-4 text-center text-text-muted"
            >
              No se pudo cargar el último video de YouTube ahora mismo.
            </div>
          ) : (
            activeVideo && <HeroVideo video={activeVideo} />
          )}

          <VideoGroup
            title="Más videos"
            loadingText="Cargando videos…"
            errorText="No se pudieron cargar los videos de YouTube ahora mismo. Inténtalo de nuevo más tarde."
            videos={videos}
            isLoading={isLoadingVideos}
            isError={videosQuery.isError}
            selectedVideoId={selectedId}
            onSelect={setVideoParam}
          />

          <VideoGroup
            title="Shorts"
            loadingText="Cargando Shorts…"
            errorText="No se pudieron cargar los Shorts de YouTube ahora mismo. Inténtalo de nuevo más tarde."
            variant="short"
            videos={shorts}
            isLoading={isLoadingShorts}
            isError={shortsQuery.isError}
            selectedVideoId={selectedId}
            onSelect={setVideoParam}
          />
        </>
      )}
    </section>
  );
}
