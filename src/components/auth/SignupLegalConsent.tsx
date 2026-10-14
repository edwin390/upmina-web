import { Link } from "react-router-dom";
import {
  LEGAL_DOCUMENTS,
  LEGAL_LINKS,
  allAccepted,
  type LegalChecks,
  type LegalDocument,
} from "@/lib/legal-consent";

// Casillas de aceptación del registro. Orden fijo: Términos, Privacidad (lectura), Normas, separador y
// «Aceptar todo» AL FINAL. Ninguna viene marcada. «Aceptar todo» es DERIVADO (las tres marcadas) y
// solo marca/desmarca las tres: no incluye ningún tratamiento opcional (hoy no existe ninguno; si se
// añade, necesita su propio control fuera de este grupo).
const LABEL: Record<LegalDocument, { before: string; link: string; after: string }> = {
  terms: { before: "Acepto los ", link: "Términos y condiciones", after: "." },
  privacy: {
    before: "He leído el ",
    link: "Aviso de privacidad",
    after: ".",
  },
  community_rules: { before: "Acepto las ", link: "Normas de Community", after: "." },
};

const BOX =
  "mt-0.5 h-5 w-5 shrink-0 rounded border-border-subtle accent-[var(--color-accent-primary,#a855f7)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary";

interface Props {
  checks: LegalChecks;
  onChange: (next: LegalChecks) => void;
  disabled?: boolean;
}

export default function SignupLegalConsent({ checks, onChange, disabled }: Props) {
  const all = allAccepted(checks);
  return (
    <fieldset className="flex flex-col gap-3" disabled={disabled}>
      <legend className="mb-1 text-sm font-semibold text-text-primary">
        Antes de crear tu cuenta
      </legend>
      {LEGAL_DOCUMENTS.map((doc) => (
        <label key={doc} className="flex items-start gap-3 text-sm text-text-secondary">
          <input
            type="checkbox"
            className={BOX}
            checked={checks[doc]}
            onChange={(e) => onChange({ ...checks, [doc]: e.target.checked })}
          />
          <span>
            {LABEL[doc].before}
            <Link
              to={LEGAL_LINKS[doc]}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-accent-primary hover:underline"
            >
              {LABEL[doc].link}
              <span className="sr-only"> (se abre en una pestaña nueva)</span>
            </Link>
            {LABEL[doc].after}
          </span>
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
            onChange({ terms: v, privacy: v, community_rules: v });
          }}
        />
        <span>Aceptar todo</span>
      </label>
    </fieldset>
  );
}
