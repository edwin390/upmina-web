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
