import type {
  InstagramMediaItem,
  InstagramProfile,
  TikTokVideo,
  TwitchClip,
  TwitchVideo,
  YouTubeVideo,
} from "../types/index.js";

// Definiciones canónicas de los snapshots públicos "last-known-good" (Fase 9H-4, checkpoint 2).
// Solo servidor y solo tipos + validación pura: aquí no hay E/S. La persistencia vive en
// public-snapshots.ts; ningún endpoint la usa todavía.
//
// Qué es un snapshot: la ÚLTIMA respuesta pública NORMALIZADA y válida de un recurso, con la que
// un endpoint podrá responder si el proveedor falla de forma transitoria. Por eso:
//   * Los recursos son una lista CERRADA (8). No existe "twitch-status" (un LIVE/OFFLINE rancio
//     miente) ni instagram-media/instagram-comments (por publicación, URLs firmadas, contenido de
//     terceros): no hay forma de representarlos ni en tipos ni en ejecución.
//   * Los validadores se aplican ANTES de escribir y DESPUÉS de leer (una fila de la base de datos
//     no es de fiar). Son ESTRICTOS: reconstruyen el valor solo con los campos conocidos y
//     rechazan cualquier clave desconocida, de modo que una respuesta cruda del proveedor, un token
//     o una credencial no pueden colarse en un snapshot.
//   * "Vacío válido" y "respuesta mal formada" son cosas distintas: `[]` es un vacío válido en una
//     lista; un contenedor que falta, un objeto de otra forma o un texto NO lo son y se rechazan.
//
// La edad máxima de cada recurso está centralizada aquí (SNAPSHOT_MAX_AGE_MS).

const HOUR_MS = 3_600_000;

/** Edades máximas de servicio de un snapshot. Único punto donde se ajustan. */
export const SNAPSHOT_MAX_AGE_MS = {
  /** Contenido público duradero (miniaturas y enlaces permanentes): 48 h. */
  durable: 48 * HOUR_MS,
  /** Redes con conexión (URLs firmadas que caducan; no esconder problemas de conexión): 24 h. */
  social: 24 * HOUR_MS,
} as const;

export type SnapshotProvider = "twitch" | "youtube" | "instagram" | "tiktok";
/** Proveedores con conexión social: los únicos cuyos snapshots se borran al desconectar. */
export type SocialSnapshotProvider = "instagram" | "tiktok";

/** Lista CERRADA de recursos. `twitch-status` NO está y no debe estar. */
export const SNAPSHOT_RESOURCES = [
  "twitch-clips",
  "twitch-latest-video",
  "youtube-latest",
  "youtube-videos",
  "youtube-shorts",
  "instagram-feed",
  "instagram-profile",
  "tiktok-videos",
] as const;

export type SnapshotResource = (typeof SNAPSHOT_RESOURCES)[number];

/** Valor NORMALIZADO y público de cada recurso; `null` = "no hay contenido" (vacío válido). */
export interface SnapshotPayloads {
  "twitch-clips": TwitchClip[];
  "twitch-latest-video": TwitchVideo | null;
  "youtube-latest": YouTubeVideo | null;
  "youtube-videos": YouTubeVideo[];
  "youtube-shorts": YouTubeVideo[];
  "instagram-feed": InstagramMediaItem[];
  "instagram-profile": InstagramProfile;
  "tiktok-videos": TikTokVideo[];
}

export type SnapshotValue<R extends SnapshotResource> = SnapshotPayloads[R];

/** Proveedor de cada recurso, a nivel de tipos: impide usar el source_id de otro proveedor. */
export interface SnapshotProviders {
  "twitch-clips": "twitch";
  "twitch-latest-video": "twitch";
  "youtube-latest": "youtube";
  "youtube-videos": "youtube";
  "youtube-shorts": "youtube";
  "instagram-feed": "instagram";
  "instagram-profile": "instagram";
  "tiktok-videos": "tiktok";
}

export type ProviderOf<R extends SnapshotResource> = SnapshotProviders[R];

export function isSnapshotResource(value: unknown): value is SnapshotResource {
  return (
    typeof value === "string" && (SNAPSHOT_RESOURCES as readonly string[]).includes(value)
  );
}

// ---------- Identidad de la fuente (source_id) ----------
//
// Un snapshot solo se sirve para la MISMA fuente con la que se obtuvo. Cambiar el canal
// configurado, desconectar/reconectar una red o cambiar de cuenta cambia el source_id e
// invalida el snapshot anterior. El source_id NUNCA sale por la API pública.

