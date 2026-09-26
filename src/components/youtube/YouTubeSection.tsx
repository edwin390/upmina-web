import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { YouTubeVideo } from "@/types";
import {
  YOUTUBE_SHORTS_LIMIT,
  YOUTUBE_VIDEOS_LIMIT,
  useLatestYouTubeVideo,
  useYouTubeVideos,
} from "@/hooks/useYouTubeVideos";
import { useSearchParam } from "@/hooks/useSearchParam";
import { useContentNotice } from "@/hooks/useContentNotice";
import { isYouTubeVideoId } from "@/lib/deep-links";
import ContentNotice from "@/components/ui/ContentNotice";
import HeroVideo from "./HeroVideo";
import ShortsViewer from "./ShortsViewer";
import VideoGrid from "./VideoGrid";

// Dos experiencias independientes (Fase 9H-2.5):
//   - VIDEOS LARGOS: el último video y "Más videos" comparten el reproductor principal. Su selección
//     es la URL (?video=<id>), y ese reproductor solo acepta videos largos.
//   - SHORTS: un visor vertical propio (ShortsViewer) con selección local. Un Short nunca entra en
//     el reproductor principal ni toca ?video=, y elegir un video largo no cambia el Short.
// Enlaces a un Short: ?short=<id> (Home) y, por compatibilidad con enlaces ya compartidos,
// ?video=<id de un Short>. Ambos solo eligen el Short en su visor y se retiran de la URL; nunca
// reproducen el Short en el hero.

const SHORTS_HEADING_ID = "youtube-shorts-heading";

interface VideoGroupProps {
  title: string;
  loadingText: string;
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
          selectedVideoId={selectedVideoId}
          onSelect={onSelect}
        />
      )}
    </>
  );
}

interface ShortsGroupProps {
  shorts: YouTubeVideo[] | undefined;
  isLoading: boolean;
  isError: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  anchorRef: RefObject<HTMLDivElement | null>;
}

// Mismos estados que VideoGroup (carga, vacío intencional, fallo aislado), con el visor vertical
// en lugar de la rejilla.
function ShortsGroup({
  shorts,
  isLoading,
  isError,
  selectedId,
  onSelect,
  anchorRef,
}: ShortsGroupProps) {
  const hasShorts = !!shorts && shorts.length > 0;
  const showError = isError && !hasShorts;
  if (!isLoading && !hasShorts && !showError) return null;

  return (
    <div ref={anchorRef}>
      <h3
        id={SHORTS_HEADING_ID}
        className="mb-4 mt-10 text-lg font-semibold text-text-primary"
      >
        Shorts
      </h3>
      {isLoading && <p className="text-text-muted">Cargando Shorts…</p>}
      {showError && (
        <p role="status" className="text-text-muted">
          No se pudieron cargar los Shorts de YouTube ahora mismo. Inténtalo de nuevo más
          tarde.
        </p>
      )}
      {hasShorts && (
        <ShortsViewer
          shorts={shorts}
          selectedId={selectedId}
          onSelect={onSelect}
          headingId={SHORTS_HEADING_ID}
        />
      )}
    </div>
  );
}

