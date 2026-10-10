import { useTranslations } from "use-intl";
import type { AuthLinkError } from "@/lib/auth-link-error";
import UpminaLocaleProvider from "@/i18n/LocaleProvider";

// AUTH-1: aviso cuando el enlace de confirmación del correo caducó o no es válido. Mensaje
// controlado (namespace `auth`, ES/EN/DE); nunca incluye texto del proveedor ni datos de la cuenta.

function NoticeContent({ kind }: { kind: AuthLinkError }) {
  const t = useTranslations("auth.linkError");
  return (
    <div
      role="alert"
      className="rounded-lg border border-accent-warning/40 bg-accent-warning/5 p-4 text-sm leading-relaxed text-text-secondary"
    >
      <strong className="block text-text-primary">
        {kind === "expired" ? t("expiredTitle") : t("invalidTitle")}
      </strong>
      <span className="mt-1 block">{t("hint")}</span>
    </div>
  );
}

export default function AuthLinkErrorNotice({ kind }: { kind: AuthLinkError }) {
  return (
    <UpminaLocaleProvider>
      <NoticeContent kind={kind} />
    </UpminaLocaleProvider>
  );
}
