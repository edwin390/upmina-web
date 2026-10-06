// Protocolo de entrega de medios (R4-D1). Módulo ISOMÓRFICO y puro: lo importan tanto el backend
// (Vercel/Node) como el Worker de Cloudflare, así que solo usa Web Crypto, TextEncoder y btoa/atob.
// Nunca importa nada de Node ni del navegador.
//
// Contiene tres piezas independientes:
//   1. Capabilities privadas Ed25519 (owner / moderator / creator-preview): el backend firma con la
//      clave privada; el Worker SOLO conoce claves públicas.
//   2. Firma HMAC de la petición Worker → backend (/api/media/access): solo permite preguntar
//      "¿es público este asset Community?".
//   3. Parser estricto de rutas de medios: la clave R2 se CONSTRUYE desde campos validados, nunca
//      se deriva del path recibido.

export const CAPABILITY_VERSION = 1;
export const CAPABILITY_SCOPES = ["owner", "moderator", "creator-preview"] as const;
export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];

/** Tope de vida aceptado por el verificador aunque la firma sea válida (defensa en profundidad):
 *  creator-preview es el scope más largo (60 min). */
export const MAX_CAPABILITY_LIFETIME_SECONDS = 3600;
export const MAX_CAPABILITY_TOKEN_LENGTH = 512;

export interface CapabilityPayload {
  /** Versión del formato. */
  v: typeof CAPABILITY_VERSION;
  /** assetId (UUID en minúsculas). */
  a: string;
  /** scope. */
  s: CapabilityScope;
  /** Expiración en segundos Unix. */
  e: number;
  /** Audience exacta (entorno): p. ej. "upmina-media-testing". */
  u: string;
  /** Identificador de la clave de firma. */
  k: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isAssetUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_RE.test(value);

// Tipos derivados del `crypto` global para compilar igual con lib DOM (SPA/Worker) y sin ella
// (backend Node).
export type KeyHandle = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
type BytesInput = Parameters<typeof crypto.subtle.sign>[2];

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// 1. Capabilities Ed25519

const SIGNING_PREFIX = "upmina-media-cap-v1\n";

/** Formato del token: `v1.<payload-base64url>.<firma-base64url>`. La firma cubre
 *  `upmina-media-cap-v1\n<payload-base64url>` (separación de dominio). */
function signingInput(payloadB64: string): Uint8Array {
  return encoder.encode(SIGNING_PREFIX + payloadB64);
}

/** Importa una clave privada Ed25519 en formato PKCS#8 (base64 estándar). Solo backend. */
export async function importCapabilityPrivateKey(
  pkcs8Base64: string,
): Promise<KeyHandle> {
  const bytes = fromBase64(pkcs8Base64.trim());
  if (!bytes) throw new Error("Invalid signing key");
  return crypto.subtle.importKey("pkcs8", bytes as BytesInput, "Ed25519", false, [
    "sign",
  ]);
}

/** Importa una clave pública Ed25519 en formato SPKI (base64 estándar). */
export async function importCapabilityPublicKey(spkiBase64: string): Promise<KeyHandle> {
  const bytes = fromBase64(spkiBase64.trim());
  if (!bytes) throw new Error("Invalid public key");
  return crypto.subtle.importKey("spki", bytes as BytesInput, "Ed25519", false, [
    "verify",
  ]);
}

export async function signCapability(
  payload: CapabilityPayload,
  privateKey: KeyHandle,
): Promise<string> {
  const payloadB64 = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      privateKey,
      signingInput(payloadB64) as BytesInput,
    ),
  );
  return `v${CAPABILITY_VERSION}.${payloadB64}.${toBase64Url(signature)}`;
}

export type CapabilityFailure =
  | "malformed"
  | "version"
  | "unknown-kid"
  | "signature"
  | "audience"
  | "asset"
  | "scope"
  | "expired"
  | "lifetime";

export type CapabilityResult =
  { ok: true; payload: CapabilityPayload } | { ok: false; reason: CapabilityFailure };

function parsePayload(bytes: Uint8Array): CapabilityPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const keys = Object.keys(p).sort().join(",");
  if (keys !== "a,e,k,s,u,v") return null;
  if (typeof p.a !== "string" || typeof p.u !== "string" || typeof p.k !== "string")
    return null;
  if (typeof p.e !== "number" || !Number.isSafeInteger(p.e)) return null;
  if (typeof p.s !== "string" || typeof p.v !== "number") return null;
  return p as unknown as CapabilityPayload;
}

export interface VerifyCapabilityInput {
  token: string;
  /** assetId de la URL solicitada: la capability NUNCA es universal. */
  assetId: string;
  /** Audience esperada, exacta. */
  audience: string;
  /** Segundos Unix según el reloj del verificador. */
  nowSeconds: number;
  /** Claves públicas por kid. */
  keys: Readonly<Record<string, KeyHandle>>;
  allowedScopes?: readonly CapabilityScope[];
}