declare const sourceIdBrand: unique symbol;

/** source_id ya construido y validado para un proveedor (no se puede fabricar con un string). */
export type SnapshotSourceId<P extends SnapshotProvider = SnapshotProvider> = string & {
  readonly [sourceIdBrand]: P;
};

/** Longitud máxima de un source_id (coincide con el CHECK de la base de datos). */
export const MAX_SOURCE_ID_LENGTH = 200;

const TWITCH_LOGIN = /^[a-z0-9_]{1,25}$/;
const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** ASCII visible salvo ":" (el separador): así `provider:uuid:userId` es inequívoco. */
const PROVIDER_USER_ID = /^[\x21-\x39\x3b-\x7e]{1,128}$/;

const brand = <P extends SnapshotProvider>(value: string): SnapshotSourceId<P> =>
  value as SnapshotSourceId<P>;

/** `twitch:<login del canal configurado en minúsculas>`; `undefined` si no es un login válido. */
export function twitchSourceId(channel: unknown): SnapshotSourceId<"twitch"> | undefined {
  if (typeof channel !== "string") return undefined;
  const login = channel.trim().toLowerCase();
  return TWITCH_LOGIN.test(login) ? brand<"twitch">(`twitch:${login}`) : undefined;
}

/** `youtube:<UC… del canal configurado>`; `undefined` si no tiene la forma de un id de canal. */
export function youtubeSourceId(
  channelId: unknown,
): SnapshotSourceId<"youtube"> | undefined {
  if (typeof channelId !== "string") return undefined;
  const id = channelId.trim();
  return YOUTUBE_CHANNEL_ID.test(id) ? brand<"youtube">(`youtube:${id}`) : undefined;
}

/**
 * `<provider>:<id de la conexión>:<provider_user_id>`. El id de la fila de social_connections
 * cambia si se desconecta y se vuelve a conectar, y provider_user_id si cambia la cuenta: ambos
 * invalidan el snapshot. `undefined` si algún componente no tiene la forma esperada.
 */
export function socialSourceId<P extends SocialSnapshotProvider>(
  provider: P,
  connectionId: unknown,
  providerUserId: unknown,
): SnapshotSourceId<P> | undefined {
  if (provider !== "instagram" && provider !== "tiktok") return undefined;
  if (typeof connectionId !== "string" || typeof providerUserId !== "string") {
    return undefined;
  }
  const id = connectionId.toLowerCase();
  if (!UUID.test(id) || !PROVIDER_USER_ID.test(providerUserId)) return undefined;
  return brand<P>(`${provider}:${id}:${providerUserId}`);
}

/** ¿Es `value` un source_id bien formado de `provider`? (defensa en profundidad ante un cast). */
export function isSourceIdOf(provider: SnapshotProvider, value: unknown): boolean {
  if (typeof value !== "string" || value.length > MAX_SOURCE_ID_LENGTH) return false;
  if (provider === "twitch") {
    return (
      value.startsWith("twitch:") && TWITCH_LOGIN.test(value.slice("twitch:".length))
    );
  }
  if (provider === "youtube") {
    return (
      value.startsWith("youtube:") &&
      YOUTUBE_CHANNEL_ID.test(value.slice("youtube:".length))
    );
  }
  const prefix = `${provider}:`;
  if (!value.startsWith(prefix)) return false;
  const rest = value.slice(prefix.length);
  const cut = rest.indexOf(":");
  return (
    cut > 0 && UUID.test(rest.slice(0, cut)) && PROVIDER_USER_ID.test(rest.slice(cut + 1))
  );
}

// ---------- Validación estricta ----------

class InvalidSnapshotPayload extends Error {}
const fail = (): never => {
  throw new InvalidSnapshotPayload();
};

type PlainRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is PlainRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Campos con valor: `undefined` cuenta como ausente (los normalizadores lo dejan así). */
function fieldsOf(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
) {
  if (!isRecord(value)) return fail();
  const present = new Map<string, unknown>();
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (v === undefined) continue;
    // Una clave desconocida se RECHAZA (no se descarta): así una respuesta cruda, un token o
    // una credencial nunca pasan por "campo de más".
    if (!required.includes(key) && !optional.includes(key)) return fail();
    present.set(key, v);
  }
  for (const key of required) if (!present.has(key)) return fail();
  return present;
}

