import clsx from "clsx";

export type LiveBadgeStatus = "loading" | "live" | "offline" | "error";

interface LiveBadgeProps {
  status: LiveBadgeStatus;
  viewerCount?: number;
}

const STATUS_LABEL: Record<LiveBadgeStatus, string> = {
  loading: "Comprobando…",
  live: "EN VIVO",
  offline: "OFFLINE",
  error: "SIN DATOS",
};

export default function LiveBadge({ status, viewerCount }: LiveBadgeProps) {
  const isLive = status === "live";

  return (
    <div
      className={clsx(
        "flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold",
        isLive
          ? "bg-accent-live text-white shadow-glow-primary"
          : "bg-bg-elevated text-text-muted",
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          "relative h-2 w-2 rounded-full",
          isLive
            ? "live-ping bg-white"
            : status === "loading"
              ? "animate-pulse bg-text-muted"
              : "bg-text-muted",
        )}
      />
      {/* Solo el texto de estado se anuncia; el conteo de viewers cambia
          cada refetch (60s) y no debe generar anuncios repetidos. */}
      <span role="status" aria-live="polite">
        {STATUS_LABEL[status]}
      </span>
      {isLive && typeof viewerCount === "number" && (
        <span className="text-xs font-normal opacity-80">
          {viewerCount.toLocaleString("es")} viewers
        </span>
      )}
    </div>
  );
}
