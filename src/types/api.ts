export interface InstagramApiItem {
  id: string;
  media_type: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  media_url: string;
  thumbnail_url?: string;
  permalink: string;
  caption?: string;
  timestamp: string;
}

export interface TikTokApiVideo {
  id: string;
  title: string;
  share_url: string;
  cover_image_url: string;
  create_time: number;
}

export interface TwitchTokenResponse {
  access_token: string;
  expires_in: number;
}

export interface TwitchUser {
  id: string;
}

export interface TwitchClipApiItem {
  id: string;
  url: string;
  title: string;
  creator_name: string;
  thumbnail_url: string;
  view_count: number;
  created_at: string;
}

export interface TwitchStream {
  title: string;
  viewer_count: number;
  // Twitch puede devolver este campo vacío o ausente (stream recién
  // iniciado, thumbnail todavía generándose); nunca asumir que existe.
  thumbnail_url?: string;
  started_at: string;
}

export interface TwitchVideoApiItem {
  id: string;
  url: string;
  title: string;
  // Igual que en TwitchStream: puede faltar en VODs que aún se están
  // procesando.
  thumbnail_url?: string;
  created_at: string;
  duration: string;
  type: "archive" | "highlight" | "upload";
}

export interface YouTubeThumbnail {
  url: string;
}

export interface YouTubeSnippet {
  resourceId: { videoId: string };
  title: string;
  description: string;
  thumbnails?: { high?: YouTubeThumbnail; default?: YouTubeThumbnail };
  publishedAt: string;
}

export interface YouTubeChannelResponse {
  items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
}

export interface YouTubePlaylistResponse {
  items?: Array<{ snippet: YouTubeSnippet }>;
}

export interface YouTubeVideoDetails {
  id: string;
  contentDetails: { duration: string };
}

export interface YouTubeVideosResponse {
  items?: YouTubeVideoDetails[];
}
