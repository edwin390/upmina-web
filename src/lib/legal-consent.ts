// Aceptación legal en el registro. DESACTIVADA por defecto: sin VITE_SIGNUP_LEGAL_CONSENT=true el
// formulario de /signup es el de siempre y no se envía nada. Los textos (docs/legal/*.borrador.md)
// siguen pendientes de revisión jurídica; esta pieza NO los publica ni bloquea registros reales.
//
// Evidencia mínima: versión de cada documento aceptado, enviada como metadata de alta
// (`options.data.legal_acceptance`) y copiada por el trigger `legal_record_signup_acceptance`
// (migración 20261118120000) a `legal_acceptances` con la fecha del servidor. No se guarda IP ni
// agente de usuario. Esa metadata la controla el cliente: sirve como declaración del reconocimiento y
// NUNCA como autorización (ningún rol ni permiso se deriva de ella).

export const LEGAL_DOCUMENTS = ["terms", "privacy", "community_rules"] as const;
export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number];

/** Versión vigente de cada documento. Debe coincidir con `legal_document_versions` (is_current). */
export const LEGAL_VERSIONS: Record<LegalDocument, string> = {
  terms: "v0.1",
  privacy: "v0.1",
  community_rules: "v0.1",
};

export const LEGAL_LINKS: Record<LegalDocument, string> = {
  terms: "/terms",
  privacy: "/privacy",
  community_rules: "/community-rules",
};

export function isSignupLegalConsentEnabled(
  env: Record<string, unknown> = import.meta.env,
): boolean {
  return env.VITE_SIGNUP_LEGAL_CONSENT === "true";
}

export type LegalChecks = Record<LegalDocument, boolean>;
export const NO_CHECKS: LegalChecks = {
  terms: false,
  privacy: false,
  community_rules: false,
};

export const allAccepted = (c: LegalChecks) => LEGAL_DOCUMENTS.every((d) => c[d]);

/** Metadata de alta; null si falta alguna aceptación (el botón ya lo impide). */
export function buildLegalAcceptance(c: LegalChecks): Record<string, string> | null {
  if (!allAccepted(c)) return null;
  return { ...LEGAL_VERSIONS };
}
