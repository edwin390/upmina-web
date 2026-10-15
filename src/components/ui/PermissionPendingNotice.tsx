import { useTranslations } from "use-intl";

/** Contenido de Instagram, TikTok o Cosplays aún no disponible: se espera la autorización de Mina para compartirlo. */
export default function PermissionPendingNotice() {
  const t = useTranslations("site");
  return (
    <p
      role="status"
      className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-6 text-center text-text-secondary"
    >
      {t("permissionPending")}
    </p>
  );
}
