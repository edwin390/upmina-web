import {
  ACCESS_CHECK_METHOD,
  ACCESS_SIGNATURE_HEADER,
  ACCESS_TIMESTAMP_HEADER,
  importCapabilityPublicKey,
  isAssetUuid,
  parseMediaPath,
  signAccessRequest,
  verifyCapability,
  type ParsedMediaPath,
} from "../../../src/lib/media-delivery-protocol";

// Worker de entrega de medios (R4-D1). Única capa de lectura del bucket público:
//   /community/<uuid>/<archivo>  capability válida (local, Ed25519)  → sirve (private, no-store)
//                                sin capability válida → pregunta al backend (firmado, con caché)
//   /cosplay/<uuid>/w<N>.webp    passthrough público (sin autorización de moderación)
//   cualquier otra ruta          404
// El Worker NO tiene credenciales de Supabase. La autorización de bytes ocurre ANTES de cualquier
// lectura del bucket; este código no usa ninguna caché de bytes, así que un acierto de caché nunca
// puede saltarse la autorización.

export interface BucketObjectHead {
  size: number;
  httpEtag?: string;
}
export interface BucketObjectBody extends BucketObjectHead {
  body: ReadableStream<Uint8Array> | null;
}
export interface MediaBucket {
  head(key: string): Promise<BucketObjectHead | null>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<BucketObjectBody | null>;
}
export interface MediaEnv {
  MEDIA_BUCKET: MediaBucket;
  /** JSON { "<kid>": "<SPKI base64>" } */
  MEDIA_CAP_PUBLIC_KEYS: string;
  MEDIA_CAP_AUDIENCE: string;
  MEDIA_CHECK_URL: string;
  MEDIA_CHECK_SHARED_SECRET: string;
}

export const POSITIVE_TTL_MS = 30_000;
export const NEGATIVE_TTL_MS = 5_000;
export const CHECK_TIMEOUT_MS = 5_000;
const MAX_CACHE_ENTRIES = 2000;

export const PUBLIC_CACHE_CONTROL = "public, max-age=60";
export const PRIVATE_CACHE_CONTROL = "private, no-store";
export const COSPLAY_CACHE_CONTROL = "public, max-age=31536000, immutable";

export class AuthorizationUnavailable extends Error {}

interface Decision {
  public: boolean;
  at: number;
}

/** Caché de DECISIONES de autorización (no de bytes): positiva 30 s, negativa 5 s. Pasado ese TTL
 *  la decisión DEBE reconfirmarse con el backend: si no puede, falla cerrado
 *  (AuthorizationUnavailable → 503). Nunca se sirve una decisión positiva vencida ("stale"): la
 *  moderación prioriza la revocación sobre la disponibilidad. Ventana máxima de exposición causada
 *  por esta caché: POSITIVE_TTL_MS + la latencia de la consulta. */
export class PublicDecisionCache {
  private readonly entries = new Map<string, Decision>();
  private readonly inflight = new Map<string, Promise<boolean>>();

  async decide(
    assetId: string,
    now: () => number,
    check: () => Promise<boolean>,
  ): Promise<boolean> {
    const cached = this.entries.get(assetId);
    if (cached) {
      const age = now() - cached.at;
      if (age >= 0 && age < (cached.public ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS))
        return cached.public;
    }
    const pending = this.inflight.get(assetId);
    if (pending) return pending;
    const run = (async () => {
      try {
        const result = await check();
        this.store(assetId, { public: result, at: now() });
        return result;
      } catch {
        throw new AuthorizationUnavailable();
      } finally {
        this.inflight.delete(assetId);
      }
    })();
    this.inflight.set(assetId, run);
    return run;
  }

  private store(assetId: string, decision: Decision) {
    this.entries.delete(assetId);
    this.entries.set(assetId, decision);
    while (this.entries.size > MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export interface HandlerDeps {
  now?: () => number;
  fetchImpl?: typeof fetch;
  cache?: PublicDecisionCache;
}

const keyCache = new Map<string, Promise<Record<string, CryptoKey>>>();
async function loadKeys(raw: string): Promise<Record<string, CryptoKey>> {
  let pending = keyCache.get(raw);
  if (!pending) {
    pending = (async () => {
      const keys: Record<string, CryptoKey> = {};
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [kid, spki] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof spki !== "string") continue;
            try {
              keys[kid] = await importCapabilityPublicKey(spki);
            } catch {
              // Clave inválida: ese kid queda desconocido (fail closed).
            }
          }
        }
      } catch {
        // JSON inválido: ningún kid conocido.
      }
      return keys;
    })();
    keyCache.set(raw, pending);
  }
  return pending;
}

const defaultCache = new PublicDecisionCache();

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function unavailable(): Response {
  return new Response("Service unavailable", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "5",
    },
  });
}

