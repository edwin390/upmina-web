// AUTH-2 (navegador): CUENTA INCOMPLETA = email sin verificar o username pendiente. Es un dominio
// DISTINTO de las sanciones (`author_restricted`, strikes): nada de este archivo toca
// author-restriction.ts. El servidor es la autoridad; esto solo interpreta su respuesta 403
// `{ code: "account_incomplete", reason }` para decidir qué texto mostrar.

export const ACCOUNT_INCOMPLETE = "account_incomplete";

export type AccountIncompleteReason = "email_unverified" | "username_missing";

export function parseAccountIncompleteReason(
  raw: unknown,
): AccountIncompleteReason | null {
  return raw === "email_unverified" || raw === "username_missing" ? raw : null;
}

/** Razón de un error de cliente (Community o Media), o null si no es `account_incomplete`.
 *  Contrato anterior `profile_required` = username pendiente (servidores desplegados antes). */
export function accountIncompleteReason(err: unknown): AccountIncompleteReason | null {
  if (!err || typeof err !== "object") return null;
  const { code, accountReason } = err as { code?: unknown; accountReason?: unknown };
  if (code === "profile_required") return "username_missing";
  if (code !== ACCOUNT_INCOMPLETE) return null;
  // Código sin razón válida: se trata como la más segura para el usuario (verificar el correo).
  return parseAccountIncompleteReason(accountReason) ?? "email_unverified";
}
