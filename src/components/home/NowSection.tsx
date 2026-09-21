import { Link } from "react-router-dom";
import clsx from "clsx";
import { useTwitchStatus } from "@/hooks/useTwitchStatus";
import { useTwitchLatestVideo } from "@/hooks/useTwitchLatestVideo";
import { useLatestYouTubeVideo } from "@/hooks/useYouTubeVideos";
import { formatRelativeDate, parseTwitchDuration } from "@/lib/format";
import { youTubeVideoPath } from "@/lib/deep-links";
import LiveBadge, { type LiveBadgeStatus } from "@/components/twitch/LiveBadge";
import PlatformIcon from "./PlatformIcon";
import PreviewCard, { PreviewCardSkeleton } from "./PreviewCard";
import SectionHeading from "./SectionHeading";
import { CARD_CLASS } from "./cardStyles";

// Resumen mínimo de Twitch: estado en directo + último VOD. Reutiliza los mismos
// hooks (y por tanto la misma caché) que TwitchSection, sin montar la sección.
function TwitchNow() {
  const {
    data: status,
    isLoading: statusLoading,
    isError: statusError,
  } = useTwitchStatus();
  const { data: latestVideo } = useTwitchLatestVideo();

  const badgeStatus: LiveBadgeStatus = statusLoading
    ? "loading"
    : statusError
      ? "error"
      : status?.isLive
        ? "live"
        : "offline";
  const isLive = badgeStatus === "live";
  const thumbnailUrl = isLive ? status?.thumbnailUrl : latestVideo?.thumbnailUrl;

  const headline = statusLoading
    ? "Comprobando el canal…"
    : statusError
      ? "No se pudo consultar el estado del canal"
      : isLive
        ? "Mina está en directo"
        : "Mina no está en directo ahora";

  return (
    <Link
      to="/twitch"
      className={clsx(CARD_CLASS, isLive && "border-accent-live/60 shadow-glow-primary")}
    >
      <div className="relative flex aspect-[2/1] items-center justify-center overflow-hidden bg-bg-elevated text-accent-primary/40">
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <PlatformIcon platform="twitch" className="h-16 w-16" />
        )}
        <span className="absolute left-2 top-2 rounded bg-accent-primary px-2 py-0.5 text-xs font-semibold text-text-inverse">
          Twitch · {isLive ? "En directo" : "Último stream"}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <LiveBadge status={badgeStatus} viewerCount={status?.viewerCount} />
        </div>
        <p className="font-display text-2xl leading-tight tracking-wide text-text-primary">
          {headline}
        </p>
        {isLive && status?.title && (
          <p className="line-clamp-2 text-sm text-text-secondary">{status.title}</p>
        )}
        {!isLive && !statusLoading && latestVideo && (
          <>
            <p className="line-clamp-2 text-sm text-text-secondary">
              {latestVideo.title}
            </p>
            <p className="text-xs text-text-muted">
              {formatRelativeDate(latestVideo.createdAt)} ·{" "}
              {parseTwitchDuration(latestVideo.duration)}
            </p>
          </>
        )}
        <span className="mt-auto pt-2 text-sm font-semibold text-accent-primary transition-transform duration-200 group-hover:translate-x-1">
          Ir a Twitch →
        </span>
      </div>
    </Link>
  );
}

function YouTubeNow() {
  const { data: video, isLoading } = useLatestYouTubeVideo();

  if (isLoading) return <PreviewCardSkeleton />;

  // Sin dato (error de la API o canal sin videos): tarjeta sencilla, nunca un error técnico.
  if (!video) {
    return (
      <Link to="/youtube" className={CARD_CLASS}>
        <div className="flex aspect-[2/1] items-center justify-center bg-bg-elevated text-accent-primary/40">
          <PlatformIcon platform="youtube" className="h-16 w-16" />
        </div>
        <div className="flex flex-1 flex-col gap-2 p-3">
          <p className="font-display text-2xl leading-tight tracking-wide text-text-primary">
            Videos y Shorts de Mina
          </p>
          <span className="mt-auto pt-2 text-sm font-semibold text-accent-primary">
            Ir a YouTube →
          </span>
        </div>
      </Link>
    );
  }

  return (
    <PreviewCard
      to={youTubeVideoPath(video.id)}
      badge="YouTube · Último video"
      title={video.title}
      thumbnailUrl={video.thumbnailUrl}
      duration={video.duration}
      meta={formatRelativeDate(video.publishedAt)}
      cta="Ver en YouTube"
      mediaClassName="aspect-[2/1]"
    />
  );
}

export default function NowSection() {
  return (
    <section aria-labelledby="ahora" className="mx-auto max-w-6xl px-4 py-10">
      <SectionHeading
        id="ahora"
        title="AHORA"
        subtitle="Lo último del canal, de un vistazo."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TwitchNow />
        <YouTubeNow />
      </div>
    </section>
  );
}
