// Helper de las Vercel Functions de Instagram (api/instagram-feed.ts,
// api/instagram-media.ts y api/instagram-comments.ts). Vive fuera de `api/` por la
// misma razón que twitch-shared.ts y youtube-shared.ts: cada archivo de `api/` se
// despliega como una ruta pública.
//
// Solo lectura, contra graph.instagram.com y siempre desde el servidor:
// - feed: `GET /me/media` (instagram_business_basic).
// - children de un carrusel: `GET /{media-id}/children` (instagram_business_basic).
// - perfil: `GET /me?fields=username,profile_picture_url` (instagram_business_basic).
// - comentarios: `GET /{media-id}/comments` (instagram_business_manage_comments). Solo un
//   error EXPLÍCITO de permisos de Meta se traduce en InstagramPermissionError (403).
//   Un HTTP 200 con `data: []` NO es falta de permisos: Meta puede devolver la lista
//   vacía aunque `comments_count` > 0, y se responde tal cual (lista vacía).
// Nada de publicar, mensajes ni insights.
// Cada llamada a Meta tiene un timeout de 10 s (INSTAGRAM_REQUEST_TIMEOUT_MS); si vence se
// responde 502 como cualquier otro fallo del proveedor.
//
// Regla de seguridad: el access token viaja en la query string de Meta, así que
// nunca se registra ni se devuelve una URL, un mensaje de Meta ni el error
// original de `fetch`. Solo se registran la operación, el status HTTP y el
// `type`/`code` de Meta, filtrados a un formato seguro.
import type {
  InstagramChild,
  InstagramComment,
  InstagramComments,
  InstagramMediaItem,
  InstagramProfile,
} from "../types/index.js";
import type {
  InstagramApiItem,
  InstagramCommentApiItem,
  InstagramCommentsResponse,
  InstagramMediaResponse,
  InstagramProfileApiItem,
} from "../types/api.js";

const INSTAGRAM_GRAPH_BASE = "https://graph.instagram.com";
const BASE_FIELDS =
  "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,username";
// Contadores y tipo de producto: se piden aparte para poder reintentar sin ellos si
// Meta rechaza alguno con el token actual (el feed nunca debe romperse por esto).
const EXTENDED_FIELDS = `${BASE_FIELDS},media_product_type,like_count,comments_count`;
const PROFILE_FIELDS = "username,profile_picture_url";
const CHILD_FIELDS = "id,media_type,media_url,thumbnail_url";
const COMMENT_FIELDS = "id,text,timestamp,username";
// like_count del comentario: se pide aparte y se reintenta sin él si Meta lo rechaza.
const COMMENT_FIELDS_WITH_LIKES = `${COMMENT_FIELDS},like_count`;
const MEDIA_LIMIT = 24;
const COMMENTS_LIMIT = 30;
const MAX_COMMENT_LENGTH = 2200;
/** Tiempo máximo de cada llamada a Meta (incluye la lectura del cuerpo). */
export const INSTAGRAM_REQUEST_TIMEOUT_MS = 10_000;

export class InstagramApiError extends Error {
  constructor(
    message: string,
    /** Status HTTP con el que responde la función (no el de Meta). */
    readonly status: number,
    /** Status HTTP y `error.code` de Meta, si los hubo. */
    readonly httpStatus?: number,
    readonly metaCode?: number,
    readonly metaSubcode?: number,
  ) {
    super(message);
    this.name = "InstagramApiError";
  }
}

/** El token no puede leer este recurso (falta un permiso): la función responde 403. */
export class InstagramPermissionError extends InstagramApiError {
  constructor(message: string) {
    super(message, 403);
    this.name = "InstagramPermissionError";
  }
}

export function getInstagramAccessToken(): string {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new InstagramApiError(
      "Falta la variable de entorno de Instagram: INSTAGRAM_ACCESS_TOKEN",
      503,
    );
  }
  return token;
}

