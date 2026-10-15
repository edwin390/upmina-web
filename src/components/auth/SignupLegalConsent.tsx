import { Link } from "react-router-dom";
import { useTranslations } from "use-intl";
import {
  LEGAL_DOCUMENTS,
  LEGAL_LINKS,
  allAccepted,
  type LegalChecks,
} from "@/lib/legal-consent";

// Casillas del registro. Orden fijo: mayoría de edad (18+), Términos, Privacidad (lectura), Normas, separador y
// «Aceptar todo» AL FINAL. Ninguna viene marcada. «Aceptar todo» es DERIVADO (las tres marcadas) y
// solo marca/desmarca las tres: no incluye ningún tratamiento opcional (hoy no existe ninguno; si se
// añade, necesita su propio control fuera de este grupo).
const BOX =
  "mt-0.5 h-5 w-5 shrink-0 rounded border-border-subtle accent-[var(--color-accent-primary,#a855f7)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary";

interface Props {
  checks: LegalChecks;
  onChange: (next: LegalChecks) => void;
  disabled?: boolean;
}

export default function SignupLegalConsent({ checks, onChange, disabled }: Props) {
  const t = useTranslations("auth.consent");
  const all = allAccepted(checks);
  return (
    <fieldset className="flex flex-col gap-3" disabled={disabled}>
      <legend className="mb-1 text-sm font-semibold text-text-primary">
        {t("legend")}
      </legend>
      <p className="text-sm text-text-secondary">
        {t.rich("intro", {
          strong: (chunks) => <strong className="text-text-primary">{chunks}</strong>,
        })}
      </p>
      {LEGAL_DOCUMENTS.map((doc) => (
        <label key={doc} className="flex items-start gap-3 text-sm text-text-secondary">
          <input
            type="checkbox"
            className={BOX}
            checked={checks[doc]}
            onChange={(e) => onChange({ ...checks, [doc]: e.target.checked })}
          />
          {doc === "adult_declaration" ? (
            <span>{t("adult")}</span>
          ) : (
            <span>
              {t.rich(doc, {
                link: (chunks) => (
                  <Link
                    to={LEGAL_LINKS[doc]}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-accent-primary hover:underline"
                  >
                    {chunks}
                    <span className="sr-only"> {t("newTab")}</span>
                  </Link>
                ),
              })}
            </span>
          )}
        </label>
      ))}
      <hr className="border-border-subtle" />
      <label className="flex items-start gap-3 text-sm font-medium text-text-primary">
        <input
          type="checkbox"
          className={BOX}
          checked={all}
          onChange={(e) => {
            const v = e.target.checked;
            onChange({ adult_declaration: v, terms: v, privacy: v, community_rules: v });
          }}
        />
        <span>{t("all")}</span>
      </label>
    </fieldset>
  );
}