/** Caracteres de control C0, DEL y C1. Los textos admiten tabulador y saltos de línea; las URL no
 *  admiten ninguno. (Recorrido por código de carácter: sin regex de control.) */
function hasControlChars(text: string, allowWhitespaceControls: boolean): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x09 || c === 0x0a || c === 0x0d) {
      if (allowWhitespaceControls) continue;
      return true;
    }
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

function str(value: unknown, max: number, min = 0): string {
  if (typeof value !== "string" || value.length < min || value.length > max)
    return fail();
  if (hasControlChars(value, true)) return fail();
  return value;
}

const matches = (value: unknown, pattern: RegExp): string => {
  if (typeof value !== "string" || !pattern.test(value)) return fail();
  return value;
};

function count(value: unknown, max = 1_000_000_000_000): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  ) {
    return fail();
  }
  return value;
}

function isoDate(value: unknown): string {
  const text = str(value, 40, 10);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || Number.isNaN(Date.parse(text))) return fail();
  return text;
}

const MAX_URL_LENGTH = 2048;

/** `host` coincide con un dominio permitido o es subdominio suyo. */
const hostMatches = (host: string, domains: readonly string[]): boolean =>
  domains.some((d) => host === d || host.endsWith(`.${d}`));

/** https con host permitido, sin credenciales ni espacios/control. Nunca javascript:/data:/blob:/http:. */
function httpsUrl(value: unknown, domains: readonly string[]): string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return fail();
  if (/\s/.test(value) || hasControlChars(value, false)) return fail();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail();
  }
  if (url.protocol !== "https:" || url.username || url.password) return fail();
  if (!hostMatches(url.hostname.toLowerCase(), domains)) return fail();
  return value;
}

// Dominios permitidos: salen de las respuestas normalizadas reales de cada proveedor.
const TWITCH_PAGE_DOMAINS = ["twitch.tv"] as const;
const TWITCH_EMBED_DOMAINS = ["clips.twitch.tv"] as const;
const TWITCH_MEDIA_DOMAINS = ["jtvnw.net", "twitch.tv", "twitchcdn.net"] as const;
const YOUTUBE_MEDIA_DOMAINS = ["ytimg.com"] as const;
const INSTAGRAM_PAGE_DOMAINS = ["instagram.com"] as const;
const INSTAGRAM_MEDIA_DOMAINS = [
  "cdninstagram.com",
  "fbcdn.net",
  "instagram.com",
] as const;
const TIKTOK_PAGE_DOMAINS = ["tiktok.com"] as const;
const TIKTOK_MEDIA_DOMAINS = [
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokv.com",
  "tiktokv.us",
] as const;

function list<T>(value: unknown, max: number, item: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) return fail();
  return value.map(item);
}

function twitchClip(entry: unknown): TwitchClip {
  const f = fieldsOf(
    entry,
    [
      "id",
      "url",
      "title",
      "creatorName",
      "embedUrl",
      "thumbnailUrl",
      "viewCount",
      "createdAt",
    ],
    [],
  );
  return {
    id: matches(f.get("id"), /^[A-Za-z0-9_-]{1,100}$/),
    url: httpsUrl(f.get("url"), TWITCH_PAGE_DOMAINS),
    title: str(f.get("title"), 300),
    creatorName: str(f.get("creatorName"), 100),
    embedUrl: httpsUrl(f.get("embedUrl"), TWITCH_EMBED_DOMAINS),
    thumbnailUrl: httpsUrl(f.get("thumbnailUrl"), TWITCH_MEDIA_DOMAINS),
    viewCount: count(f.get("viewCount")),
    createdAt: isoDate(f.get("createdAt")),
  };
}

function twitchVideo(entry: unknown): TwitchVideo {
  const f = fieldsOf(
    entry,
    ["id", "url", "title", "createdAt", "duration"],
    ["thumbnailUrl"],
  );
  const thumbnail = f.get("thumbnailUrl");
  return {
    id: matches(f.get("id"), /^\d{1,20}$/),
    url: httpsUrl(f.get("url"), TWITCH_PAGE_DOMAINS),
    title: str(f.get("title"), 300),
    ...(thumbnail !== undefined && {
      thumbnailUrl: httpsUrl(thumbnail, TWITCH_MEDIA_DOMAINS),
    }),
    createdAt: isoDate(f.get("createdAt")),
    // Formato de Twitch: "3h28m10s", "45m", "12s".
    duration: matches(f.get("duration"), /^(?=.)(\d{1,4}h)?(\d{1,2}m)?(\d{1,2}s)?$/),
  };
}