// Meta devuelve `{ error: { type, code, ... } }`. Solo se aceptan identificadores
// cortos; el `message` de Meta nunca se lee.
async function getMetaError(
  response: Response,
): Promise<{ type: string; code?: number; subcode?: number }> {
  try {
    const body = (await response.json()) as {
      error?: { type?: unknown; code?: unknown; error_subcode?: unknown };
    };
    const { type, code, error_subcode: subcode } = body.error ?? {};
    return {
      type:
        typeof type === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(type)
          ? type
          : "unknown",
      code: typeof code === "number" && Number.isInteger(code) ? code : undefined,
      subcode:
        typeof subcode === "number" && Number.isInteger(subcode) ? subcode : undefined,
    };
  } catch {
    return { type: "unknown" };
  }
}

/**
 * GET a la API de Instagram. Añade el token, comprueba `response.ok` y, si Meta
 * falla, lanza un InstagramApiError (502) con operación, status y type/code de
 * Meta, sin la URL ni el mensaje original.
 */
async function fetchInstagram<T>(
  operation: string,
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const accessToken = getInstagramAccessToken();

  const url = new URL(`${INSTAGRAM_GRAPH_BASE}/${path}`);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  url.searchParams.set("access_token", accessToken);

  // AbortSignal.timeout cancela la petición (y la lectura del cuerpo) a los 10 s y se limpia
  // solo; no queda ningún temporizador vivo.
  const signal = AbortSignal.timeout(INSTAGRAM_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url.toString(), { signal });
  } catch (err) {
    // El error original de fetch puede arrastrar la URL (con el token): no se propaga.
    if (isTimeout(err)) throw timeoutError(operation);
    throw new InstagramApiError(`Instagram ${operation}: error de red`, 502);
  }

  if (!response.ok) {
    const { type, code, subcode } = await getMetaError(response);
    const detail = `${type}/${code ?? "unknown"}${subcode ? `/${subcode}` : ""}`;
    throw new InstagramApiError(
      `Instagram ${operation}: HTTP ${response.status} (${detail})`,
      502,
      response.status,
      code,
      subcode,
    );
  }

  try {
    return (await response.json()) as T;
  } catch (err) {
    if (isTimeout(err)) throw timeoutError(operation);
    throw new InstagramApiError(`Instagram ${operation}: respuesta no válida`, 502);
  }
}

// AbortSignal.timeout rechaza con un DOMException "TimeoutError".
const isTimeout = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  (err as { name?: unknown }).name === "TimeoutError";

// Mismo status (502) que cualquier otro fallo de Meta; el mensaje no lleva URL ni token.
const timeoutError = (operation: string) =>
  new InstagramApiError(
    `Instagram ${operation}: tiempo de espera agotado (${INSTAGRAM_REQUEST_TIMEOUT_MS / 1000} s)`,
    502,
  );

// ---------- Normalización ----------

function httpsUrl(value: unknown, host?: RegExp): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (!host || host.test(url.hostname))
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

const INSTAGRAM_HOST = /(^|\.)instagram\.com$/;

// Meta devuelve `2026-09-18T19:00:31+0000` (offset sin dos puntos), que Safari no
// parsea. Se reescribe a ISO 8601 estándar; si no es una fecha válida, `undefined`.
function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const iso = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  return Number.isNaN(new Date(iso).getTime()) ? undefined : iso;
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/**
 * Convierte un media de Meta en el contrato del frontend. Devuelve `null` si no
 * se puede pintar: tipo desconocido, sin permalink oficial, fecha inválida o sin
 * imagen utilizable.
 * - IMAGE y CAROUSEL_ALBUM usan `media_url` (foto / portada del carrusel).
 * - VIDEO usa `thumbnail_url` como imagen; su `media_url` (archivo de video) va
 *   aparte en `videoUrl`.
 */
