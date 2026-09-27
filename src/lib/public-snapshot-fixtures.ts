import type { SnapshotResource, SnapshotValue } from "./public-snapshot-resources";

// Valores de ejemplo (claramente sintéticos) con la forma de las respuestas normalizadas REALES de
// cada endpoint público. Solo tests: sirven para comprobar que los validadores aceptan lo legítimo
// y rechazan lo demás.

const CLIP_ID = "SyntheticClipSlug-AbCdEf123456";

const PAYLOADS = {
  "twitch-clips": [
    {
      id: CLIP_ID,
      url: `https://www.twitch.tv/canalficticio/clip/${CLIP_ID}`,
      title: "Un clip de prueba",
      creatorName: "creadorficticio",
      embedUrl: `https://clips.twitch.tv/embed?clip=${CLIP_ID}`,
      thumbnailUrl:
        "https://static-cdn.jtvnw.net/twitch-clips-thumbnails-prod/SyntheticClip/preview-480x272.jpg",
      viewCount: 7,
      createdAt: "2026-09-26T04:00:00Z",
    },
  ],
  "twitch-latest-video": {
    id: "2882064767",
    url: "https://www.twitch.tv/videos/2882064767",
    title: "Último stream de prueba",
    thumbnailUrl:
      "https://static-cdn.jtvnw.net/cf_vods/synthetic/thumb/thumb0-640x360.jpg",
    createdAt: "2026-09-23T18:00:00Z",
    duration: "3h28m10s",
  },
  "youtube-latest": {
    id: "dQw4w9WgXcQ",
    title: "Vídeo de prueba",
    description: "Descripción de prueba\ncon varias líneas",
    thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    publishedAt: "2026-09-20T10:00:00Z",
    duration: "12:34",
  },
  "youtube-videos": [
    {
      id: "dQw4w9WgXcQ",
      title: "Vídeo de prueba",
      description: "Descripción de prueba",
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      coverUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
      publishedAt: "2026-09-20T10:00:00Z",
      duration: "1:02:03",
    },
  ],
  "youtube-shorts": [
    {
      id: "aBcDeFgHiJk",
      title: "Short de prueba",
      description: "",
      thumbnailUrl: "https://i.ytimg.com/vi/aBcDeFgHiJk/hqdefault.jpg",
      publishedAt: "2026-09-21T10:00:00Z",
      duration: "0:45",
    },
  ],
  "instagram-feed": [
    {
      id: "17895695668004550",
      mediaType: "CAROUSEL_ALBUM",
      imageUrl:
        "https://scontent-iad3-2.cdninstagram.com/v/t51.29350-15/synthetic.jpg?stp=dst-jpg&oe=6A2C3D4E&_nc_sid=abc",
      permalink: "https://www.instagram.com/p/SyntheticPost/",
      caption: "Pie de foto de prueba",
      timestamp: "2026-09-18T19:00:31+00:00",
      username: "cuentaficticia",
      likeCount: 3,
      commentsCount: 1,
    },
    {
      id: "17895695668004551",
      mediaType: "VIDEO",
      imageUrl:
        "https://scontent-iad6-1.cdninstagram.com/v/t51.29350-15/synthetic-thumb.jpg?oe=6A2C3D4F",
      videoUrl:
        "https://scontent-iad6-1.cdninstagram.com/o1/v/t2/f2/synthetic.mp4?oe=6A2C3D50",
      productType: "REELS",
      permalink: "https://www.instagram.com/reel/SyntheticReel/",
      timestamp: "2026-09-19T19:00:31+00:00",
    },
  ],
  "instagram-profile": {
    username: "cuentaficticia",
    profilePictureUrl:
      "https://scontent-iad6-1.cdninstagram.com/v/t51.2885-19/synthetic-avatar.jpg?oe=6A2C3D4E",
  },
  "tiktok-videos": [
    {
      id: "7687741460304645394",
      title: "",
      embedUrl:
        "https://www.tiktok.com/@cuentaficticia/video/7687741460304645394?utm_campaign=x",
      coverImageUrl:
        "https://p16-common-sign.tiktokcdn.com/synthetic-cover.jpeg?x-expires=1790000000&x-signature=abc",
      createTime: "2026-09-20T22:03:27.000Z",
    },
  ],
} satisfies { [R in SnapshotResource]: NonNullable<SnapshotValue<R>> };

type PayloadMap = typeof PAYLOADS;

/** Copia PROFUNDA de un valor válido de ejemplo (los tests lo mutan sin afectarse entre sí). */
export function validPayload<R extends SnapshotResource>(resource: R): PayloadMap[R] {
  return JSON.parse(JSON.stringify(PAYLOADS[resource])) as PayloadMap[R];
}
