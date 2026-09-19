import clsx from "clsx";

interface LiveBadgeProps {
  isLive: boolean;
  viewerCount?: number;
}

export default function LiveBadge({ isLive, viewerCount }: LiveBadgeProps) {
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
        className={clsx(
          "relative h-2 w-2 rounded-full",
          isLive ? "live-ping bg-white" : "bg-text-muted",
        )}
      />
      {isLive ? "EN VIVO" : "OFFLINE"}
      {isLive && typeof viewerCount === "number" && (
        <span className="text-xs font-normal opacity-80">
          {viewerCount.toLocaleString("es")} viewers
        </span>
      )}
    </div>
  );
}
