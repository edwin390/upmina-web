// COPY-1 fase 2A: validación COMPARTIDA de una reclamación de copyright (formulario público y servidor). Módulo puro, sin
// imports de alias: lo usan el navegador y el backend. En el formulario es UX; la autoridad es el servidor y la RPC
// copyright_claim_create (que repite estas reglas en SQL). La evidencia son ENLACES y texto: no hay subida de archivos.

/** Versión del texto de las declaraciones que acepta el reclamante (se guarda con el expediente). */
export const CLAIM_STATEMENT_VERSION = "v1";

export const CLAIM_RELATIONSHIPS = ["owner", "authorized_representative"] as const;
export type ClaimRelationship = (typeof CLAIM_RELATIONSHIPS)[number];

export const CLAIM_LIMITS = {
  name: { min: 2, max: 120 },
  email: { max: 254 },
  organization: { max: 120 },
  description: { min: 10, max: 2000 },
  signature: { min: 2, max: 120 },
  urls: { min: 1, max: 5, minLength: 8, maxLength: 500 },
  postUrl: { max: 500 },
  note: { max: 1000 },
} as const;

// Control (salvo tabulador y salto de línea en los textos largos) y NUL: Postgres no admite NUL en text.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_SINGLE_LINE = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HTTP_URL = /^https?:\/\/[^\s]+$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const POST_PATH = new RegExp(`(?:^|/)community/(?:post/)?(${UUID})(?:[/?#]|$)`, "i");
const BARE_UUID = new RegExp(`^${UUID}$`, "i");

export const claimTextLength = (value: string) => Array.from(value).length;

export type ClaimField =
  | "claimantName"
  | "claimantEmail"
  | "organization"
  | "relationship"
  | "workDescription"
  | "infringementDescription"
  | "evidenceUrls"
  | "postUrl"
  | "signature"
  | "statementsAccepted";
export type ClaimFieldError = "required" | "tooShort" | "tooLong" | "invalid";
export type ClaimFormErrors = Partial<Record<ClaimField, ClaimFieldError>>;

/** Lo que el formulario recoge; las URLs de prueba pueden venir como líneas de texto o como lista. */
export interface ClaimFormInput {
  claimantName: unknown;
  claimantEmail: unknown;
  organization?: unknown;
  relationship: unknown;
  workDescription: unknown;
  infringementDescription: unknown;
  evidenceUrls: unknown;
  postUrl: unknown;
  signature: unknown;
  statementsAccepted: unknown;
}

/** Cuerpo exacto que viaja al servidor (el servidor rechaza cualquier otra clave). */
export interface ClaimPayload {
  claimantName: string;
  claimantEmail: string;
  organization: string | null;
  relationship: ClaimRelationship;
  workDescription: string;
  infringementDescription: string;
  evidenceUrls: string[];
  postUrl: string;
  postId: string | null;
  signature: string;
  statementVersion: string;
  statementsAccepted: true;
}

export const CLAIM_PAYLOAD_KEYS: readonly string[] = [
  "claimantName",
  "claimantEmail",
  "organization",
  "relationship",
  "workDescription",
  "infringementDescription",
  "evidenceUrls",
  "postUrl",
  "postId",
  "signature",
  "statementVersion",
  "statementsAccepted",
];

export type ClaimFormResult =
  { ok: true; payload: ClaimPayload } | { ok: false; errors: ClaimFormErrors };

/** UUID de la publicación a partir del enlace `/community/<uuid>` o `/community/post/<uuid>` (la URL real; o de un UUID suelto), en minúsculas; null si no hay. */
export function parsePostReference(raw: string): string | null {
  const text = raw.trim();
  if (BARE_UUID.test(text)) return text.toLowerCase();
  const found = POST_PATH.exec(text);
  return found ? found[1]!.toLowerCase() : null;
}

export function singleLine(
  value: unknown,
  min: number,
  max: number,
): { value: string } | { error: ClaimFieldError } {
  if (typeof value !== "string") return { error: "invalid" };
  const text = value.trim();
  if (text === "") return { error: "required" };
  if (FORBIDDEN_SINGLE_LINE.test(text)) return { error: "invalid" };
  const length = claimTextLength(text);
  if (length < min) return { error: "tooShort" };
  if (length > max) return { error: "tooLong" };
  return { value: text };
}

export function multiLine(
  value: unknown,
  min: number,
  max: number,
): { value: string } | { error: ClaimFieldError } {
  if (typeof value !== "string") return { error: "invalid" };
  const text = value.trim();
  if (text === "") return { error: "required" };
  if (FORBIDDEN_MULTILINE.test(text)) return { error: "invalid" };
  const length = claimTextLength(text);
  if (length < min) return { error: "tooShort" };
  if (length > max) return { error: "tooLong" };
  return { value: text };
}

