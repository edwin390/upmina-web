import { useTranslations } from "use-intl";

/** Aviso discreto e integrado en la sección (no es un modal ni bloquea nada). */
export default function ContentNotice() {
  const t = useTranslations("site.notice");
  return (
    <p
      role="status"
      className="mb-4 rounded-lg border border-border-subtle bg-bg-surface px-3 py-2 text-sm text-text-secondary"
    >
      {t("expired")}
    </p>
  );
}
