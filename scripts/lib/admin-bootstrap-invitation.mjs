import { createHash, randomBytes } from "node:crypto";

// Lógica PURA del generador de invitaciones bootstrap_admin (Bloque 2B, ver
// supabase/migrations/20260923120000_admin_invitations.sql para el contrato de DB que
// esto alimenta). Ningún export de aquí hace I/O (red, Supabase, filesystem, env): solo
// genera el token, su hash y los datos derivados. Esto permite testear la lógica sin
// arriesgar generar nunca una invitación real durante `npm test`/`npm run build`. La
// inserción real en Supabase y la entrega del enlace viven exclusivamente en
// bootstrap-admin-invitation.mjs (el script operator-side), nunca aquí.

/** 256 bits de entropía — ver diseño de Bloque 2 (randomBytes de node:crypto, nunca un generador no criptográfico). */
export const BOOTSTRAP_TOKEN_BYTES = 32;

/** 7 días — expiración acordada para la invitación bootstrap (ver Bloque 2, sección 9). */
export const BOOTSTRAP_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Token de invitación de un solo uso: 256 bits de `node:crypto` codificados en
 * base64url (URL-safe, sin padding). Nunca un generador no criptográfico, un UUID ni
 * nada derivado de timestamps: ninguno de esos es criptográficamente impredecible.
 */
export function generateBootstrapToken() {
  return randomBytes(BOOTSTRAP_TOKEN_BYTES).toString("base64url");
}

/**
 * SHA-256 (hex, 64 caracteres) del token en claro. Es LO ÚNICO que se persiste en
 * admin_invitations.token_hash — el token en claro nunca llega a la base de datos.
 */
export function hashBootstrapToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Fila exacta a insertar en admin_invitations para el bootstrap del primer admin.
 * Nunca incluye el token en claro (solo su hash, ya calculado por el llamador).
 * `now` es inyectable para que los tests sean deterministas sin usar el reloj real.
 */
export function buildBootstrapInvitationRow(tokenHash, now = new Date()) {
  return {
    token_hash: tokenHash,
    role: "admin",
    invitation_type: "bootstrap_admin",
    created_by: null,
    expires_at: new Date(now.getTime() + BOOTSTRAP_EXPIRY_MS).toISOString(),
  };
}

/**
 * URL de activación con el token en el FRAGMENT (#token=...), nunca en query string: el
 * fragment no se envía al servidor HTTP (ni a logs de acceso ni al header Referer). El
 * frontend futuro (fuera de alcance de este bloque) deberá leerlo con
 * `location.hash` y borrarlo de inmediato con `history.replaceState`.
 */
export function buildActivationUrl(baseUrl, token) {
  return `${baseUrl}/admin/activate#token=${token}`;
}

/**
 * Valida la configuración de Supabase necesaria para insertar la invitación, a partir
 * de un objeto tipo `process.env` (inyectable para tests: nunca se le pasan secretos
 * reales fuera del script operator-side). Si falta algo, el mensaje de error nombra
 * ÚNICAMENTE la variable ausente, nunca su valor (ni el de ninguna otra variable
 * presente) — ni siquiera en el caso de que esa variable exista pero esté vacía.
 */
export function readSupabaseServiceConfig(env) {
  const url = env.VITE_SUPABASE_URL?.trim();
  if (!url) {
    throw new Error("Falta la variable de entorno VITE_SUPABASE_URL");
  }
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!serviceRoleKey) {
    throw new Error("Falta la variable de entorno SUPABASE_SERVICE_ROLE_KEY");
  }
  return { url, serviceRoleKey };
}
