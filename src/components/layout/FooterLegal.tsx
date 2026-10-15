import { Link } from "react-router-dom";
import { useTranslations } from "use-intl";
import UpminaLocaleProvider from "@/i18n/LocaleProvider";
import { isLegalDocsEnabled } from "@/lib/legal-docs";

// Parte localizada (ES/EN/DE, sistema i18n existente) del footer: enlaces legales y avisos. Se carga perezosamente desde
// Footer.tsx para no meter use-intl ni los mensajes en el bundle principal. Sin VITE_LEGAL_DOCS_ENABLED no se enlazan
// documentos aún no aprobados (Reglas de comunidad, Aviso legal) y el aviso no afirma ninguna licencia.
const LINK =
  "py-2 transition-colors duration-200 ease-smooth hover:text-accent-secondary";

function Content() {
  const t = useTranslations("common.footer");
  const docs = isLegalDocsEnabled();
  const year = new Date().getFullYear();
  return (
    <>
      <nav
        aria-label={t("legalNav")}
        className="-my-2 flex flex-wrap gap-x-5 text-text-muted"
      >
        <Link to="/terms" className={LINK}>
          {t("terms")}
        </Link>
        <Link to="/privacy" className={LINK}>
          {t("privacy")}
        </Link>
        {docs ? (
          <Link to="/community-rules" className={LINK}>
            {t("communityRules")}
          </Link>
        ) : null}
        <Link to="/copyright" className={LINK} title={t("copyrightHint")}>
          {t("copyrightClaims")}
        </Link>
        {docs ? (
          <Link to="/legal" className={LINK}>
            {t("legalNotice")}
          </Link>
        ) : null}
      </nav>

      <p className="max-w-2xl text-text-muted">
        {docs
          ? t.rich("independenceWithNotice", {
              notice: (chunks) => (
                <Link to="/legal" className="underline hover:text-accent-primary">
                  {chunks}
                </Link>
              ),
            })
          : t("independence")}
      </p>

      <p className="text-text-muted">
        {t.rich("madeWith", {
          year,
          heart: (chunks) => <span className="text-accent-primary">{chunks}</span>,
        })}
      </p>
    </>
  );
}

export default function FooterLegal() {
  return (
    <UpminaLocaleProvider>
      <Content />
    </UpminaLocaleProvider>
  );
}