function youtubeVideo(entry: unknown): YouTubeVideo {
  const f = fieldsOf(
    entry,
    ["id", "title", "description", "publishedAt", "duration"],
    ["thumbnailUrl", "coverUrl"],
  );
  const thumbnail = f.get("thumbnailUrl");
  const cover = f.get("coverUrl");
  return {
    id: matches(f.get("id"), /^[A-Za-z0-9_-]{11}$/),
    title: str(f.get("title"), 500),
    // La API admite hasta 5 000; el frontend no la muestra, pero forma parte del contrato.
    description: str(f.get("description"), 10_000),
    // Puede faltar (la API a veces no trae miniaturas), igual que en el normalizador.
    ...(thumbnail !== undefined && {
      thumbnailUrl: httpsUrl(thumbnail, YOUTUBE_MEDIA_DOMAINS),
    }),
    ...(cover !== undefined && { coverUrl: httpsUrl(cover, YOUTUBE_MEDIA_DOMAINS) }),
    publishedAt: isoDate(f.get("publishedAt")),
    // "0:00", "12:34" o "1:02:03" (parseIsoDuration).
    duration: matches(f.get("duration"), /^\d{1,4}:\d{2}(:\d{2})?$/),
  } as YouTubeVideo;
}

function instagramPost(entry: unknown): InstagramMediaItem {
  const f = fieldsOf(
    entry,
    ["id", "mediaType", "imageUrl", "permalink", "timestamp"],
    ["videoUrl", "productType", "caption", "username", "likeCount", "commentsCount"],
  );
  const mediaType = f.get("mediaType");
  if (mediaType !== "IMAGE" && mediaType !== "VIDEO" && mediaType !== "CAROUSEL_ALBUM") {
    return fail();
  }
  const productType = f.get("productType");
  if (productType !== undefined && productType !== "FEED" && productType !== "REELS") {
    return fail();
  }
  const video = f.get("videoUrl");
  // Solo un VIDEO lleva archivo de video.
  if (video !== undefined && mediaType !== "VIDEO") return fail();
  const caption = f.get("caption");
  const username = f.get("username");
  const likes = f.get("likeCount");
  const comments = f.get("commentsCount");
  return {
    id: matches(f.get("id"), /^[A-Za-z0-9_-]{1,64}$/),
    mediaType,
    imageUrl: httpsUrl(f.get("imageUrl"), INSTAGRAM_MEDIA_DOMAINS),
    permalink: httpsUrl(f.get("permalink"), INSTAGRAM_PAGE_DOMAINS),
    ...(video !== undefined && { videoUrl: httpsUrl(video, INSTAGRAM_MEDIA_DOMAINS) }),
    ...(productType !== undefined && { productType }),
    ...(caption !== undefined && { caption: str(caption, 5000) }),
    timestamp: isoDate(f.get("timestamp")),
    ...(username !== undefined && { username: str(username, 100, 1) }),
    ...(likes !== undefined && { likeCount: count(likes) }),
    ...(comments !== undefined && { commentsCount: count(comments) }),
  };
}

function instagramProfile(entry: unknown): InstagramProfile {
  // `{}` es un perfil de forma válida (Meta pudo no devolver campos opcionales).
  const f = fieldsOf(entry, [], ["username", "profilePictureUrl"]);
  const username = f.get("username");
  const picture = f.get("profilePictureUrl");
  return {
    ...(username !== undefined && { username: str(username, 100, 1) }),
    ...(picture !== undefined && {
      profilePictureUrl: httpsUrl(picture, INSTAGRAM_MEDIA_DOMAINS),
    }),
  };
}

function tiktokVideo(entry: unknown): TikTokVideo {
  const f = fieldsOf(
    entry,
    ["id", "title", "embedUrl", "coverImageUrl", "createTime"],
    [],
  );
  return {
    id: matches(f.get("id"), /^[A-Za-z0-9_-]{1,64}$/),
    title: str(f.get("title"), 2500),
    embedUrl: httpsUrl(f.get("embedUrl"), TIKTOK_PAGE_DOMAINS),
    coverImageUrl: httpsUrl(f.get("coverImageUrl"), TIKTOK_MEDIA_DOMAINS),
    createTime: isoDate(f.get("createTime")),
  };
}

