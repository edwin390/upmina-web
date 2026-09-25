// Token de invitación pendiente, SOLO EN MEMORIA (Fase 9G-2). Mantiene el token de un enlace
// /admin/activate#token=… mientras la persona navega DENTRO de la SPA (activate → login → MFA →
// activate), porque AdminActivatePage lo guarda en un ref que se pierde al desmontarse. Todavía
// NO está conectado a ningún flujo (eso es 9G-3/4).
//
// Decisión de seguridad: el token vive ÚNICAMENTE en una variable del módulo. Nunca en
// localStorage, sessionStorage, cookies, IndexedDB, URL/query, returnTo ni estado de React que
// llegue al DOM: un secreto de invitación no debe quedar almacenado at-rest en el navegador.
//
// LIMITACIÓN ASUMIDA (intencional): al ser memoria del módulo, un REFRESCO COMPLETO de la página
// (F5, cerrar y reabrir la pestaña, o salir a otro sitio y volver) PIERDE el token. No se
// "arregla" guardándolo en storage: la UX de ese caso (pedir que se reabra el enlace de
// invitación) se resuelve en 9G-4.
//
// Modelo:
//   - capturePendingInvitation(token): guarda el token SIN usuario (estado previo al login).
//   - bindPendingInvitationToUser(userId): lo asocia a la cuenta que acaba de autenticarse.
//   - readPendingInvitation(userId): lo devuelve sin consumirlo (para reintentar si la activación
//     falla por red). consumePendingInvitation(userId): lo devuelve y lo borra.
//   - Un token asociado a la cuenta A NUNCA se entrega a la cuenta B: el intento falla cerrado Y
//     destruye el token (no queda disponible para nadie).
//   - Caduca a los 30 minutos (PENDING_INVITATION_TTL_MS); al consultarlo vencido se destruye.
//   - clearPendingInvitation / discardPendingInvitationIfUserChanged para logout y cambio de
//     usuario cuando 9G-3/4 lo conecten.
//
// POLÍTICA DE CAPTURA (determinista): capturar un token válido SIEMPRE reemplaza al pendiente, esté
// sin asociar (T1 → T2 antes de autenticar) o ya asociado a una cuenta (T1 de A → T2). El reemplazo
// es completo: T1 se pierde sin posibilidad de recuperarlo, T2 empieza SIN usuario y con un TTL
// nuevo, y hay que volver a asociarlo (bind) antes de que una cuenta pueda leerlo. Nunca se
// fusionan ni se conserva el usuario de T1 para T2. Un token inválido no reemplaza nada. Se
// prefiere "el último enlace abierto gana" a bloquear a la persona hasta que venza el TTL.
// Reemplazar no concede nada: la invitación la valida el backend con la cuenta que la activa.
//
// LOGOUT / CAMBIO DE USUARIO: al recibir SIGNED_OUT, quien conecte esto (9G-3/4) debe llamar a
// clearPendingInvitation(): discardPendingInvitationIfUserChanged(null) conserva a propósito un
// token aún sin asociar, porque "sin usuario" también es el estado normal previo al login.
//
// AUTORIDAD: la forma del token que se comprueba aquí (alfabeto y longitud) solo evita guardar
// basura en memoria; NO sustituye la validación del backend (hash, estado, expiración, revocación,
// uso y las invariantes de la RPC), que sigue siendo la única autoridad y no se duplica en el
// frontend. Este módulo protege únicamente el transporte temporal del secreto.
//
// El token nunca se registra, no aparece en errores (ninguna función lanza con él) y ninguna
// función devuelve un objeto de estado que lo contenga: solo `readPendingInvitation` y
// `consumePendingInvitation` devuelven el string, y únicamente a quien presenta el userId correcto.
// Este módulo NO autoriza nada: el backend valida la invitación de forma independiente.

/** Vida máxima de un token pendiente. Vencido exactamente a los 30 min (límite exclusivo). */
export const PENDING_INVITATION_TTL_MS = 30 * 60 * 1000;