/** Verifica una capability. Falla cerrado ante cualquier irregularidad. Solo Ed25519: el token no
 *  puede negociar algoritmo (no existe campo `alg`) y la versión desconocida se rechaza. */
export async function verifyCapability(
  input: VerifyCapabilityInput,
): Promise<CapabilityResult> {
  const { token } = input;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_CAPABILITY_TOKEN_LENGTH
  )
    return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  if (parts[0] !== `v${CAPABILITY_VERSION}`) {
    return { ok: false, reason: /^v\d+$/.test(parts[0]) ? "version" : "malformed" };
  }
  const payloadBytes = fromBase64Url(parts[1]);
  const signature = fromBase64Url(parts[2]);
  if (!payloadBytes || !signature || signature.length !== 64)
    return { ok: false, reason: "malformed" };
  const payload = parsePayload(payloadBytes);
  if (!payload) return { ok: false, reason: "malformed" };
  if (payload.v !== CAPABILITY_VERSION) return { ok: false, reason: "version" };
  const key = Object.prototype.hasOwnProperty.call(input.keys, payload.k)
    ? input.keys[payload.k]
    : undefined;
  if (!key) return { ok: false, reason: "unknown-kid" };
  const valid = await crypto.subtle.verify(
    "Ed25519",
    key,
    signature as BytesInput,
    signingInput(parts[1]) as BytesInput,
  );
  if (!valid) return { ok: false, reason: "signature" };
  // Desde aquí el payload es de confianza (firmado).
  if (payload.u !== input.audience) return { ok: false, reason: "audience" };
  if (!isAssetUuid(payload.a) || payload.a !== input.assetId)
    return { ok: false, reason: "asset" };
  const scopes = input.allowedScopes ?? CAPABILITY_SCOPES;
  if (!(scopes as readonly string[]).includes(payload.s))
    return { ok: false, reason: "scope" };
  if (payload.e <= input.nowSeconds) return { ok: false, reason: "expired" };
  if (payload.e - input.nowSeconds > MAX_CAPABILITY_LIFETIME_SECONDS)
    return { ok: false, reason: "lifetime" };
  return { ok: true, payload };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// 2. Petición firmada Worker → backend

export const ACCESS_CHECK_PATH = "/api/media/access";
export const ACCESS_CHECK_METHOD = "POST";
/** Tolerancia de reloj en ambos sentidos. Una ventana corta limita el replay. */
export const ACCESS_CHECK_TOLERANCE_SECONDS = 30;
export const ACCESS_TIMESTAMP_HEADER = "x-media-timestamp";
export const ACCESS_SIGNATURE_HEADER = "x-media-signature";

function canonicalAccessRequest(input: {
  method: string;
  path: string;
  timestamp: string;
  assetId: string;
}): Uint8Array {
  // El "body" firmado es el assetId: el cuerpo JSON legítimo solo contiene ese campo.
  return encoder.encode(
    [
      "UPMINA-MEDIA-ACCESS-V1",
      input.method.toUpperCase(),
      input.path,
      input.timestamp,
      input.assetId,
    ].join("\n"),
  );
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<KeyHandle> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret) as BytesInput,
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function signAccessRequest(
  secret: string,
  input: { method: string; path: string; timestampSeconds: number; assetId: string },
): Promise<{ timestamp: string; signature: string }> {
  const timestamp = String(input.timestampSeconds);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await hmacKey(secret, "sign"),
      canonicalAccessRequest({ ...input, timestamp }) as BytesInput,
    ),
  );
  return { timestamp, signature: toBase64Url(signature) };
}

export type AccessRequestFailure = "malformed" | "timestamp" | "signature";

/** Valida timestamp y firma. `crypto.subtle.verify` compara en tiempo constante.
 *
 *  Anti-replay: SIN estado por diseño. Un replay dentro de la ventana (±30 s) solo puede repetir
 *  una consulta de solo lectura que devuelve un booleano sobre un assetId ya firmado; no amplía
 *  privilegios ni permite consultar otro asset (el assetId está dentro de la firma). */
export async function verifyAccessRequest(
  secret: string,
  input: {
    method: string;
    path: string;
    timestamp: string | undefined;
    signature: string | undefined;
    assetId: string;
    nowSeconds: number;
  },
): Promise<{ ok: true } | { ok: false; reason: AccessRequestFailure }> {
  if (!input.timestamp || !input.signature || !/^\d{1,12}$/.test(input.timestamp))
    return { ok: false, reason: "malformed" };
  const signature = fromBase64Url(input.signature);
  if (!signature || signature.length !== 32) return { ok: false, reason: "malformed" };
  if (
    Math.abs(input.nowSeconds - Number(input.timestamp)) > ACCESS_CHECK_TOLERANCE_SECONDS
  )
    return { ok: false, reason: "timestamp" };
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    signature as BytesInput,
    canonicalAccessRequest({
      method: input.method,
      path: input.path,
      timestamp: input.timestamp,
      assetId: input.assetId,
    }) as BytesInput,
  );
  return valid ? { ok: true } : { ok: false, reason: "signature" };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// 2b. Petición firmada del scheduler → backend (/api/media/gc) — R4-E2
