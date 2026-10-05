import {
  computeCapabilityExpiry,
  issueCapability,
  loadCapabilitySigningConfig,
  withCapability,
  type CapabilitySigningConfig,
} from "./media-capability.js";
import { parseMediaPath, type CapabilityScope } from "./media-delivery-protocol.js";
import { publicVariantUrl } from "./r2-client.js";

// Construcción centralizada de URLs de entrega de medios (R4-D2). Ningún handler construye URLs
// por su cuenta: todos pasan por aquí.
//
// Modos (explícitos, sin fallback inseguro silencioso):
//   - SEGURO: `MEDIA_DELIVERY_BASE_URL` definida → las URLs apuntan al Worker de entrega
//     (`<base>/<domain>/<assetId>/<archivo>`). Los estados privados añaden `?cap=<capability>`.
//   - LEGADO (aún sin cutover): sin esa variable, el contenido PÚBLICO sigue usando la URL pública
//     antigua (publicVariantUrl). Los estados PRIVADOS (HPR, retirado, vista del moderador) NO
//     tienen URL en este modo: nunca se finge privacidad devolviendo una URL pública.
// La vista previa del creador (asset listo sin adjuntar) conserva la URL legada en modo legado para
// no romper el editor antes del cutover.

export const MEDIA_DELIVERY_BASE_ENV = "MEDIA_DELIVERY_BASE_URL";

export class MediaDeliveryConfigError extends Error {}

/** Base del Worker de entrega validada, o null (modo legado). Una variable DEFINIDA pero inválida
 *  lanza: es una mala configuración, no un motivo para volver en silencio al modo legado. */
export function getMediaDeliveryBase(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env[MEDIA_DELIVERY_BASE_ENV]?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MediaDeliveryConfigError("Invalid media delivery base");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new MediaDeliveryConfigError("Invalid media delivery base");
  return url.origin;
}

export interface MediaUrlContext {
  /** Base del Worker o null (modo legado). */
  base: string | null;
  /** Configuración de firma de capabilities o null. */
  signing: CapabilitySigningConfig | null;
}

export async function loadMediaUrlContext(
  env: Record<string, string | undefined> = process.env,
): Promise<MediaUrlContext> {
  const base = getMediaDeliveryBase(env);
  return { base, signing: base ? await loadCapabilitySigningConfig(env) : null };
}

/** Valida la clave contra los patrones reales de medios y devuelve su path seguro. */
function safeKey(storageKey: string) {
  const parsed = parseMediaPath(`/${storageKey}`);
  if (!parsed) throw new MediaDeliveryConfigError("Invalid storage key");
  return parsed;
}

/** URL PÚBLICA (published Community o cualquier Cosplay): sin capability. */
export function publicMediaUrl(
  storageKey: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const base = getMediaDeliveryBase(env);
  if (!base) return publicVariantUrl(storageKey);
  return `${base}/${safeKey(storageKey).key}`;
}

export const communityPublicMediaUrl = publicMediaUrl;
export const cosplayPublicMediaUrl = publicMediaUrl;

/** URL PRIVADA Community con capability. null si el entrega segura no está configurada, si la clave
 *  no es de ese asset o si no debe emitirse capability (p. ej. `purge_after` ya pasó). Nunca cae a
 *  una URL pública. */
export async function privateCommunityMediaUrl(
  context: MediaUrlContext,
  input: {
    storageKey: string;
    assetId: string;
    scope: CapabilityScope;
    /** Reloj del SERVIDOR en ms. */
    nowMs: number;
    purgeAfterMs?: number | null;
  },
): Promise<string | null> {
  if (!context.base || !context.signing) return null;
  const parsed = safeKey(input.storageKey);
  if (parsed.domain !== "community" || parsed.assetId !== input.assetId) return null;
  const exp = computeCapabilityExpiry({
    scope: input.scope,
    nowMs: input.nowMs,
    purgeAfterMs: input.purgeAfterMs,
  });
  if (exp === null) return null;
  const token = await issueCapability(context.signing, {
    assetId: input.assetId,
    scope: input.scope,
    expiresAtSeconds: exp,
  });
  return withCapability(`${context.base}/${parsed.key}`, token);
}

