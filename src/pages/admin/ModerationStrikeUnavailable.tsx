import { useTranslations } from "use-intl";

// R5-F: la lectura del estado de strike FALLÓ (≠ «sin sanción»). Mensaje genérico, sin ningún dato
// del error, con reintento que vuelve a pedir el detalle al servidor. No ofrece acciones de strike:
// sin conocer el estado real no se puede aplicar ni revocar nada.
export default function ModerationStrikeUnavailable({
  onRetry,
  disabled,
}: {
  onRetry: () => void;
  disabled?: boolean;
}) {
  const t = useTranslations("moderation.strikeUnavailable");
  return (
    <section
      aria-label={t("title")}
      className="min-w-0 space-y-3 rounded border border-border-subtle p-3"
    >
      <h2 className="font-semibold">{t("title")}</h2>
      <p role="alert">{t("message")}</p>
      <button
        type="button"
        disabled={disabled}
        onClick={onRetry}
        className="inline-flex min-h-11 items-center justify-center rounded-md border border-border-subtle px-4 py-2 text-sm font-semibold text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50"
      >
        {t("retry")}
      </button>
    </section>
  );
}