export default function YouTubeSection() {
  const latestQuery = useLatestYouTubeVideo();
  const videosQuery = useYouTubeVideos(YOUTUBE_VIDEOS_LIMIT, "videos");
  const shortsQuery = useYouTubeVideos(YOUTUBE_SHORTS_LIMIT, "shorts");
  const { data: latest } = latestQuery;
  const { data: videos, isLoading: isLoadingVideos } = videosQuery;
  const { isLoading: isLoadingShorts } = shortsQuery;
  // Un id que no parece de YouTube nunca llega a un reproductor ni a un enlace.
  const shorts = useMemo(
    () => shortsQuery.data?.filter((v) => isYouTubeVideoId(v.id)),
    [shortsQuery.data],
  );

  // La URL (?video=<id>) es la única fuente de verdad del video LARGO; sin ella, el último video.
  const [videoParam, setVideoParam] = useSearchParam("video");
  const [shortParam, setShortParam] = useSearchParam("short");
  const notice = useContentNotice();
  const requestedId = isYouTubeVideoId(videoParam) ? videoParam : null;
  const requestedShortId = isYouTubeVideoId(shortParam) ? shortParam : null;

  // Selección local de Short: independiente del reproductor principal y de la URL.
  const [shortId, setShortId] = useState<string | null>(null);
  const shortsAnchorRef = useRef<HTMLDivElement | null>(null);

  // /api/youtube-latest devuelve el ÚLTIMO UPLOAD sea cual sea su tipo: puede ser un Short. Si lo
  // es (está en la lista de Shorts), el destacado pasa a ser el primer video largo; el hero nunca
  // muestra un Short. Sin lista de Shorts (falló) no puede saberse y se conserva el último.
  const latestIsShort = !!latest && !!shorts?.some((v) => v.id === latest.id);
  const featured = latestIsShort ? videos?.[0] : latest;

  // El reproductor principal SOLO acepta videos largos del propio canal: el id debe estar en
  // "Más videos" o ser el destacado. Un Short jamás se resuelve aquí.
  const requested = useMemo(() => {
    if (!requestedId) return undefined;
    return (
      videos?.find((v) => v.id === requestedId) ??
      (featured?.id === requestedId ? featured : undefined)
    );
  }, [requestedId, videos, featured]);

  // Enlaces antiguos ?video=<Short>: el id no es un video largo pero sí un Short conocido.
  const legacyShortId =
    requestedId && !requested && shorts?.some((v) => v.id === requestedId)
      ? requestedId
      : null;
  const incomingShortId = requestedShortId ?? legacyShortId;
  const incomingShortKnown = incomingShortId
    ? !!shorts?.some((v) => v.id === incomingShortId)
    : false;

  // Solo se concluye "ya no está" con las tres consultas resueltas con éxito: mientras cargan,
  // o si alguna falla (fallo temporal), el deep link se conserva.
  const allSettled =
    latestQuery.isSuccess && videosQuery.isSuccess && shortsQuery.isSuccess;
  const stillLoading =
    latestQuery.isPending || videosQuery.isPending || shortsQuery.isPending;
  const unavailable =
    videoParam !== null &&
    (requestedId === null || (!requested && !legacyShortId && allSettled));
  // ?short=: malformado, o ausente de la lista ya cargada con éxito.
  const shortUnavailable =
    shortParam !== null &&
    (requestedShortId === null || (shortsQuery.isSuccess && !incomingShortKnown));

  const showNotice = notice.show;
  useEffect(() => {
    if (!unavailable) return;
    showNotice();
    setVideoParam(null);
  }, [unavailable, showNotice, setVideoParam]);

  useEffect(() => {
    if (!shortUnavailable) return;
    showNotice();
    setShortParam(null);
  }, [shortUnavailable, showNotice, setShortParam]);

  // Un enlace a un Short conocido lo elige en su visor y se retira de la URL (sin aviso).
  useEffect(() => {
    if (!incomingShortId || !incomingShortKnown) return;
    setShortId(incomingShortId);
    if (requestedShortId) setShortParam(null);
    else setVideoParam(null);
    shortsAnchorRef.current?.scrollIntoView?.({ block: "start" });
  }, [
    incomingShortId,
    incomingShortKnown,
    requestedShortId,
    setShortParam,
    setVideoParam,
  ]);

  // Con un id válido aún sin resolver no se monta el último video (evita cargar uno equivocado).
  // Un id que resulta ser un Short no espera: no se reproducirá en el hero.
  const waitingForRequested =
    requestedId !== null && !requested && !legacyShortId && stillLoading;
  const activeVideo = requested ?? featured;
  // Mientras no se sabe si el último upload es un Short (lista de Shorts pendiente) o hace falta la
  // lista de videos para sustituirlo, se muestra un marcador en lugar de montar un Short en el hero.
  // Si el último ya aparece en "Más videos" es un video largo seguro: se muestra sin esperar a los
  // Shorts (una consulta lenta de Shorts no retrasa el reproductor principal en el caso normal).
  const latestInVideos = !!latest && !!videos?.some((v) => v.id === latest.id);
  const checkingLatest =
    !requested &&
    !!latest &&
    ((!latestInVideos && !latestIsShort && shortsQuery.isPending) ||
      (latestIsShort && videosQuery.isPending));
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
          {waitingForRequested || checkingLatest ? (
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

          <ShortsGroup
            shorts={shorts}
            isLoading={isLoadingShorts}
            isError={shortsQuery.isError}
            selectedId={shortId}
            onSelect={setShortId}
            anchorRef={shortsAnchorRef}
          />
        </>
      )}
    </section>
  );
}