//
// Separación de dominio: prefijo canónico propio ("UPMINA-MEDIA-GC-V1"), secreto propio
// (MEDIA_GC_SHARED_SECRET) y SIN assetId: una firma de /api/media/access (canónico
// "UPMINA-MEDIA-ACCESS-V1…") nunca verifica aquí, ni viceversa. El cuerpo debe ser vacío; la
// petición no elige assets, claves, buckets ni límites. Replay: ventana de ±30 s; una repetición
// dentro de ella solo vuelve a ejecutar un lote GC idempotente decidido por la BD.

export const GC_REQUEST_PATH = "/api/media/gc";
export const GC_REQUEST_METHOD = "POST";
export const GC_TOLERANCE_SECONDS = 30;

function canonicalGcRequest(input: {
  method: string;
  path: string;
  timestamp: string;
}): Uint8Array {
  return encoder.encode(
    ["UPMINA-MEDIA-GC-V1", input.method.toUpperCase(), input.path, input.timestamp].join(
      "\n",
    ),
  );
}

export async function signGcRequest(
  secret: string,
  input: { method: string; path: string; timestampSeconds: number },
): Promise<{ timestamp: string; signature: string }> {
  const timestamp = String(input.timestampSeconds);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await hmacKey(secret, "sign"),
      canonicalGcRequest({ ...input, timestamp }) as BytesInput,
    ),
  );
  return { timestamp, signature: toBase64Url(signature) };
}

export async function verifyGcRequest(
  secret: string,
  input: {
    method: string;
    path: string;
    timestamp: string | undefined;
    signature: string | undefined;
    nowSeconds: number;
  },
): Promise<{ ok: true } | { ok: false; reason: AccessRequestFailure }> {
  if (!input.timestamp || !input.signature || !/^\d{1,12}$/.test(input.timestamp))
    return { ok: false, reason: "malformed" };
  const signature = fromBase64Url(input.signature);
  if (!signature || signature.length !== 32) return { ok: false, reason: "malformed" };
  if (Math.abs(input.nowSeconds - Number(input.timestamp)) > GC_TOLERANCE_SECONDS)
    return { ok: false, reason: "timestamp" };
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    signature as BytesInput,
    canonicalGcRequest({
      method: input.method,
      path: input.path,
      timestamp: input.timestamp,
    }) as BytesInput,
  );
  return valid ? { ok: true } : { ok: false, reason: "signature" };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// 3. Rutas de medios

export const COMMUNITY_VARIANT_WIDTHS = [480, 960, 1600, 2560] as const;
export const COMMUNITY_VIDEO_EXTENSIONS = ["mp4", "mov", "webm"] as const;

const VIDEO_CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

export interface ParsedMediaPath {
  domain: "community" | "cosplay";
  assetId: string;
  /** Clave R2 construida desde campos validados (nunca el path recibido). */
  key: string;
  contentType: string;
}

const COMMUNITY_FILE_RE = /^(?:w(480|960|1600|2560)\.webp|original\.(mp4|mov|webm))$/;
const COSPLAY_FILE_RE = /^w(480|960|1600|2560)\.webp$/;

/** Parsea `/community/<uuid>/<archivo>` o `/cosplay/<uuid>/w<N>.webp`. Rechaza cualquier cosa
 *  fuera de esos patrones exactos: `%` (codificado, incluido doble), `\`, `..`, `//`, query. */
export function parseMediaPath(pathname: string): ParsedMediaPath | null {
  if (typeof pathname !== "string" || pathname.length > 200) return null;
  if (/[%\\?#\s]/.test(pathname) || pathname.includes("..") || pathname.includes("//"))
    return null;
  const segments = pathname.split("/");
  if (segments.length !== 4 || segments[0] !== "") return null;
  const [, domain, assetId, file] = segments;
  if (!isAssetUuid(assetId)) return null;
  if (domain === "community") {
    const m = COMMUNITY_FILE_RE.exec(file);
    if (!m) return null;
    const contentType = m[1] ? "image/webp" : VIDEO_CONTENT_TYPES[m[2]];
    return { domain, assetId, key: `community/${assetId}/${file}`, contentType };
  }
  if (domain === "cosplay") {
    if (!COSPLAY_FILE_RE.test(file)) return null;
    return {
      domain,
      assetId,
      key: `cosplay/${assetId}/${file}`,
      contentType: "image/webp",
    };
  }
  return null;
}
