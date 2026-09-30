// ---------- Twitch ----------
export interface TwitchStatus {
  isLive: boolean;
  // Canal que el backend consultó realmente (viene de la env var
  // TWITCH_CHANNEL). Es la única fuente de verdad: el frontend nunca debe
  // hardcodear un nombre de canal en su lugar.
  channel: string;
  title?: string;
  viewerCount?: number;
  thumbnailUrl?: string;
  startedAt?: string;
}

export interface TwitchVideo {
  id: string;
  // URL del VOD en twitch.tv, tal cual la devuelve Helix. Permite un enlace
  // "Ver en Twitch" directo, además del reproductor embebido.
  url: string;
  title: string;
  // Puede faltar: Twitch no siempre devuelve thumbnail_url (ver
  // src/types/api.ts, TwitchVideoApiItem).
  thumbnailUrl?: string;
  createdAt: string;
  duration: string;
}

export interface TwitchClip {
  id: string;
  // URL del clip en twitch.tv (salida opcional "Ver en Twitch"; la reproducción
  // normal ocurre en el visor interno con `embedUrl`).
  url: string;
  title: string;
  creatorName: string;
  embedUrl: string;
  thumbnailUrl: string;
  viewCount: number;
  createdAt: string;
}

// ---------- YouTube ----------
export interface YouTubeVideo {
  id: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  // Portada de mayor resolución (solo si la API la ofrece y supera a `thumbnailUrl`).
  coverUrl?: string;
  publishedAt: string;
  duration: string; // formato HH:MM:SS
}

// ---------- Instagram ----------
export interface InstagramMediaItem {
  id: string;
  mediaType: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  /** Imagen para la tarjeta: la foto, la miniatura del video o la portada del carrusel. */
  imageUrl: string;
  /** Enlace oficial de la publicación en Instagram. */
  permalink: string;
  /** Archivo de video (solo VIDEO); se reproduce al abrir la publicación, no en la grid. */
  videoUrl?: string;
  /** Solo "REELS" o "FEED" y solo si Meta lo devuelve: nunca se deduce. */
  productType?: "FEED" | "REELS";
  caption?: string;
  /** ISO 8601 válido. */
  timestamp: string;
  username?: string;
  /** Solo si Meta lo devuelve (el autor puede ocultar los likes). */
  likeCount?: number;
  commentsCount?: number;
}

/** Perfil de la cuenta autorizada. `profilePictureUrl` solo si Meta la devuelve. */
export interface InstagramProfile {
  username?: string;
  profilePictureUrl?: string;
}

/** Elemento de un carrusel: al menos una de las dos URLs está presente. */
export interface InstagramChild {
  id: string;
  mediaType: "IMAGE" | "VIDEO";
  imageUrl?: string;
  videoUrl?: string;
}

export interface InstagramComment {
  id: string;
  text: string;
  username?: string;
  timestamp?: string;
  /** Solo si Meta lo devuelve para el comentario con los permisos del token. */
  likeCount?: number;
}

export interface InstagramComments {
  comments: InstagramComment[];
}

// ---------- TikTok ----------
export interface TikTokVideo {
  id: string;
  title: string;
  embedUrl: string;
  coverImageUrl: string;
  createTime: string;
}

// ---------- Comunidad ----------
export type EditStatus = "pending" | "approved" | "rejected";

export interface Profile {
  id: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  bio?: string;
  role: "user" | "moderator" | "admin";
  createdAt: string;
}

export interface Edit {
  id: string;
  authorId: string;
  title: string;
  description?: string;
  videoPath: string;
  thumbnailPath?: string;
  status: EditStatus;
  moderationNote?: string;
  createdAt: string;
  updatedAt: string;
  voteScore?: number;
}

export interface EditRow {
  id: string;
  author_id: string;
  title: string;
  description: string | null;
  video_path: string;
  thumbnail_path: string | null;
  status: EditStatus;
  moderation_note?: string | null;
  created_at: string;
  updated_at: string;
  votes?: Array<{ value: number }>;
}

export interface Vote {
  userId: string;
  editId: string;
  value: -1 | 1;
  createdAt: string;
}

export interface Report {
  id: string;
  editId: string;
  reporterId: string;
  reason: string;
  resolved: boolean;
  createdAt: string;
}

// ---------- Cosplay (Fase 9I) ----------
// Contrato público normalizado (lo que devuelve /api/content, camelCase) y las filas crudas de
// Supabase (snake_case) que lo alimentan, mismo patrón que Edit/EditRow arriba.
//
// Modelo editorial (corrección de producto, Fase 9I-3): el contenido de Mina (título,
// descripción, alt, caption) es UN valor canónico por campo, en el idioma que ella elija al
// escribir — NUNCA depende del idioma de la interfaz. Solo la UI (rótulos, fechas, chrome) se
// localiza ES/EN/DE; el contenido editorial se muestra IDÉNTICO sin importar el idioma activo.
// Las columnas *_es/_en/_de siguen existiendo en Postgres (ver supabase/migrations) como detalle
// de almacenamiento heredado — *_es es la columna canónica real; *_en/*_de quedan sin usar — pero
// el contrato de aplicación (estos tipos, la API, el editor ADMIN) es neutral y nunca los expone.