export type CommunityMediaAccess =
  | { kind: "public" }
  | { kind: "private"; purgeAfterMs: number | null }
  | { kind: "none" };

/** Política de entrega por estado del post (la misma para owner y moderador). La decisión es
 *  SIEMPRE server-side, con el estado y el reloj del servidor:
 *    published                         → público (sin capability)
 *    hidden_pending_review             → privado
 *    removed_pending_purge, no vencido → privado, con tope en purge_after
 *    removed vencido / hidden / otro   → ninguno */
export function decideCommunityMediaAccess(input: {
  status: string;
  purgeAfterMs: number | null;
  nowMs: number;
}): CommunityMediaAccess {
  if (input.status === "published") return { kind: "public" };
  if (input.status === "hidden_pending_review")
    return { kind: "private", purgeAfterMs: null };
  if (
    input.status === "removed_pending_purge" &&
    input.purgeAfterMs !== null &&
    Number.isFinite(input.purgeAfterMs) &&
    input.nowMs < input.purgeAfterMs
  )
    return { kind: "private", purgeAfterMs: input.purgeAfterMs };
  return { kind: "none" };
}

/** URL de un medio Community para un VISOR AUTORIZADO (owner o moderador) según el estado del
 *  post. null = no hay URL (sin acceso o entrega segura no configurada). */
export async function communityMediaUrlForViewer(
  context: MediaUrlContext,
  input: {
    scope: "owner" | "moderator";
    status: string;
    purgeAfterMs: number | null;
    nowMs: number;
    storageKey: string;
    assetId: string;
  },
): Promise<string | null> {
  const access = decideCommunityMediaAccess(input);
  if (access.kind === "none") return null;
  if (access.kind === "public") return publicMediaUrl(input.storageKey);
  return privateCommunityMediaUrl(context, {
    storageKey: input.storageKey,
    assetId: input.assetId,
    scope: input.scope,
    nowMs: input.nowMs,
    purgeAfterMs: access.purgeAfterMs,
  });
}

/** Vista previa del creador (asset listo, aún sin adjuntar). En modo seguro: capability
 *  `creator-preview` (≤60 min, bearer). En modo legado: URL legada (sin garantía de privacidad,
 *  igual que hoy), para no romper el editor antes del cutover. */
export async function creatorPreviewMediaUrl(
  context: MediaUrlContext,
  input: { storageKey: string; assetId: string; nowMs: number },
): Promise<string | null> {
  if (!context.base) return publicVariantUrl(input.storageKey);
  return privateCommunityMediaUrl(context, {
    storageKey: input.storageKey,
    assetId: input.assetId,
    scope: "creator-preview",
    nowMs: input.nowMs,
  });
}

/** URLs de medios Community para un MODERADOR ya autorizado por el endpoint (JWT + capacidad de
 *  moderación + MFA reciente se verifican ANTES de llamar aquí; el Worker nunca decide eso).
 *  Devuelve solo las claves con URL disponible; el resto debe omitirse. El assetId sale de la
 *  propia clave (`community/<assetId>/…`), que el servidor escribió al procesar el asset. */
export async function moderatorMediaUrls(
  context: MediaUrlContext,
  input: {
    status: string;
    purgeAfterMs: number | null;
    nowMs: number;
    storageKeys: readonly string[];
  },
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  for (const storageKey of new Set(input.storageKeys)) {
    const parsed = safeKey(storageKey);
    if (parsed.domain !== "community") continue;
    const url = await communityMediaUrlForViewer(context, {
      scope: "moderator",
      status: input.status,
      purgeAfterMs: input.purgeAfterMs,
      nowMs: input.nowMs,
      storageKey,
      assetId: parsed.assetId,
    });
    if (url) urls.set(storageKey, url);
  }
  return urls;
}
