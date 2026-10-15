import { Link } from "react-router-dom";
import clsx from "clsx";
import { useTwitchStatus } from "@/hooks/useTwitchStatus";
import { useTwitchLatestVideo } from "@/hooks/useTwitchLatestVideo";
import { useLatestYouTubeVideo } from "@/hooks/useYouTubeVideos";
import { parseTwitchDuration } from "@/lib/format";
import { useTranslations } from "use-intl";
import { useRelativeDate } from "@/i18n/useFormat";
import { youTubeVideoPath } from "@/lib/deep-links";
import LiveBadge, { type LiveBadgeStatus } from "@/components/twitch/LiveBadge";
import PlatformIcon from "./PlatformIcon";
import PreviewCard, { PreviewCardSkeleton } from "./PreviewCard";
import SectionHeading from "./SectionHeading";
import { CARD_CLASS } from "./cardStyles";

// Resumen mínimo de Twitch: estado en directo + último VOD. Reutiliza los mismos
// hooks (y por tanto la misma caché) que TwitchSection, sin montar la sección.
function TwitchNow() {
  const t = useTranslations("site.now");
  const relativeDate = useRelativeDate();
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
    ? t("checking")
    : statusError
      ? t("statusError")
      : isLive
        ? t("live")
        : t("offline");

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
          {isLive ? t("twitchLive") : t("twitchLast")}
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
              {relativeDate(latestVideo.createdAt)} ·{" "}
              {parseTwitchDuration(latestVideo.duration)}
            </p>
          </>
        )}
        <span className="mt-auto pt-2 text-sm font-semibold text-accent-primary transition-transform duration-200 group-hover:translate-x-1">
          {t("goTwitch")}
        </span>
      </div>
    </Link>
  );
}

function YouTubeNow() {
  const t = useTranslations("site.now");
  const relativeDate = useRelativeDate();
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
            {t("youtubeFallback")}
          </p>
          <span className="mt-auto pt-2 text-sm font-semibold text-accent-primary">
            {t("goYoutube")}
          </span>
        </div>
      </Link>
    );
  }

  return (
    <PreviewCard
      to={youTubeVideoPath(video.id)}
      badge={t("youtubeBadge")}
      title={video.title}
      thumbnailUrl={video.thumbnailUrl}
      duration={video.duration}
      meta={relativeDate(video.publishedAt)}
      cta={t("watchYoutube")}
      mediaClassName="aspect-[2/1]"
    />
  );
}

export default function NowSection() {
  const t = useTranslations("site.now");
  return (
    <section aria-labelledby="ahora" className="mx-auto max-w-6xl px-4 py-10">
      <SectionHeading id="ahora" title={t("title")} subtitle={t("subtitle")} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TwitchNow />
        <YouTubeNow />
      </div>
    </section>
  );
}
