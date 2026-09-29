// Normalización y validación SERVER-SIDE del username público (Bloque 7C.1; formato
// congelado ampliado en 9J-1B). La base de datos sigue siendo la autoridad final (CHECK
// profiles_username_format, UNIQUE profiles_username_key —
// supabase/migrations/20261003120000_community_username_foundation.sql—); esto solo evita
// viajes inútiles y fija la política de nombres reservados, que NO vive en SQL.

/** Mismo conjunto de caracteres y longitud que el CHECK profiles_username_format:
 *  minúsculas ASCII, dígitos, guion bajo y punto, 3–24 caracteres. Se aplica DESPUÉS de
 *  normalizar. Las reglas de punto inicial/final/consecutivo NO caben en este regex (ERE
 *  de Postgres no tiene lookaround) — se comprueban aparte en isValidUsernameFormat, igual
 *  que en el CHECK de la base de datos (misma conjunción de condiciones a ambos lados). */
export const USERNAME_PATTERN = /^[a-z0-9_.]{3,24}$/;

/** Formato completo congelado (9J-1B): USERNAME_PATTERN + sin punto inicial, sin punto
 *  final, sin puntos consecutivos. Espera un valor YA normalizado (ver normalizeUsername). */
export function isValidUsernameFormat(username: string): boolean {
  if (!USERNAME_PATTERN.test(username)) return false;
  if (username.startsWith(".") || username.endsWith(".")) return false;
  if (username.includes("..")) return false;
  return true;
}

/**
 * Nombres que ningún usuario puede reclamar. Comparación sobre el username ya
 * normalizado (trim + lowercase). Lista centralizada y solo servidor: para ampliarla
 * basta añadir entradas aquí (en minúsculas), sin tocar ningún handler.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "moderator",
  "mod",
  "staff",
  "support",
  "official",
  "mina",
  "upmina",
  "upminaa",
  "root",
  "system",
  // Añadidos en 9J-1B (fundación de Comunidad): rutas/superficies del producto que un
  // username no puede suplantar.
  "community",
  "account",
  "api",
  "login",
  "signup",
  "settings",
  "cosplay",
  "media",
]);

/** trim + lowercase. Sin transliteración Unicode: "edwín" sigue siendo "edwín" (y por
 *  tanto inválido), no "edwin". */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isReservedUsername(normalized: string): boolean {
  return RESERVED_USERNAMES.has(normalized);
}

export type UsernameCheck =
  { ok: true; username: string } | { ok: false; reason: "invalid" | "reserved" };

/** Valida un valor desconocido del cliente y devuelve el username normalizado. */
export function checkUsername(raw: unknown): UsernameCheck {
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };
  const username = normalizeUsername(raw);
  if (!isValidUsernameFormat(username)) return { ok: false, reason: "invalid" };
  if (isReservedUsername(username)) return { ok: false, reason: "reserved" };
  return { ok: true, username };
}
