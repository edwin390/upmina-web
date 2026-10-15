import { useTwitchClips } from "@/hooks/useTwitchClips";
import {
  YOUTUBE_SHORTS_LIMIT,
  YOUTUBE_VIDEOS_LIMIT,
  useYouTubeVideos,
} from "@/hooks/useYouTubeVideos";
import { useTranslations } from "use-intl";
import { useRelativeDate } from "@/i18n/useFormat";
import { twitchClipPath, youTubeShortPath, youTubeVideoPath } from "@/lib/deep-links";
import PreviewCard, { PreviewCardSkeleton } from "./PreviewCard";
import SectionHeading from "./SectionHeading";

// Máximo 3 elementos: el primer video y el primer Short, y el primer clip. Usa las MISMAS
// consultas (misma URL y queryKey, luego misma caché) que /youtube y /twitch, así el elemento
// enlazado con ?video= / ?clip= siempre está en las listas de esas secciones.
export default function LatestContentSection() {
  const t = useTranslations("site.latest");
  const relativeDate = useRelativeDate();
  const { data: videos, isLoading: videosLoading } = useYouTubeVideos(
    YOUTUBE_VIDEOS_LIMIT,
    "videos",
  );
  const { data: shorts, isLoading: shortsLoading } = useYouTubeVideos(
    YOUTUBE_SHORTS_LIMIT,
    "shorts",
  );
  const { data: clips, isLoading: clipsLoading } = useTwitchClips();

  const video = videos?.[0];
  const short = shorts?.[0];
  const clip = clips?.[0];

  // Lo que falle o venga vacío se omite; si no queda nada, la sección no se pinta.
  if (!videosLoading && !shortsLoading && !clipsLoading && !video && !short && !clip) {
    return null;
  }

  return (
    <section aria-labelledby="ultimo-contenido" className="mx-auto max-w-6xl px-4 py-10">
      <SectionHeading id="ultimo-contenido" title={t("title")} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
        {videosLoading ? (
          <PreviewCardSkeleton />
        ) : (
          video && (
            <PreviewCard
              to={youTubeVideoPath(video.id)}
              badge={t("video")}
              title={video.title}
              thumbnailUrl={video.thumbnailUrl}
              duration={video.duration}
              meta={relativeDate(video.publishedAt)}
              cta={t("videos")}
            />
          )
        )}
        {shortsLoading ? (
          <PreviewCardSkeleton />
        ) : (
          short && (
            <PreviewCard
              to={youTubeShortPath(short.id)}
              badge={t("short")}
              title={short.title}
              thumbnailUrl={short.thumbnailUrl}
              vertical
              duration={short.duration}
              meta={relativeDate(short.publishedAt)}
              cta={t("shorts")}
            />
          )
        )}
        {clipsLoading ? (
          <PreviewCardSkeleton />
        ) : (
          clip && (
            <PreviewCard
              to={twitchClipPath(clip.id)}
              badge={t("clip")}
              title={clip.title}
              thumbnailUrl={clip.thumbnailUrl}
              meta={`${clip.creatorName} · ${relativeDate(clip.createdAt)}`}
              cta={t("clips")}
            />
          )
        )}
      </div>
    </section>
  );
}
