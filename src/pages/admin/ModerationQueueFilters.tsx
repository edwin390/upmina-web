import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import {
  hasQueueFilters as hasFilters,
  type ModerationQueueFilters as Filters,
} from "@/lib/moderation-client";

// R5-G: controles de filtro de la cola. Motivo, «ocultas» y fechas se aplican al instante; el autor
// se escribe con debounce y solo se aplica con 2+ caracteres válidos (o vacío). El servidor vuelve a
// validar todo: esto es UX, no seguridad.
const AUTHOR_DEBOUNCE_MS = 400;
const AUTHOR_RE = /^[a-z0-9_]{2,20}$/i;
const REASONS = [
  "spam",
  "harassment",
  "hate_speech",
  "sexual_content",
  "violence",
  "off_topic",
  "ai_generated",
  "other",
] as const;
const field =
  "min-h-11 w-full rounded-md border border-border-subtle bg-bg-surface px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:opacity-50";

export default function ModerationQueueFilters({
  filters,
  onChange,
  disabled,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("moderation.queue");
  const [author, setAuthor] = useState(filters.author ?? "");
  // Un «Limpiar filtros» externo (o un cambio de vista) vacía también el borrador.
  useEffect(() => setAuthor(filters.author ?? ""), [filters.author]);
  const typed = author.trim().replace(/^@/, "");
  useEffect(() => {
    if (typed === (filters.author ?? "")) return;
    if (typed !== "" && !AUTHOR_RE.test(typed)) return;
    const timer = setTimeout(
      () => onChange({ ...filters, author: typed || undefined }),
      AUTHOR_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [typed, filters, onChange]);
  const rangeInvalid = Boolean(filters.from && filters.to && filters.from > filters.to);
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  return (
    <form
      role="search"
      aria-label={t("filtersLabel")}
      onSubmit={(e) => e.preventDefault()}
      className="mb-4 grid min-w-0 gap-3 sm:grid-cols-2"
    >
      <label className="flex min-w-0 flex-col gap-1 text-sm">
        {t("reason")}
        <select
          className={field}
          disabled={disabled}
          value={filters.reason ?? ""}
          onChange={(e) => set({ reason: e.target.value || undefined })}
        >
          <option value="">{t("reasonAll")}</option>
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`reasons.${r}`)}
            </option>
          ))}
        </select>
      </label>
      <div className="flex min-w-0 flex-col gap-1 text-sm">
        <label className="flex min-w-0 flex-col gap-1">
          {t("author")}
          <input
            type="search"
            className={field}
            disabled={disabled}
            maxLength={21}
            autoComplete="off"
            value={author}
            aria-describedby="moderation-author-hint"
            onChange={(e) => setAuthor(e.target.value)}
          />
        </label>
        {typed !== "" && !AUTHOR_RE.test(typed) && (
          <span id="moderation-author-hint" className="text-xs text-text-muted">
            {t("authorHint")}
          </span>
        )}
      </div>
      <label className="flex min-w-0 flex-col gap-1 text-sm">
        {t("from")}
        <input
          type="date"
          className={field}
          disabled={disabled}
          value={filters.from ?? ""}
          max={filters.to || undefined}
          onChange={(e) => set({ from: e.target.value || undefined })}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-sm">
        {t("to")}
        <input
          type="date"
          className={field}
          disabled={disabled}
          value={filters.to ?? ""}
          min={filters.from || undefined}
          onChange={(e) => set({ to: e.target.value || undefined })}
        />
      </label>
      {rangeInvalid && (
        <p role="alert" className="text-sm sm:col-span-2">
          {t("rangeInvalid")}
        </p>
      )}
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          disabled={disabled}
          checked={Boolean(filters.hiddenOnly)}
          onChange={(e) => set({ hiddenOnly: e.target.checked || undefined })}
        />
        {t("hiddenOnly")}
      </label>
      <button
        type="button"
        disabled={
          disabled || !hasFilters({ ...filters, author: author || filters.author })
        }
        onClick={() => {
          setAuthor("");
          onChange({});
        }}
        className="inline-flex min-h-11 items-center justify-center rounded-md border border-border-subtle px-4 py-2 text-sm font-semibold text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50 sm:justify-self-end"
      >
        {t("clear")}
      </button>
    </form>
  );
}
