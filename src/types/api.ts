// Campos de `GET /me/media` con el permiso instagram_business_basic. Todos se
// tratan como opcionales porque Meta los omite según el tipo de media.
export interface InstagramApiItem {
  id?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  caption?: string;
  timestamp?: string;
  username?: string;
  media_product_type?: string;
  like_count?: number;
  comments_count?: number;
}

// `GET /me?fields=username,profile_picture_url` (instagram_business_basic).
export interface InstagramProfileApiItem {
  username?: string;
  profile_picture_url?: string;
}

export interface InstagramMediaResponse {
  data?: InstagramApiItem[];
}

// `GET /{media-id}/comments` (requiere instagram_business_manage_comments).
export interface InstagramCommentApiItem {
  id?: string;
  text?: string;
  timestamp?: string;
  username?: string;
  like_count?: number;
}

export interface InstagramCommentsResponse {
  data?: InstagramCommentApiItem[];
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
  nextPageToken?: string;
}

export interface YouTubeVideoDetails {
  id: string;
  contentDetails: { duration: string };
}

export interface YouTubeVideosResponse {
  items?: YouTubeVideoDetails[];
}
