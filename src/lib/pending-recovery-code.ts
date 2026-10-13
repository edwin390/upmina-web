// Código de verificación de la recuperación de MFA (MFA fase 2) pendiente, SOLO EN MEMORIA.
//
// Para qué: el enlace del correo es /admin/mfa/recovery#c=<código>. Si se abre sin sesión hay que iniciar
// sesión y volver; el fragmento no sobrevive a esa navegación, así que mientras la persona navega
// DENTRO de la SPA (recuperación -> login -> recuperación) el código se conserva en una variable del
// módulo. Mismo criterio que pending-invitation.ts: NUNCA en localStorage, sessionStorage, cookies,
// URL, returnTo ni estado que llegue al DOM; un secreto no queda almacenado en reposo.
//
// Limitación asumida: un refresco completo o abrir otra pestaña/dispositivo PIERDE el código. No se
// «arregla» guardándolo: la continuidad entre dispositivos y pestañas la da el SERVIDOR (la solicitud
// y su estado viven en la base de datos y se recuperan al iniciar sesión) y la persona puede volver a
// abrir el enlace del correo o PEGAR el enlace/código completo en la propia página.
//
// No autoriza nada: el backend valida el desafío (hash, vigencia, un solo uso, titularidad y
// credenciales recientes) con la cuenta autenticada. Un código de otra cuenta simplemente falla.

/** Vida máxima: la misma del desafío del correo (15 min). */
export const PENDING_RECOVERY_CODE_TTL_MS = 15 * 60 * 1000;
/** Ruta de retorno tras el login (validada por la allowlist de safe-return-to). */
export const RECOVERY_RETURN_PATH = "/admin/mfa/recovery";
export const RECOVERY_LOGIN_PATH = `/login?returnTo=${RECOVERY_RETURN_PATH}`;

const CODE_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const LINK_SHAPE = /#c=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/;

let pending: { code: string; capturedAt: number } | null = null;

/** Guarda el código (sustituye al anterior). Devuelve false, sin guardar, si no tiene forma válida. */
export function capturePendingRecoveryCode(
  code: unknown,
  now: number = Date.now(),
): boolean {
  if (typeof code !== "string" || !CODE_SHAPE.test(code)) return false;
  pending = { code, capturedAt: now };
  return true;
}

/** Devuelve el código sin consumirlo, o null si no hay o venció (si venció se destruye). */
export function readPendingRecoveryCode(now: number = Date.now()): string | null {
  if (!pending) return null;
  if (
    now - pending.capturedAt >= PENDING_RECOVERY_CODE_TTL_MS ||
    now < pending.capturedAt
  ) {
    pending = null;
    return null;
  }
  return pending.code;
}

export function clearPendingRecoveryCode(): void {
  pending = null;
}

/** Resultado de leer el fragmento de la URL (`location.hash`) de la página de recuperación. */
export interface RecoveryFragment {
  /** true si el fragmento intenta transportar un código: contiene el parámetro `c` (también `#c` o `#c=`). */
  present: boolean;
  /** El código si tiene la forma válida; null si falta, está vacío o es inválido (nunca se guarda ni se envía). */
  code: string | null;
  /** Lo que debe quedar en la URL: el fragmento SIN el parámetro `c`. Un fragmento ajeno (`#seccion`, `#x=1`)
   *  se devuelve intacto y `present` es false; si había otros parámetros además de `c`, se conservan. */
  remainder: string;
}

/**
 * Lee `location.hash` como parámetros. Solo el parámetro `c` es de la recuperación: se retira SIEMPRE que
 * esté presente (sea válido o no) y nada más se toca. La validación de la forma va DESPUÉS de decidir qué
 * se retira, de modo que un enlace con un código mal formado tampoco deja el fragmento visible en la URL.
 */
export function parseRecoveryFragment(hash: string): RecoveryFragment {
  const raw = typeof hash === "string" ? hash : "";
  const params = new URLSearchParams(raw.startsWith("#") ? raw.slice(1) : raw);
  if (!params.has("c")) return { present: false, code: null, remainder: raw };
  const value = params.get("c") ?? "";
  params.delete("c");
  const rest = params.toString();
  return {
    present: true,
    code: CODE_SHAPE.test(value) ? value : null,
    remainder: rest ? `#${rest}` : "",
  };
}

/** Acepta el código solo o el ENLACE completo del correo pegado (cuando se abrió en otro
 *  dispositivo): devuelve el código de 43 caracteres o null. */
export function extractRecoveryCode(input: string): string | null {
  const trimmed = input.trim();
  if (CODE_SHAPE.test(trimmed)) return trimmed;
  return LINK_SHAPE.exec(trimmed)?.[1] ?? null;
}
