// ---------- Twitch ----------
export interface TwitchStatus {
  isLive: boolean;
  title?: string;
  viewerCount?: number;
  thumbnailUrl?: string;
  startedAt?: string;
}

export interface TwitchVideo {
  id: string;
  title: string;
  thumbnailUrl: string;
  createdAt: string;
  duration: string;
}

export interface TwitchClip {
  id: string;
  title: string;
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
