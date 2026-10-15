import LegalLayout, { LegalSection } from "@/components/legal/LegalLayout";

// Solo se enruta con VITE_LEGAL_DOCS_ENABLED=true (ver App.tsx). El texto definitivo (identificación del responsable,
// independencia del proyecto, contacto) está en docs/legal/AVISO-LEGAL.borrador.md y NO se publica hasta su aprobación.
export default function LegalNoticePage() {
  return (
    <LegalLayout title="Legal notice">
      <LegalSection title="Draft pending approval">
        <p>This legal notice has not been approved yet.</p>
      </LegalSection>
    </LegalLayout>
  );
}
