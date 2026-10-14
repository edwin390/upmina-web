import { Link } from "react-router-dom";
import { useTranslations } from "use-intl";
import UpminaLocaleProvider from "@/i18n/LocaleProvider";

// Entrada a la eliminación de cuenta desde /account (DEL-3). Solo existe dentro de /account, que ya exige sesión: un visitante anónimo
// nunca la ve. NO decide nada: una cuenta con rol de equipo ve igualmente el enlace y la pantalla de destino le explica que sigue otro
// procedimiento; el servidor es quien rechaza la eliminación ordinaria de esas cuentas.

function Entry() {
  const t = useTranslations("auth.accountDeletion.link");
  return (
    <section
      aria-labelledby="delete-account-heading"
      className="mt-8 border-t border-border-subtle pt-6"
    >
      <h2 id="delete-account-heading" className="font-display text-lg text-text-primary">
        {t("title")}
      </h2>
      <p className="mt-1 text-sm text-text-secondary">{t("hint")}</p>
      <Link
        to="/account/delete"
        className="mt-3 inline-flex min-h-11 items-center rounded-md border border-accent-live/60 px-5 py-2.5 text-sm font-semibold text-accent-live transition-colors duration-200 hover:bg-accent-live/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
      >
        {t("button")}
      </Link>
    </section>
  );
}

export default function DeleteAccountLink() {
  return (
    <UpminaLocaleProvider>
      <Entry />
    </UpminaLocaleProvider>
  );
}
