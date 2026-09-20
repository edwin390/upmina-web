import { useTwitchStatus } from "@/hooks/useTwitchStatus";
import { useTwitchClips, TwitchClipsError } from "@/hooks/useTwitchClips";
import { useTwitchLatestVideo } from "@/hooks/useTwitchLatestVideo";
import { formatRelativeDate, parseTwitchDuration } from "@/lib/format";
import LiveBadge, { type LiveBadgeStatus } from "./LiveBadge";
import TwitchPlayer from "./TwitchPlayer";
import TwitchClip from "./TwitchClip";

export default function TwitchSection() {
  const {
    data: status,
    isLoading: statusLoading,
    isError: statusError,
  } = useTwitchStatus();
  const {
    data: latestVideo,
    isLoading: latestVideoLoading,
    isError: latestVideoError,
  } = useTwitchLatestVideo();
  const { data: clips, isLoading: clipsLoading, error: clipsErrorObj } = useTwitchClips();

  const badgeStatus: LiveBadgeStatus = statusLoading
    ? "loading"
    : statusError
      ? "error"
      : status?.isLive
        ? "live"
        : "offline";

  // "No configurado" (503) es un problema distinto de un fallo temporal de
  // Twitch (502, 429, etc.): no hay que decirle al usuario que falta
  // configuración cuando en realidad Twitch está caído.
  const clipsErrorMessage = clipsErrorObj
    ? clipsErrorObj instanceof TwitchClipsError && clipsErrorObj.status === 503
      ? "No se pudo configurar la conexión con Twitch."
      : "No se pudieron cargar los clips. Inténtalo de nuevo más tarde."
    : null;

  // Mientras no sepamos qué canal se está consultando (carga inicial o
  // error), no inventamos uno: se cae a la home de Twitch en vez de
  // apuntar a un canal que podría no ser el configurado.
  const channelUrl = status?.channel
    ? `https://www.twitch.tv/${status.channel}`
    : "https://www.twitch.tv";

  // Distingue "todavía estamos preguntando", "falló la consulta" y
  // "consultamos con éxito, pero no hay ni directo ni VOD que mostrar" (canal
  // sin streams grabados). Antes de esta corrección, este último caso se
  // mostraba como "Cargando..." para siempre.
  const isLoadingVideo = statusLoading || latestVideoLoading;
  const hasVideoError = statusError || latestVideoError;
  const videoPlaceholderMessage = isLoadingVideo
    ? "Cargando contenido de Twitch..."
    : hasVideoError
      ? "No se pudo cargar el contenido de Twitch."
      : "Todavía no hay contenido de Twitch disponible.";

  return (
    <section
      id="twitch"
      className="relative mx-auto max-w-6xl overflow-hidden px-4 py-16"
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-40 bg-[radial-gradient(ellipse_at_top,rgba(255,45,149,0.14),transparent_70%)]"
        aria-hidden="true"
      />
      <div className="mb-6 flex items-center justify-between">
        <h2 className="font-display text-3xl tracking-wide">TWITCH</h2>
        <LiveBadge status={badgeStatus} viewerCount={status?.viewerCount} />
      </div>

      <div className="mb-10">
        {status?.isLive ? (
          <>
            <TwitchPlayer channel={status.channel} title="Directo de Twitch" />
            {status.title && <p className="mt-3 text-text-secondary">{status.title}</p>}
          </>
        ) : latestVideo ? (
          <>
            <TwitchPlayer videoId={latestVideo.id} title="Último stream de Twitch" />
            <p className="mt-3 text-text-secondary">{latestVideo.title}</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-text-muted">
              <span>Último stream grabado</span>
              <span aria-hidden="true">·</span>
              <span>{formatRelativeDate(latestVideo.createdAt)}</span>
              <span aria-hidden="true">·</span>
              <span>{parseTwitchDuration(latestVideo.duration)}</span>
              <span aria-hidden="true">·</span>
              <a
                href={latestVideo.url}
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium text-accent-primary hover:underline"
              >
                Ver en Twitch
              </a>
            </p>
          </>
        ) : (
          <div
            role="status"
            className="flex aspect-video items-center justify-center rounded-lg border border-border-subtle bg-bg-surface text-text-muted"
          >
            {videoPlaceholderMessage}
          </div>
        )}
        {statusError && (
          <p className="mt-3 text-sm text-text-muted">
            No se pudo consultar el estado en vivo. Puedes ver el canal directamente en
            Twitch.
          </p>
        )}
      </div>

      <div className="mb-4 flex items-center justify-between gap-4">
        <h3 className="text-lg font-semibold text-text-primary">Últimos clips</h3>
        <a
          href={channelUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-accent-primary hover:underline"
        >
          Ver canal
        </a>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {clipsLoading && <p className="text-text-muted">Cargando clips…</p>}
        {clipsErrorMessage && (
          <p role="status" className="text-sm text-text-muted">
            {clipsErrorMessage}
          </p>
        )}
        {!clipsLoading && !clipsErrorMessage && clips?.length === 0 && (
          <p className="text-sm text-text-muted">Todavía no hay clips disponibles.</p>
        )}
        {clips?.map((clip) => (
          <TwitchClip key={clip.id} clip={clip} />
        ))}
      </div>
    </section>
  );
}