async function checkPublic(
  env: MediaEnv,
  assetId: string,
  now: () => number,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const url = new URL(env.MEDIA_CHECK_URL);
  const { timestamp, signature } = await signAccessRequest(
    env.MEDIA_CHECK_SHARED_SECRET,
    {
      method: ACCESS_CHECK_METHOD,
      path: url.pathname,
      timestampSeconds: Math.floor(now() / 1000),
      assetId,
    },
  );
  const response = await fetchImpl(url.toString(), {
    method: ACCESS_CHECK_METHOD,
    headers: {
      "Content-Type": "application/json",
      [ACCESS_TIMESTAMP_HEADER]: timestamp,
      [ACCESS_SIGNATURE_HEADER]: signature,
    },
    body: JSON.stringify({ assetId }),
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (response.status !== 200) throw new Error("check failed");
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    Object.keys(body).join(",") !== "public" ||
    typeof (body as { public: unknown }).public !== "boolean"
  )
    throw new Error("invalid check response");
  return (body as { public: boolean }).public;
}

type RangeResult =
  | { kind: "none" }
  | { kind: "range"; start: number; end: number }
  | { kind: "unsatisfiable" };

/** Un único rango `bytes=a-b`, `bytes=a-` o `bytes=-n`. Una cabecera malformada o con varios
 *  rangos se IGNORA (respuesta completa, RFC 9110); un rango válido fuera del objeto es 416. */
export function parseRange(header: string | null, size: number): RangeResult {
  if (!header) return { kind: "none" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return { kind: "none" };
  if (size <= 0) return { kind: "unsatisfiable" };
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix === 0) return { kind: "unsatisfiable" };
    return { kind: "range", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  if (!Number.isSafeInteger(start)) return { kind: "none" };
  if (start >= size) return { kind: "unsatisfiable" };
  let end = m[2] === "" ? size - 1 : Number(m[2]);
  if (!Number.isSafeInteger(end)) return { kind: "none" };
  if (end < start) return { kind: "none" };
  end = Math.min(end, size - 1);
  return { kind: "range", start, end };
}

async function serveObject(
  request: Request,
  env: MediaEnv,
  media: ParsedMediaPath,
  cacheControl: string,
  isPrivate: boolean,
): Promise<Response> {
  const head = await env.MEDIA_BUCKET.head(media.key);
  if (!head) return notFound();
  const headers = new Headers({
    "Content-Type": media.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  });
  if (isPrivate) headers.set("Referrer-Policy", "no-referrer");
  if (head.httpEtag) headers.set("ETag", head.httpEtag);

  const range = parseRange(request.headers.get("Range"), head.size);
  if (range.kind === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (
    range.kind === "none" &&
    head.httpEtag &&
    request.headers.get("If-None-Match") === head.httpEtag
  )
    return new Response(null, { status: 304, headers });

  const isRange = range.kind === "range";
  const length = isRange ? range.end - range.start + 1 : head.size;
  headers.set("Content-Length", String(length));
  if (isRange)
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${head.size}`);
  const status = isRange ? 206 : 200;
  if (request.method === "HEAD") return new Response(null, { status, headers });

  const object = await env.MEDIA_BUCKET.get(
    media.key,
    isRange ? { range: { offset: range.start, length } } : undefined,
  );
  if (!object || !object.body) return notFound();
  return new Response(object.body, { status, headers });
}

export async function handleMediaRequest(
  request: Request,
  env: MediaEnv,
  deps: HandlerDeps = {},
): Promise<Response> {
  const now = deps.now ?? Date.now;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
    });
  }
  const url = new URL(request.url);
  const media = parseMediaPath(url.pathname);
  if (!media) return notFound();

  if (media.domain === "cosplay")
    return serveObject(request, env, media, COSPLAY_CACHE_CONTROL, false);

  const token = url.searchParams.get("cap");
  if (token) {
    const result = await verifyCapability({
      token,
      assetId: media.assetId,
      audience: env.MEDIA_CAP_AUDIENCE,
      nowSeconds: Math.floor(now() / 1000),
      keys: await loadKeys(env.MEDIA_CAP_PUBLIC_KEYS),
    });
    if (result.ok) return serveObject(request, env, media, PRIVATE_CACHE_CONTROL, true);
    // Capability inválida o vencida: se trata como si no existiera (un asset público sigue
    // siéndolo). Nunca se revela por qué falló.
  }

  if (!isAssetUuid(media.assetId)) return notFound();
  let allowed: boolean;
  try {
    allowed = await (deps.cache ?? defaultCache).decide(media.assetId, now, () =>
      checkPublic(env, media.assetId, now, deps.fetchImpl ?? fetch),
    );
  } catch {
    return unavailable();
  }
  if (!allowed) return notFound();
  return serveObject(request, env, media, PUBLIC_CACHE_CONTROL, false);
}
