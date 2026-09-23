// Normalización y validación SERVER-SIDE del username público (Bloque 7C.1). La base de
// datos sigue siendo la autoridad final (CHECK profiles_username_format, UNIQUE
// profiles_username_key en supabase/migrations/20260924120000_profiles.sql); esto solo
// evita viajes inútiles y fija la política de nombres reservados, que NO vive en SQL.

/** Mismo patrón que el CHECK profiles_username_format: minúsculas ASCII, dígitos y
 *  guion bajo, 3–20 caracteres. Se aplica DESPUÉS de normalizar. */
export const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

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
  if (!USERNAME_PATTERN.test(username)) return { ok: false, reason: "invalid" };
  if (isReservedUsername(username)) return { ok: false, reason: "reserved" };
  return { ok: true, username };
}