/** Alfabeto base64url (el formato real del token) y longitud acotada. Rechaza vacío, espacios,
 *  separadores de URL y todo lo que no pueda ser un token de invitación. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{1,512}$/;

interface PendingInvitation {
  readonly token: string;
  readonly capturedAt: number;
  readonly userId: string | null;
}

// Única copia del token. Módulo-privada: no se exporta ni se enumera.
let pending: PendingInvitation | null = null;

function isValidUserId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Devuelve el estado vigente, o destruye y devuelve null si ya caducó. */
function current(now: number): PendingInvitation | null {
  if (pending === null) return null;
  const age = now - pending.capturedAt;
  if (!Number.isFinite(age) || age < 0 || age >= PENDING_INVITATION_TTL_MS) {
    pending = null;
    return null;
  }
  return pending;
}

/**
 * Guarda un token nuevo SIN usuario (previo al login), reemplazando cualquier pendiente: el
 * enlace abierto más recientemente gana. Devuelve false, sin guardar nada, si no parece un token.
 */
export function capturePendingInvitation(
  token: unknown,
  now: number = Date.now(),
): boolean {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return false;
  pending = { token, capturedAt: now, userId: null };
  return true;
}

/**
 * Asocia el token pendiente a `userId` tras autenticarse. true si queda asociado a ese usuario
 * (también si ya lo estaba). false si no hay token vigente o `userId` no es válido. Si el token ya
 * pertenece a OTRO usuario, se destruye y devuelve false.
 */
export function bindPendingInvitationToUser(
  userId: unknown,
  now: number = Date.now(),
): boolean {
  const state = current(now);
  if (state === null || !isValidUserId(userId)) return false;
  if (state.userId === null) {
    pending = { token: state.token, capturedAt: state.capturedAt, userId };
    return true;
  }
  if (state.userId === userId) return true;
  pending = null;
  return false;
}

/**
 * Lee el token sin consumirlo.
 *   - `userId === null` (aún sin sesión): solo devuelve un token que todavía no está asociado a
 *     nadie; uno ya asociado a una cuenta no se entrega a quien no se identifica.
 *   - `userId` de un usuario: solo devuelve un token asociado a ESE usuario (hay que llamar antes
 *     a bindPendingInvitationToUser). Uno sin asociar no se entrega (fail closed); uno asociado a
 *     otra cuenta se destruye.
 */
export function readPendingInvitation(
  userId: string | null,
  now: number = Date.now(),
): string | null {
  const state = current(now);
  if (state === null) return null;

  if (userId === null) {
    return state.userId === null ? state.token : null;
  }
  if (!isValidUserId(userId)) return null;
  if (state.userId === null) return null;
  if (state.userId !== userId) {
    pending = null;
    return null;
  }
  return state.token;
}

/** Como readPendingInvitation, pero al entregar el token lo borra (un solo uso). */
export function consumePendingInvitation(
  userId: string | null,
  now: number = Date.now(),
): string | null {
  const token = readPendingInvitation(userId, now);
  if (token !== null) pending = null;
  return token;
}

/** ¿Hay un token vigente? No lo expone. Sirve para decidir qué mostrar sin tocar el secreto. */
export function hasPendingInvitation(now: number = Date.now()): boolean {
  return current(now) !== null;
}

/** Borra el token pendiente (logout, invitación usada o abandonada). */
export function clearPendingInvitation(): void {
  pending = null;
}

/**
 * Para logout y cambio de usuario: destruye un token asociado a una cuenta distinta de
 * `currentUserId` (o a cualquier cuenta si ya no hay sesión, `null`). Un token todavía sin
 * asociar (previo al login) se conserva cuando `currentUserId` es null.
 */
export function discardPendingInvitationIfUserChanged(
  currentUserId: string | null,
  now: number = Date.now(),
): void {
  const state = current(now);
  if (state === null || state.userId === null) return;
  if (state.userId !== currentUserId) pending = null;
}