export function normalizeInstagramMedia(
  item: InstagramApiItem,
): InstagramMediaItem | null {
  const { id, media_type: mediaType } = item;

  if (
    !id ||
    (mediaType !== "IMAGE" && mediaType !== "VIDEO" && mediaType !== "CAROUSEL_ALBUM")
  ) {
    return null;
  }

  const timestamp = normalizeTimestamp(item.timestamp);
  const permalink = httpsUrl(item.permalink, INSTAGRAM_HOST);
  const imageUrl = httpsUrl(mediaType === "VIDEO" ? item.thumbnail_url : item.media_url);
  if (!timestamp || !permalink || !imageUrl) return null;

  const productType =
    item.media_product_type === "REELS" || item.media_product_type === "FEED"
      ? item.media_product_type
      : undefined;

  return {
    id,
    mediaType,
    imageUrl,
    videoUrl: mediaType === "VIDEO" ? httpsUrl(item.media_url) : undefined,
    productType,
    permalink,
    caption: item.caption?.trim() || undefined,
    timestamp,
    username: item.username || undefined,
    likeCount: count(item.like_count),
    commentsCount: count(item.comments_count),
  };
}

/** Elemento de un carrusel (IMAGE o VIDEO); `null` si no tiene ningún recurso válido. */
export function normalizeInstagramChild(item: InstagramApiItem): InstagramChild | null {
  const { id, media_type: mediaType } = item;
  if (!id) return null;

  if (mediaType === "IMAGE") {
    const imageUrl = httpsUrl(item.media_url);
    return imageUrl ? { id, mediaType, imageUrl } : null;
  }

  if (mediaType === "VIDEO") {
    const videoUrl = httpsUrl(item.media_url);
    const imageUrl = httpsUrl(item.thumbnail_url);
    return videoUrl || imageUrl ? { id, mediaType, imageUrl, videoUrl } : null;
  }

  return null;
}

export function normalizeInstagramComment(
  item: InstagramCommentApiItem,
): InstagramComment | null {
  const text = typeof item.text === "string" ? item.text.trim() : "";
  if (!item.id || !text) return null;

  return {
    id: item.id,
    text: text.slice(0, MAX_COMMENT_LENGTH),
    username: item.username || undefined,
    timestamp: normalizeTimestamp(item.timestamp),
    likeCount: count(item.like_count),
  };
}

// ---------- Operaciones ----------

/** Media de la cuenta autorizada por el token, normalizado y sin descartados. */
export async function getInstagramMedia(): Promise<InstagramMediaItem[]> {
  const params = { limit: String(MEDIA_LIMIT) };

  let body: InstagramMediaResponse;
  try {
    body = await fetchInstagram<InstagramMediaResponse>("media", "me/media", {
      ...params,
      fields: EXTENDED_FIELDS,
    });
  } catch (err) {
    // 400 que no es de token (190): Meta rechazó algún campo extra con este
    // token. Se reintenta sin ellos para que el feed siga funcionando.
    const fieldRejected =
      err instanceof InstagramApiError && err.httpStatus === 400 && err.metaCode !== 190;
    if (!fieldRejected) throw err;

    logInstagramError("instagram-feed", err);
    body = await fetchInstagram<InstagramMediaResponse>("media", "me/media", {
      ...params,
      fields: BASE_FIELDS,
    });
  }

  if (!Array.isArray(body.data)) return [];
  return body.data.flatMap((item) => normalizeInstagramMedia(item) ?? []);
}

// Los ids de media de Instagram son numéricos; se valida antes de meterlos en la ruta.
export const isValidInstagramMediaId = (value: unknown): value is string =>
  typeof value === "string" && /^\d{1,32}$/.test(value);

/** Elementos de un carrusel, en el orden de Meta y sin los que no tienen recurso válido. */
export async function getInstagramChildren(mediaId: string): Promise<InstagramChild[]> {
  const body = await fetchInstagram<InstagramMediaResponse>(
    "children",
    `${mediaId}/children`,
    { fields: CHILD_FIELDS },
  );

  if (!Array.isArray(body.data)) return [];
  return body.data.flatMap((item) => normalizeInstagramChild(item) ?? []);
}