// ---------- Definiciones ----------

/** Marca almacenada de "no hay contenido" en los recursos de un solo elemento. Un JSON `null` no
 *  sirve como payload: la base de datos exige un objeto o un array (CHECK). */
const EMPTY_MARKER = { empty: true } as const;

interface SnapshotDefinition<R extends SnapshotResource> {
  provider: ProviderOf<R>;
  maxAgeMs: number;
  /** Devuelve el valor validado y RECONSTRUIDO, o lanza InvalidSnapshotPayload. */
  parse(value: unknown): SnapshotValue<R>;
  /** Recursos de un solo elemento: `null` es un vacío válido (se almacena con EMPTY_MARKER). */
  nullable: boolean;
}

function definition<R extends SnapshotResource>(
  provider: ProviderOf<R>,
  maxAgeMs: number,
  parse: (value: unknown) => SnapshotValue<R>,
  nullable = false,
): SnapshotDefinition<R> {
  return { provider, maxAgeMs, parse, nullable };
}

const { durable, social } = SNAPSHOT_MAX_AGE_MS;

export const SNAPSHOT_DEFINITIONS: { [R in SnapshotResource]: SnapshotDefinition<R> } = {
  "twitch-clips": definition("twitch", durable, (v) => list(v, 12, twitchClip)),
  "twitch-latest-video": definition("twitch", durable, twitchVideo, true),
  "youtube-latest": definition("youtube", durable, youtubeVideo, true),
  "youtube-videos": definition("youtube", durable, (v) => list(v, 12, youtubeVideo)),
  "youtube-shorts": definition("youtube", durable, (v) => list(v, 24, youtubeVideo)),
  "instagram-feed": definition("instagram", social, (v) => list(v, 24, instagramPost)),
  "instagram-profile": definition("instagram", social, instagramProfile),
  "tiktok-videos": definition("tiktok", social, (v) => list(v, 12, tiktokVideo)),
};

export function snapshotProvider(resource: SnapshotResource): SnapshotProvider {
  return SNAPSHOT_DEFINITIONS[resource].provider;
}

export function snapshotMaxAgeMs(resource: SnapshotResource): number {
  return SNAPSHOT_DEFINITIONS[resource].maxAgeMs;
}

/** Recursos de un proveedor social (los que se borran al desconectarlo). */
export function socialSnapshotResources(
  provider: SocialSnapshotProvider,
): SnapshotResource[] {
  return SNAPSHOT_RESOURCES.filter((r) => SNAPSHOT_DEFINITIONS[r].provider === provider);
}

/**
 * Valida un VALOR (antes de escribirlo) y devuelve su forma almacenable: el valor reconstruido
 * solo con campos conocidos, o EMPTY_MARKER si es `null` en un recurso de un solo elemento.
 * `undefined` = inválido. Nunca lanza.
 */
export function encodeSnapshotPayload(
  resource: SnapshotResource,
  value: unknown,
): PlainRecord | unknown[] | undefined {
  const def = SNAPSHOT_DEFINITIONS[resource] as SnapshotDefinition<SnapshotResource>;
  try {
    if (value === null) return def.nullable ? { ...EMPTY_MARKER } : undefined;
    return def.parse(value) as PlainRecord | unknown[];
  } catch {
    return undefined;
  }
}

export type DecodedSnapshotPayload<R extends SnapshotResource> = {
  value: SnapshotValue<R>;
};

/**
 * Valida el payload LEÍDO de la base de datos (no se confía en la fila) y lo devuelve como
 * valor tipado. `undefined` = fila ignorable. Nunca lanza.
 */
export function decodeSnapshotPayload<R extends SnapshotResource>(
  resource: R,
  stored: unknown,
): DecodedSnapshotPayload<R> | undefined {
  const def = SNAPSHOT_DEFINITIONS[resource] as SnapshotDefinition<SnapshotResource>;
  try {
    if (def.nullable && isRecord(stored)) {
      const keys = Object.keys(stored);
      if (keys.length === 1 && keys[0] === "empty" && stored.empty === true) {
        return { value: null as SnapshotValue<R> };
      }
    }
    return { value: def.parse(stored) as SnapshotValue<R> };
  } catch {
    return undefined;
  }
}
