import { useTranslations } from "use-intl";
import UpminaLocaleProvider from "@/i18n/LocaleProvider";

// Mensaje de nombre protegido (username o display_name) en es/en/de. Es un complemento de UX: la
// autoridad es el servidor y el trigger de PostgreSQL. El texto no explica la regla (no es un oráculo).

function Inner({ field }: { field: "username" | "displayName" }) {
  const t = useTranslations("auth.reservedName");
  return <>{t(field)}</>;
}

export default function ReservedIdentityMessage({
  field,
}: {
  field: "username" | "displayName";
}) {
  return (
    <UpminaLocaleProvider>
      <Inner field={field} />
    </UpminaLocaleProvider>
  );
}
