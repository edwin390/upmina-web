import { useTwitchStatus } from "@/hooks/useTwitchStatus";
import { useTwitchClips } from "@/hooks/useTwitchClips";
import { useTwitchLatestVideo } from "@/hooks/useTwitchLatestVideo";
import LiveBadge from "./LiveBadge";
import TwitchPlayer from "./TwitchPlayer";
import TwitchClip from "./TwitchClip";

const CHANNEL = "upminaa";

export default function TwitchSection() {
  const { data: status, isError: statusError } = useTwitchStatus();
  const { data: latestVideo, isError: latestVideoError } = useTwitchLatestVideo();
  const { data: clips, isLoading: clipsLoading, isError: clipsError } = useTwitchClips();

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
        <LiveBadge isLive={status?.isLive ?? false} viewerCount={status?.viewerCount} />
      </div>

      <div className="mb-10">
        {status?.isLive ? (
          <>
            <TwitchPlayer channel={CHANNEL} title="Directo de Twitch" />
            {status.title && <p className="mt-3 text-text-secondary">{status.title}</p>}
          </>
        ) : latestVideo ? (
          <>
            <TwitchPlayer videoId={latestVideo.id} title="Último stream de Twitch" />
            <p className="mt-3 text-text-secondary">{latestVideo.title}</p>
            <p className="mt-1 text-sm text-text-muted">Último stream grabado</p>
          </>
        ) : (
          <div className="flex aspect-video items-center justify-center rounded-lg border border-border-subtle bg-bg-surface text-text-muted">
            {latestVideoError || statusError
              ? "No se pudo cargar el contenido de Twitch."
              : "Cargando contenido de Twitch..."}
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
          href={`https://www.twitch.tv/${CHANNEL}`}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-accent-primary hover:underline"
        >
          Ver canal
        </a>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {clipsLoading && <p className="text-text-muted">Cargando clips…</p>}
        {clipsError && (
          <p className="text-sm text-text-muted">
            Los clips estarán disponibles cuando se configure la conexión con Twitch.
          </p>
        )}
        {!clipsLoading && !clipsError && clips?.length === 0 && (
          <p className="text-sm text-text-muted">Todavía no hay clips disponibles.</p>
        )}
        {clips?.map((clip) => (
          <TwitchClip key={clip.id} clip={clip} />
        ))}
      </div>
    </section>
  );
}
