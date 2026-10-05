import {
  CAPABILITY_VERSION,
  importCapabilityPrivateKey,
  signCapability,
  type KeyHandle,
  type CapabilityScope,
} from "./media-delivery-protocol.js";

// Emisión de capabilities de medios (R4-D1), SOLO backend. La clave privada Ed25519 nunca sale de
// Vercel; el Worker solo conoce claves públicas. Una capability está SIEMPRE ligada a un assetId y
// se emite únicamente después de que el handler llamador haya autorizado al usuario (ownership,
// capacidad de moderación + MFA reciente, o creador del asset). El token no lleva identidad:
// es un bearer token de vida corta; quien lo posea puede usarlo hasta `exp` (compromiso aceptado
// y acotado por los topes de abajo).

export const OWNER_CAPABILITY_TTL_SECONDS = 600;
export const MODERATOR_CAPABILITY_TTL_SECONDS = 600;
export const CREATOR_PREVIEW_CAPABILITY_TTL_SECONDS = 3600;
/** Margen que se resta a `purge_after` para absorber deriva de reloj entre backend y Worker. */
export const PURGE_SAFETY_MARGIN_SECONDS = 5;
/** Nombre del parámetro de query que transporta la capability en la URL del medio. */
export const CAPABILITY_QUERY_PARAM = "cap";

export interface CapabilitySigningConfig {
  privateKey: KeyHandle;
  keyId: string;
  audience: string;
}

/** Lee la configuración desde variables de entorno (nombres, nunca valores en el repo). Devuelve
 *  null si falta algo: el llamador debe fallar cerrado (no emitir URL privada). */
export async function loadCapabilitySigningConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<CapabilitySigningConfig | null> {
  const key = env.MEDIA_CAP_SIGNING_PRIVATE_KEY?.trim();
  const keyId = env.MEDIA_CAP_KEY_ID?.trim();
  const audience = env.MEDIA_CAP_AUDIENCE?.trim();
  if (!key || !keyId || !audience) return null;
  try {
    return { privateKey: await importCapabilityPrivateKey(key), keyId, audience };
  } catch {
    return null;
  }
}

export interface CapabilityExpiryInput {
  scope: CapabilityScope;
  /** Reloj del SERVIDOR (nunca del cliente), en milisegundos. */
  nowMs: number;
  /** Solo para posts retirados: instante de expiración lógica (purge_after) en ms. */
  purgeAfterMs?: number | null;
}

/** Expiración (segundos Unix) o null si no debe emitirse ninguna capability. Para posts
 *  retirados, `exp <= purge_after - margen` POR CONSTRUCCIÓN. */
export function computeCapabilityExpiry(input: CapabilityExpiryInput): number | null {
  const ttl =
    input.scope === "creator-preview"
      ? CREATOR_PREVIEW_CAPABILITY_TTL_SECONDS
      : input.scope === "moderator"
        ? MODERATOR_CAPABILITY_TTL_SECONDS
        : OWNER_CAPABILITY_TTL_SECONDS;
  const nowSeconds = Math.floor(input.nowMs / 1000);
  let exp = nowSeconds + ttl;
  if (input.purgeAfterMs !== undefined && input.purgeAfterMs !== null) {
    if (!Number.isFinite(input.purgeAfterMs)) return null;
    exp = Math.min(
      exp,
      Math.floor(input.purgeAfterMs / 1000) - PURGE_SAFETY_MARGIN_SECONDS,
    );
  }
  return exp > nowSeconds ? exp : null;
}

export async function issueCapability(
  config: CapabilitySigningConfig,
  input: { assetId: string; scope: CapabilityScope; expiresAtSeconds: number },
): Promise<string> {
  return signCapability(
    {
      v: CAPABILITY_VERSION,
      a: input.assetId,
      s: input.scope,
      e: input.expiresAtSeconds,
      u: config.audience,
      k: config.keyId,
    },
    config.privateKey,
  );
}

/** Añade la capability a una URL pública de medio (`?cap=<token>`). */
export function withCapability(url: string, token: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(CAPABILITY_QUERY_PARAM, token);
  return parsed.toString();
}
