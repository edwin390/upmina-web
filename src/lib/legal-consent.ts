// Aceptación legal y declaración de mayoría de edad en el registro. Se activa con VITE_SIGNUP_LEGAL_CONSENT=true
// (sin ella el formulario es el de siempre y no se envía nada). Los textos están en src/content/legal/.
//
// Evidencia mínima: versión de cada documento aceptado, enviada como metadata de alta
// (`options.data.legal_acceptance`) y copiada por el trigger `legal_record_signup_acceptance`
// (migración 20261118120000) a `legal_acceptances` con la fecha del servidor. No se guarda IP ni
// agente de usuario. Esa metadata la controla el cliente: sirve como declaración del reconocimiento y
// NUNCA como autorización (ningún rol ni permiso se deriva de ella).

// «adult_declaration» NO es un documento: es la declaración de mayoría de edad (18+), registrada con la misma versión/fecha.
export const LEGAL_DOCUMENTS = [
  "adult_declaration",
  "terms",
  "privacy",
  "community_rules",
] as const;
export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number];

/** Versión vigente de cada documento. Debe coincidir con `legal_document_versions` (is_current). */
export const LEGAL_VERSIONS: Record<LegalDocument, string> = {
  adult_declaration: "v1.0",
  terms: "v1.0",
  privacy: "v1.0",
  community_rules: "v1.0",
};

export const LEGAL_LINKS: Record<Exclude<LegalDocument, "adult_declaration">, string> = {
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
  adult_declaration: false,
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
