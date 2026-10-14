import { parseAppealFragment, type AppealFragment } from "./pending-appeal-token";

// Token de confirmación de eliminación de cuenta (DEL-3) pendiente, SOLO EN MEMORIA.
//
// El enlace del correo es /account/delete#t=<token>. Mismo criterio que pending-appeal-token.ts y pending-recovery-code.ts: NUNCA en
// localStorage, sessionStorage, cookies, URL, returnTo, analítica ni logs; un refresco completo lo pierde (basta abrir de nuevo el
// enlace). Sin sesión hay que iniciar sesión y volver DENTRO de la SPA: la variable del módulo lo conserva entre /account/delete → /login →
// /account/delete. No autoriza nada: el backend valida token, cuenta, caducidad y uso único.

export const PENDING_DELETION_TOKEN_TTL_MS = 30 * 60 * 1000;
export const DELETION_RETURN_PATH = "/account/delete";
export const DELETION_LOGIN_PATH = `/login?returnTo=${DELETION_RETURN_PATH}`;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

let pending: { token: string; capturedAt: number } | null = null;

export function capturePendingDeletionToken(
  token: unknown,
  now: number = Date.now(),
): boolean {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return false;
  pending = { token, capturedAt: now };
  return true;
}

/** Devuelve el token sin consumirlo, o null si no hay o venció (si venció se destruye). */
export function readPendingDeletionToken(now: number = Date.now()): string | null {
  if (!pending) return null;
  if (
    now - pending.capturedAt >= PENDING_DELETION_TOKEN_TTL_MS ||
    now < pending.capturedAt
  ) {
    pending = null;
    return null;
  }
  return pending.token;
}

export function clearPendingDeletionToken(): void {
  pending = null;
}

/** Mismo análisis de fragmento que la apelación (`#t=`): devuelve el token válido y lo que debe quedar en la URL. */
export const parseDeletionFragment: (hash: string) => AppealFragment =
  parseAppealFragment;