/** Imagen de galería, ya en su URL pública final (la construye el servidor; en 9I-1 sin R2 real
 *  puede ser una URL de fixture local). */
export interface CosplayImage {
  id: string;
  url: string;
  width: number;
  height: number;
  position: number;
  isCover: boolean;
  decorative: boolean;
  alt: string | null;
  caption: string | null;
}

/** Tarjeta de listado: sin galería completa ni descripción (evita sobrecargar /cosplay). */
export interface CosplayPostSummary {
  id: string;
  slug: string;
  title: string;
  characterName: string | null;
  series: string | null;
  event: string | null;
  /** Fecha civil "YYYY-MM-DD" (sin hora): se formatea siempre en UTC. */
  shotOn: string | null;
  /** ISO 8601. Siempre presente: solo se listan publicaciones publicadas. */
  publishedAt: string;
  cover: CosplayImage | null;
  photoCount: number;
}

export interface CosplayPostDetail extends CosplayPostSummary {
  description: string | null;
  photographerCredit: string | null;
  gallery: CosplayImage[];
}

/** Página de listado con paginación por cursor (Fase 9I-1: sin scroll infinito ni búsqueda). */
export interface CosplayPostListPage {
  items: CosplayPostSummary[];
  nextCursor: string | null;
}

// Filas crudas de Supabase (server-side, servicio role). `cosplay_posts` unido a
// `cosplay_post_images` + `media_assets` para construir el contrato de arriba.
export interface CosplayPostRow {
  id: string;
  slug: string;
  status: "draft" | "published";
  title_es: string;
  title_en: string | null;
  title_de: string | null;
  description_es: string | null;
  description_en: string | null;
  description_de: string | null;
  character_name: string | null;
  series: string | null;
  event: string | null;
  shot_on: string | null;
  photographer_credit: string | null;
  published_at: string | null;
  version: number;
}

export interface CosplayPostImageRow {
  id: string;
  position: number;
  is_cover: boolean;
  decorative: boolean;
  alt_es: string | null;
  alt_en: string | null;
  alt_de: string | null;
  caption_es: string | null;
  caption_en: string | null;
  caption_de: string | null;
  media_assets: {
    id: string;
    status: "reserved" | "ready" | "deleting";
    width: number;
    height: number;
    storage_key: string;
  } | null;
}

// ---------- Community feed (Fase 9J-2A) ----------
// Contrato PÚBLICO del feed de /community (lo que devuelve /api/content?resource=community-feed,
// camelCase) — distinto del contrato "propio" de /account (ver CommunityOwnPost en
// community-client.ts), que sí expone datos de gestión (version, expectedVersion) que un
// visitante nunca necesita ni debe ver.

export interface CommunityFeedAuthor {
  /** Identidad pública técnica (@username). Nunca el user_id/UUID. */
  username: string;
  /** Nombre de presentación opcional. null = mostrar @username, nunca inventar un nombre. */
  displayName: string | null;
}

export interface CommunityFeedMediaItem {
  id: string;
  position: number;
  /** Discriminador de tipo (Fase 9J-3): "image" o "video". */
  kind: "image" | "video";
  url: string;
  width: number;
  height: number;
  /** SOLO kind="video", y solo si el navegador de origen pudo leerla. null para imagen siempre. */
  durationSeconds: number | null;
}

export interface CommunityFeedPost {
  id: string;
  text: string | null;
  /** ISO 8601. */
  createdAt: string;
  author: CommunityFeedAuthor;
  media: CommunityFeedMediaItem[];
  /** Recuento REAL de likes (Fase 9J-2C). Agregado público: nunca la lista de quién dio like. */
  likeCount: number;
}

/** Página de listado con paginación por cursor, mismo patrón que CosplayPostListPage. */
export interface CommunityFeedPage {
  items: CommunityFeedPost[];
  nextCursor: string | null;
}

// ---------- Community public profile (Fase 9J-2B) ----------
// Contrato PÚBLICO de /@username (lo que devuelve /api/content?resource=community-profile).
// Reutiliza CommunityFeedPost/CommunityFeedPage TAL CUAL para la galería de publicaciones —
// nunca una segunda representación incompatible de "publicación pública" (ver el comentario de
// community-profile-handlers.ts). Nunca expone user_id/UUID, email, role ni metadata de MFA.

export interface CommunityProfilePublic {
  /** Identidad pública técnica (@username), ya canónica (minúsculas). */
  username: string;
  displayName: string | null;
  bio: string | null;
  /** Recuento de publicaciones published. */
  postCount: number;
  /** Suma REAL de likeCount de sus publicaciones published (Fase 9J-2C). Nunca fabricado: 0 es un
   *  valor válido. No cuenta publicaciones borradas ni 'hidden'. */
  totalLikes: number;
}

export interface CommunityProfilePage {
  profile: CommunityProfilePublic;
  posts: CommunityFeedPage;
}
