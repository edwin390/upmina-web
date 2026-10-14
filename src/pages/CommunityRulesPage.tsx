import LegalLayout, { LegalSection } from "@/components/legal/LegalLayout";

// Solo se enruta con VITE_SIGNUP_LEGAL_CONSENT=true (ver App.tsx). El texto definitivo está en
// docs/legal/NORMAS-DE-COMMUNITY.borrador.md y NO se publica hasta su revisión y aprobación.
export default function CommunityRulesPage() {
  return (
    <LegalLayout title="Normas de Community">
      <LegalSection title="Borrador pendiente de aprobación">
        <p>El texto de las Normas de Community aún no ha sido aprobado.</p>
      </LegalSection>
    </LegalLayout>
  );
}
