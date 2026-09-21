import { useTwitchClips } from "@/hooks/useTwitchClips";
import { useYouTubeVideos } from "@/hooks/useYouTubeVideos";
import { formatRelativeDate } from "@/lib/format";
import { twitchClipPath, youTubeVideoPath } from "@/lib/deep-links";
import PreviewCard, { PreviewCardSkeleton } from "./PreviewCard";
import SectionHeading from "./SectionHeading";

// Máximo 3 elementos: el primer video y el primer Short, y el primer clip. Usa las MISMAS
// consultas (misma URL y queryKey, luego misma caché) que /youtube y /twitch, así el elemento
// enlazado con ?video= / ?clip= siempre está en las listas de esas secciones.
export default function LatestContentSection() {
  const { data: videos, isLoading: videosLoading } = useYouTubeVideos(12, "videos");
  const { data: shorts, isLoading: shortsLoading } = useYouTubeVideos(12, "shorts");
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
      <SectionHeading id="ultimo-contenido" title="ÚLTIMO CONTENIDO" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
        {videosLoading ? (
          <PreviewCardSkeleton />
        ) : (
          video && (
            <PreviewCard
              to={youTubeVideoPath(video.id)}
              badge="YouTube · Video"
              title={video.title}
              thumbnailUrl={video.thumbnailUrl}
              duration={video.duration}
              meta={formatRelativeDate(video.publishedAt)}
              cta="Ver videos"
            />
          )
        )}
        {shortsLoading ? (
          <PreviewCardSkeleton />
        ) : (
          short && (
            <PreviewCard
              to={youTubeVideoPath(short.id)}
              badge="YouTube · Short"
              title={short.title}
              thumbnailUrl={short.thumbnailUrl}
              vertical
              duration={short.duration}
              meta={formatRelativeDate(short.publishedAt)}
              cta="Ver Shorts"
            />
          )
        )}
        {clipsLoading ? (
          <PreviewCardSkeleton />
        ) : (
          clip && (
            <PreviewCard
              to={twitchClipPath(clip.id)}
              badge="Twitch · Clip"
              title={clip.title}
              thumbnailUrl={clip.thumbnailUrl}
              meta={`${clip.creatorName} · ${formatRelativeDate(clip.createdAt)}`}
              cta="Ver clips"
            />
          )
        )}
      </div>
    </section>
  );
}
