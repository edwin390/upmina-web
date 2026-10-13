// COPY-1 fase 2B: validación COMPARTIDA de la apelación del autor y del motivo de una retirada. Módulo puro, sin imports de alias:
// lo usan el navegador (UX) y el backend; la autoridad es el servidor y la RPC copyright_appeal_submit, que repite estas reglas en
// SQL. La evidencia son TEXTO y ENLACES: no hay subida de archivos ni documentos de identidad.

import {
  CLAIM_LIMITS,
  claimTextLength,
  multiLine,
  parseEvidenceUrls,
  singleLine,
  type ClaimFieldError,
} from "./copyright-claim.js";

/** Versión del texto de la declaración de veracidad que acepta el autor (se guarda con la apelación). */
export const APPEAL_STATEMENT_VERSION = "v1";

export const APPEAL_REASON_VALUES = [
  "own_work",
  "authorized",
  "not_infringing",
  "legal_exception",
  "mistake",
  "other",
] as const;
export type AppealReason = (typeof APPEAL_REASON_VALUES)[number];

export const APPEAL_LIMITS = {
  name: CLAIM_LIMITS.name,
  email: CLAIM_LIMITS.email,
  explanation: { min: 10, max: 2000 },
  evidenceText: { max: 2000 },
  urls: { max: CLAIM_LIMITS.urls.max },
  removalReason: { min: 10, max: 1000 },
} as const;

// eslint-disable-next-line no-control-regex
const FORBIDDEN_SINGLE_LINE = /[\u0000-\u001f\u007f]/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AppealField =
  | "contactName"
  | "contactEmail"
  | "reason"
  | "explanation"
  | "evidenceText"
  | "evidenceUrls"
  | "evidence"
  | "statementAccepted";
export type AppealFormErrors = Partial<Record<AppealField, ClaimFieldError>>;

export interface AppealFormInput {
  contactName: unknown;
  contactEmail: unknown;
  reason: unknown;
  explanation: unknown;
  evidenceText?: unknown;
  evidenceUrls?: unknown;
  statementAccepted: unknown;
}

/** Cuerpo exacto que viaja al servidor (el servidor rechaza cualquier otra clave). */
export interface AppealPayload {
  contactName: string;
  contactEmail: string;
  reason: AppealReason;
  explanation: string;
  evidenceText: string | null;
  evidenceUrls: string[];
  statementVersion: string;
  statementAccepted: true;
}

export const APPEAL_PAYLOAD_KEYS: readonly string[] = [
  "contactName",
  "contactEmail",
  "reason",
  "explanation",
  "evidenceText",
  "evidenceUrls",
  "statementVersion",
  "statementAccepted",
];

export type AppealFormResult =
  { ok: true; payload: AppealPayload } | { ok: false; errors: AppealFormErrors };

const isBlank = (v: unknown) =>
  v === undefined ||
  v === null ||
  (typeof v === "string" && v.trim() === "") ||
  (Array.isArray(v) && v.length === 0);

export function validateAppealForm(input: AppealFormInput): AppealFormResult {
  const errors: AppealFormErrors = {};
  const name = singleLine(
    input.contactName,
    APPEAL_LIMITS.name.min,
    APPEAL_LIMITS.name.max,
  );
  if ("error" in name) errors.contactName = name.error;

  let email = "";
  if (typeof input.contactEmail !== "string") errors.contactEmail = "invalid";
  else {
    email = input.contactEmail.trim().toLowerCase();
    if (email === "") errors.contactEmail = "required";
    else if (
      claimTextLength(email) > APPEAL_LIMITS.email.max ||
      FORBIDDEN_SINGLE_LINE.test(email) ||
      !EMAIL_SHAPE.test(email)
    )
      errors.contactEmail = "invalid";
  }

  const reason = (APPEAL_REASON_VALUES as readonly unknown[]).includes(input.reason)
    ? (input.reason as AppealReason)
    : null;
  if (!reason) errors.reason = input.reason ? "invalid" : "required";

  const explanation = multiLine(
    input.explanation,
    APPEAL_LIMITS.explanation.min,
    APPEAL_LIMITS.explanation.max,
  );
  if ("error" in explanation) errors.explanation = explanation.error;

  let evidenceText: string | null = null;
  if (!isBlank(input.evidenceText)) {
    const text = multiLine(input.evidenceText, 1, APPEAL_LIMITS.evidenceText.max);
    if ("error" in text) errors.evidenceText = text.error;
    else evidenceText = text.value;
  }
  let evidenceUrls: string[] = [];
  if (!isBlank(input.evidenceUrls)) {
    const urls = parseEvidenceUrls(input.evidenceUrls);
    if ("error" in urls) errors.evidenceUrls = urls.error;
    else evidenceUrls = urls.value;
  }
  // La prueba puede ser texto, enlaces o ambos, pero no ninguno.
  if (
    !errors.evidenceText &&
    !errors.evidenceUrls &&
    evidenceText === null &&
    evidenceUrls.length === 0
  )
    errors.evidence = "required";

  if (input.statementAccepted !== true) errors.statementAccepted = "required";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      contactName: (name as { value: string }).value,
      contactEmail: email,
      reason: reason!,
      explanation: (explanation as { value: string }).value,
      evidenceText,
      evidenceUrls,
      statementVersion: APPEAL_STATEMENT_VERSION,
      statementAccepted: true,
    },
  };
}

/** Motivo de una retirada: lo recibe el autor en el correo. 10-1000 caracteres, sin controles. */
export function validateRemovalReason(
  raw: unknown,
): { ok: true; reason: string } | { ok: false; error: ClaimFieldError } {
  const reason = multiLine(
    raw,
    APPEAL_LIMITS.removalReason.min,
    APPEAL_LIMITS.removalReason.max,
  );
  return "error" in reason
    ? { ok: false, error: reason.error }
    : { ok: true, reason: reason.value };
}
