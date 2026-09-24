import { createHash, randomBytes } from "node:crypto";

// Primitivas del token de invitación admin (server-side). Mismo formato que el generador
// operator-side de bootstrap (scripts/lib/admin-bootstrap-invitation.mjs): 256 bits de
// node:crypto en base64url (43 caracteres, sin padding) y SHA-256 hex (64 caracteres) como
// ÚNICO valor que se persiste (admin_invitations.token_hash). El enlace de activación usa el
// FRAGMENT (`/admin/activate#token=...`), nunca query string, igual que AdminActivatePage.

export const INVITATION_TOKEN_BYTES = 32;
export const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateInvitationToken(): string {
  return randomBytes(INVITATION_TOKEN_BYTES).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Ruta relativa de activación (el frontend antepone su propio origen). */
export function buildActivationPath(token: string): string {
  return `/admin/activate#token=${token}`;
}
