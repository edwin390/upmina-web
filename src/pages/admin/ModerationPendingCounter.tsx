import { useTranslations } from "use-intl";

// R5-H: contador de casos pendientes (agregado del servidor). Distingue carga, cero y error; con un
// valor previo lo mantiene visible mientras se actualiza (sin parpadeo).
export type PendingState =
  | { kind: "loading"; count: number | null }
  | { kind: "ready"; count: number }
  | { kind: "error"; count: number | null };

export default function ModerationPendingCounter({
  state,
  onRetry,
}: {
  state: PendingState;
  onRetry: () => void;
}) {
  const t = useTranslations("moderation.pending");
  return (
    <div
      role="group"
      aria-label={t("label")}
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      {state.count !== null && state.kind !== "error" && (
        <span
          aria-live="polite"
          data-count={state.count}
          className="rounded-full border border-border-subtle px-3 py-1 font-semibold"
        >
          {state.count === 0 ? t("zero") : t("count", { count: state.count })}
        </span>
      )}
      {state.kind === "loading" && state.count === null && (
        <span aria-live="polite" className="text-text-muted">
          {t("loading")}
        </span>
      )}
      {state.kind === "error" && (
        <>
          <span role="alert">{t("error")}</span>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex min-h-11 items-center rounded-md border border-border-subtle px-3 py-1 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
          >
            {t("retry")}
          </button>
        </>
      )}
    </div>
  );
}
