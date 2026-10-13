// «Olvidé mi contraseña» — soporte del cliente. Supabase Auth es la ÚNICA autoridad: genera, envía y valida el
// enlace (resetPasswordForEmail) y establece la sesión de recuperación; aquí NO hay tokens propios.
//
// MARCA de recuperación (solo para decidir si se MUESTRA el formulario de contraseña nueva; no autoriza nada: Supabase
// vuelve a comprobar la sesión y el nivel de aseguramiento en updateUser):
//   * Nace SOLO del evento real PASSWORD_RECOVERY de supabase-js (enlace de recuperación consumido y validado por
//     Supabase), no de leer la URL. Se suscribe al crear el cliente, antes de que el evento se emita.
//   * Está ATADA a esa sesión concreta: guarda el id de usuario y el `session_id` de la sesión de recuperación. Una
//     sesión ordinaria (otro inicio de sesión) o de otra cuenta tiene otro `session_id`/usuario y NO coincide, aunque
//     la marca siga ahí. El `session_id` se lee del propio token solo para comparar; el token nunca se guarda.
//   * Caduca a los 15 minutos y se limpia al cerrar sesión (SIGNED_OUT), al cancelar, al completar, ante un enlace
//     inválido y cuando se detecta que ya no coincide con la sesión.
//   * Vive en el sessionStorage DE LA PESTAÑA (sobrevive a una recarga legítima; otras pestañas no la heredan). Si no
//     hay sessionStorage, en memoria. Contenido: userId, sessionId y caducidad. Nunca tokens, contraseñas ni fragmentos.

const STORAGE_KEY = "upmina:password-recovery";
export const RECOVERY_MARK_MAX_AGE_MS = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Mark {
  userId: string;
  sessionId: string;
  expiresAt: number;
}
/** Lo mínimo de una sesión de Supabase que se necesita aquí. */
export interface RecoverySessionLike {
  user: { id: string };
  access_token: string;
}

let memoryMark: Mark | null = null; // solo si sessionStorage no está disponible

function isMark(value: unknown): value is Mark {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.userId === "string" &&
    m.userId.length > 0 &&
    typeof m.sessionId === "string" &&
    UUID.test(m.sessionId) &&
    typeof m.expiresAt === "number" &&
    Number.isFinite(m.expiresAt)
  );
}

function readMark(): Mark | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isMark(parsed) ? parsed : null; // una entrada corrupta se ignora
  } catch {
    return memoryMark;
  }
}

function writeMark(mark: Mark): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(mark));
    memoryMark = null;
  } catch {
    memoryMark = mark;
  }
}

/** `session_id` del access token (solo para COMPARAR sesiones; no verifica la firma ni autoriza nada). */
export function sessionIdFromAccessToken(token: string): string | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const id = (JSON.parse(json) as { session_id?: unknown }).session_id;
    return typeof id === "string" && UUID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Limpia la marca (memoria y pestaña). */
export function clearRecoveryMark(): void {
  memoryMark = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nada que limpiar */
  }
}

/** Marca ESTA sesión de recuperación (evento PASSWORD_RECOVERY). Sin session_id legible no se marca nada. */
export function markRecoverySession(
  session: RecoverySessionLike,
  now = Date.now(),
): void {
  const sessionId = sessionIdFromAccessToken(session.access_token);
  if (!sessionId || !session.user?.id) {
    clearRecoveryMark();
    return;
  }
  writeMark({
    userId: session.user.id,
    sessionId,
    expiresAt: now + RECOVERY_MARK_MAX_AGE_MS,
  });
}

/**
 * ¿La sesión actual ES la sesión de recuperación marcada y la marca sigue vigente? Una marca caducada, de otra
 * cuenta o de otra sesión (p. ej. un inicio de sesión normal posterior) se LIMPIA y devuelve false.
 */
export function recoveryMarkMatches(
  session: RecoverySessionLike | null | undefined,
  now = Date.now(),
): boolean {
  const mark = readMark();
  if (!mark) return false;
  if (
    !session ||
    now >= mark.expiresAt ||
    mark.userId !== session.user?.id ||
    mark.sessionId !== sessionIdFromAccessToken(session.access_token)
  ) {
    // Sin sesión todavía no se limpia por si es una resolución en curso; el resto es una marca obsoleta.
    if (session) clearRecoveryMark();
    return false;
  }
  return true;
}

type AuthLike = {
  onAuthStateChange: (
    callback: (event: string, session: RecoverySessionLike | null) => void,
  ) => unknown;
};

/** Suscripción única (la llama supabase.ts al crear el cliente, antes de que supabase-js emita el evento). */
export function startRecoveryTracking(auth: AuthLike): void {
  auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY" && session) {
      markRecoverySession(session);
    } else if (event === "SIGNED_OUT") {
      clearRecoveryMark();
    } else if (event === "SIGNED_IN" && session) {
      // Un inicio de sesión distinto del marcado invalida la marca de inmediato.
      recoveryMarkMatches(session);
    }
  });
}

/** URL de retorno del correo de recuperación: siempre /reset-password del MISMO origen. Debe estar en la lista
 *  de redirecciones permitidas de Supabase Auth; si no lo está, Supabase usa su Site URL (sin riesgo). */
export function passwordResetRedirectUrl(): string | undefined {
  return typeof window === "undefined"
    ? undefined
    : `${window.location.origin}/reset-password`;
}
