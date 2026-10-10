import { useTranslations } from "use-intl";
import UpminaLocaleProvider from "@/i18n/LocaleProvider";

// AUTH-2: mensaje de "confirma tu correo antes de elegir tu username" (EN/ES/DE, namespace `auth`).
// ProfileSection todavía no está bajo el proveedor de idioma (I18N-1 lo subirá a la app), así que
// se monta aquí solo para este texto, sin traducir el resto del componente.

function Message() {
  const t = useTranslations("auth.accountIncomplete");
  return <>{t("usernameNeedsEmail")}</>;
}

export default function VerifyEmailFirstMessage() {
  return (
    <UpminaLocaleProvider>
      <Message />
    </UpminaLocaleProvider>
  );
}
