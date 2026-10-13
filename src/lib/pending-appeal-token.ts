// Token de apelación de copyright (COPY-1 fase 2B) pendiente, SOLO EN MEMORIA.
//
// El enlace del correo es /copyright/appeal#t=<token>. Sin sesión hay que iniciar sesión y volver; el fragmento no sobrevive a esa
// navegación, así que mientras la persona navega DENTRO de la SPA (apelación -> login -> apelación) el token se conserva en una
// variable del módulo. Mismo criterio que pending-recovery-code.ts: NUNCA en localStorage, sessionStorage, cookies, URL ni
// returnTo; un secreto no queda almacenado en reposo. Un refresco completo o abrir otro dispositivo lo PIERDE: basta con abrir de
// nuevo el enlace del correo.
//
// No autoriza nada: el backend valida token, cuenta autora, estado y plazo. Un token de otra cuenta simplemente falla.

/** Vida máxima en memoria. */
export const PENDING_APPEAL_TOKEN_TTL_MS = 30 * 60 * 1000;
export const APPEAL_RETURN_PATH = "/copyright/appeal";
export const APPEAL_LOGIN_PATH = `/login?returnTo=${APPEAL_RETURN_PATH}`;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

let pending: { token: string; capturedAt: number } | null = null;

export function capturePendingAppealToken(
  token: unknown,
  now: number = Date.now(),
): boolean {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return false;
  pending = { token, capturedAt: now };
  return true;
}

/** Devuelve el token sin consumirlo, o null si no hay o venció (si venció se destruye). */
export function readPendingAppealToken(now: number = Date.now()): string | null {
  if (!pending) return null;
  if (
    now - pending.capturedAt >= PENDING_APPEAL_TOKEN_TTL_MS ||
    now < pending.capturedAt
  ) {
    pending = null;
    return null;
  }
  return pending.token;
}

export function clearPendingAppealToken(): void {
  pending = null;
}

export interface AppealFragment {
  /** true si el fragmento intenta transportar un token (parámetro `t`, aunque esté vacío o mal formado). */
  present: boolean;
  /** El token si tiene forma válida; null en cualquier otro caso (nunca se guarda ni se envía). */
  token: string | null;
  /** Lo que debe quedar en la URL: el fragmento SIN el parámetro `t` (un fragmento ajeno se devuelve intacto). */
  remainder: string;
}

export function parseAppealFragment(hash: string): AppealFragment {
  const raw = typeof hash === "string" ? hash : "";
  const params = new URLSearchParams(raw.startsWith("#") ? raw.slice(1) : raw);
  if (!params.has("t")) return { present: false, token: null, remainder: raw };
  const value = params.get("t") ?? "";
  params.delete("t");
  const rest = params.toString();
  return {
    present: true,
    token: TOKEN_SHAPE.test(value) ? value : null,
    remainder: rest ? `#${rest}` : "",
  };
}