/** Enlaces de prueba: una lista o texto con un enlace por línea. Solo http/https, sin espacios, entre 1 y 5. */
export function parseEvidenceUrls(
  value: unknown,
): { value: string[] } | { error: ClaimFieldError } {
  let items: unknown[];
  if (typeof value === "string")
    items = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
  else if (Array.isArray(value)) items = value;
  else return { error: "invalid" };
  if (items.length < CLAIM_LIMITS.urls.min) return { error: "required" };
  if (items.length > CLAIM_LIMITS.urls.max) return { error: "tooLong" };
  const urls: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") return { error: "invalid" };
    const url = item.trim();
    const length = claimTextLength(url);
    if (
      length < CLAIM_LIMITS.urls.minLength ||
      length > CLAIM_LIMITS.urls.maxLength ||
      !HTTP_URL.test(url) ||
      FORBIDDEN_SINGLE_LINE.test(url)
    )
      return { error: "invalid" };
    try {
      if (!new URL(url).hostname) return { error: "invalid" };
    } catch {
      return { error: "invalid" };
    }
    urls.push(url);
  }
  return { value: urls };
}

export function validateClaimForm(input: ClaimFormInput): ClaimFormResult {
  const errors: ClaimFormErrors = {};
  const name = singleLine(
    input.claimantName,
    CLAIM_LIMITS.name.min,
    CLAIM_LIMITS.name.max,
  );
  if ("error" in name) errors.claimantName = name.error;

  let email = "";
  const rawEmail = typeof input.claimantEmail === "string" ? input.claimantEmail : null;
  if (rawEmail === null) errors.claimantEmail = "invalid";
  else {
    email = rawEmail.trim().toLowerCase();
    if (email === "") errors.claimantEmail = "required";
    else if (
      claimTextLength(email) > CLAIM_LIMITS.email.max ||
      FORBIDDEN_SINGLE_LINE.test(email) ||
      !EMAIL_SHAPE.test(email)
    )
      errors.claimantEmail = "invalid";
  }

  let organization: string | null = null;
  if (input.organization !== undefined && input.organization !== null) {
    if (typeof input.organization !== "string") errors.organization = "invalid";
    else if (input.organization.trim() !== "") {
      const org = singleLine(input.organization, 1, CLAIM_LIMITS.organization.max);
      if ("error" in org) errors.organization = org.error;
      else organization = org.value;
    }
  }

  const relationship = (CLAIM_RELATIONSHIPS as readonly unknown[]).includes(
    input.relationship,
  )
    ? (input.relationship as ClaimRelationship)
    : null;
  if (!relationship) errors.relationship = input.relationship ? "invalid" : "required";

  const work = multiLine(
    input.workDescription,
    CLAIM_LIMITS.description.min,
    CLAIM_LIMITS.description.max,
  );
  if ("error" in work) errors.workDescription = work.error;
  const infringement = multiLine(
    input.infringementDescription,
    CLAIM_LIMITS.description.min,
    CLAIM_LIMITS.description.max,
  );
  if ("error" in infringement) errors.infringementDescription = infringement.error;

  const urls = parseEvidenceUrls(input.evidenceUrls);
  if ("error" in urls) errors.evidenceUrls = urls.error;

  const postUrl = singleLine(input.postUrl, 1, CLAIM_LIMITS.postUrl.max);
  if ("error" in postUrl) errors.postUrl = postUrl.error;

  const signature = singleLine(
    input.signature,
    CLAIM_LIMITS.signature.min,
    CLAIM_LIMITS.signature.max,
  );
  if ("error" in signature) errors.signature = signature.error;

  if (input.statementsAccepted !== true) errors.statementsAccepted = "required";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      claimantName: (name as { value: string }).value,
      claimantEmail: email,
      organization,
      relationship: relationship!,
      workDescription: (work as { value: string }).value,
      infringementDescription: (infringement as { value: string }).value,
      evidenceUrls: (urls as { value: string[] }).value,
      postUrl: (postUrl as { value: string }).value,
      postId: parsePostReference((postUrl as { value: string }).value),
      signature: (signature as { value: string }).value,
      statementVersion: CLAIM_STATEMENT_VERSION,
      statementsAccepted: true,
    },
  };
}

/** Texto de una nota de revisión: obligatorio donde se exija, 1-1000 caracteres, sin controles. */
export function validateReviewNote(
  raw: unknown,
): { ok: true; note: string } | { ok: false; error: ClaimFieldError } {
  const note = multiLine(raw, 1, CLAIM_LIMITS.note.max);
  return "error" in note
    ? { ok: false, error: note.error }
    : { ok: true, note: note.value };
}
