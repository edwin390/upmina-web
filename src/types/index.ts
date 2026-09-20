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
  // URL del clip en twitch.tv (fallback si el iframe de embed no carga, p.
  // ej. por un bloqueador de contenido).
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
  mediaUrl: string;
  thumbnailUrl?: string;
  permalink: string;
  caption?: string;
  timestamp: string;
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