// Códigos de Meta que significan "el token no tiene permiso para esto" (10, 3 y el
// rango 200-299), a diferencia de un token caducado (190) o un fallo de Meta.
const isPermissionError = (err: unknown): err is InstagramApiError =>
  err instanceof InstagramApiError &&
  (err.httpStatus === 403 ||
    err.metaCode === 10 ||
    err.metaCode === 3 ||
    (err.metaCode !== undefined && err.metaCode >= 200 && err.metaCode <= 299));

async function fetchCommentsPage(mediaId: string): Promise<InstagramCommentsResponse> {
  const path = `${mediaId}/comments`;
  const limit = String(COMMENTS_LIMIT);
  try {
    return await fetchInstagram<InstagramCommentsResponse>("comments", path, {
      fields: COMMENT_FIELDS_WITH_LIKES,
      limit,
    });
  } catch (err) {
    // 400 que no es de permisos ni de token: Meta rechazó `like_count` del comentario.
    const fieldRejected =
      err instanceof InstagramApiError &&
      err.httpStatus === 400 &&
      err.metaCode !== 190 &&
      !isPermissionError(err);
    if (!fieldRejected) throw err;

    logInstagramError("instagram-comments", err);
    return fetchInstagram<InstagramCommentsResponse>("comments", path, {
      fields: COMMENT_FIELDS,
      limit,
    });
  }
}

/**
 * Comentarios de un media, solo lectura.
 * - Comentarios disponibles → `{ comments }`.
 * - Lista vacía (HTTP 200) → `{ comments: [] }`, tanto si no hay comentarios como si Meta
 *   no entrega su contenido aunque `comments_count` > 0. Nunca se interpreta como permiso.
 * - Error explícito de permisos de Meta (403, código 10 o 200-299) →
 *   InstagramPermissionError (403).
 * - Cualquier otro fallo del proveedor → InstagramApiError (502).
 */
export async function getInstagramComments(mediaId: string): Promise<InstagramComments> {
  let body: InstagramCommentsResponse;
  try {
    body = await fetchCommentsPage(mediaId);
  } catch (err) {
    if (isPermissionError(err)) throw new InstagramPermissionError(err.message);
    throw err;
  }

  const comments = Array.isArray(body.data)
    ? body.data.flatMap((item) => normalizeInstagramComment(item) ?? [])
    : [];
  return { comments };
}

/** Perfil normalizado: sin foto si Meta no la devuelve o la URL no es https. */
export function normalizeInstagramProfile(
  item: InstagramProfileApiItem,
): InstagramProfile {
  return {
    username: item.username || undefined,
    profilePictureUrl: httpsUrl(item.profile_picture_url),
  };
}

/** Perfil de la cuenta autorizada por el token (una sola petición; el handler lo cachea). */
export async function getInstagramProfile(): Promise<InstagramProfile> {
  let body: InstagramProfileApiItem;
  try {
    body = await fetchInstagram<InstagramProfileApiItem>("profile", "me", {
      fields: PROFILE_FIELDS,
    });
  } catch (err) {
    // 400 que no es de token (190): Meta rechazó la foto con este token. Se reintenta
    // solo con el username para que el perfil siga funcionando sin foto.
    const fieldRejected =
      err instanceof InstagramApiError && err.httpStatus === 400 && err.metaCode !== 190;
    if (!fieldRejected) throw err;

    logInstagramError("instagram-profile", err);
    body = await fetchInstagram<InstagramProfileApiItem>("profile", "me", {
      fields: "username",
    });
  }
  return normalizeInstagramProfile(body);
}

/** Registra solo el mensaje propio de InstagramApiError; cualquier otro error, solo su nombre. */
export function logInstagramError(handler: string, err: unknown): void {
  const detail = err instanceof InstagramApiError ? err.message : "error inesperado";
  console.error(`[${handler}] ${detail}`);
}

export function instagramErrorStatus(err: unknown): number {
  return err instanceof InstagramApiError ? err.status : 502;
}
