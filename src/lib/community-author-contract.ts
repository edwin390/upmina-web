import { parseModerationId, timestamp } from "./moderation-case-parser.js";
import { isValidUsernameFormat } from "./profile-username.js";

interface AuthorPostMedia {
  id: string;
  assetId: string;
  position: number;
  assetStatus: string | null;
  kind: "image" | "video";
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  url: string | null;
}
export interface AuthorPost {
  id: string;
  text: string | null;
  status: "published" | "hidden_pending_review" | "hidden" | "removed_pending_purge";
  version: number;
  createdAt: string;
  updatedAt: string;
  likeCount: number;
  /** Private owner-only flag: a valid, unseen reports_not_valid notice exists for this published post. */
  resolvedNoticeUnseen: boolean;
  media: AuthorPostMedia[];
  author: { username: string; displayName: string | null };
  moderation: {
    kind: "none" | "paused" | "withdrawn";
    deadline: string | null;
    message: string | null;
  };
}
export interface AuthorPostsResponse {
  items: AuthorPost[];
  serverNow: string;
  noticeId: string | null;
}
export const NO_PROCEDE_NOTICE =
  "El caso se revisó y no se encontró ningún incumplimiento de las reglas de la comunidad.";
export function authorRecord(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Invalid author response");
  return v as Record<string, unknown>;
}
function text(v: unknown): string {
  if (typeof v !== "string") throw new Error("Invalid text");
  return v;
}
const nullable = (v: unknown) => (v === null ? null : text(v));
function number(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
    throw new Error("Invalid integer");
  return v;
}
function media(v: unknown): AuthorPostMedia {
  const m = authorRecord(v);
  if (m.kind !== "image" && m.kind !== "video") throw new Error("Invalid media kind");
  const url = nullable(m.url);
  if (url !== null) {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      throw new Error("Invalid URL");
  }
  const status = nullable(m.assetStatus);
  if (
    status !== null &&
    ![
      "reserved",
      "uploaded",
      "verifying",
      "processing",
      "ready",
      "failed",
      "deleting",
    ].includes(status)
  )
    throw new Error("Invalid media state");
  const duration = m.durationSeconds;
  if (
    duration !== null &&
    (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)
  )
    throw new Error("Invalid duration");
  if (m.kind === "image" && duration !== null) throw new Error("Invalid image duration");
  if (url !== null && status !== "ready") throw new Error("Invalid media URL state");
  return {
    id: parseModerationId(m.id),
    assetId: parseModerationId(m.assetId),
    position: number(m.position, 0, 9),
    kind: m.kind,
    assetStatus: status,
    url,
    width: m.width === null ? null : number(m.width, 1),
    height: m.height === null ? null : number(m.height, 1),
    durationSeconds: duration as number | null,
  };
}
export function parseAuthorPost(v: unknown): AuthorPost {
  const p = authorRecord(v),
    a = authorRecord(p.author),
    m = authorRecord(p.moderation);
  if (
    !["published", "hidden_pending_review", "hidden", "removed_pending_purge"].includes(
      text(p.status),
    )
  )
    throw new Error("Invalid post state");
  const expected =
    p.status === "hidden_pending_review"
      ? "paused"
      : p.status === "removed_pending_purge"
        ? "withdrawn"
        : "none";
  if (m.kind !== expected) throw new Error("Invalid presentation state");
  const deadline = m.deadline === null ? null : timestamp(m.deadline);
  const message = nullable(m.message);
  if (
    expected === "withdrawn"
      ? deadline === null ||
        message === null ||
        !message.trim() ||
        [...message].length > 1000
      : deadline !== null || message !== null
  )
    throw new Error("Invalid moderation context");
  if (typeof p.resolvedNoticeUnseen !== "boolean") throw new Error("Invalid notice flag");
  if (p.resolvedNoticeUnseen && p.status !== "published")
    throw new Error("Invalid notice flag state");
  const username = text(a.username);
  if (!isValidUsernameFormat(username)) throw new Error("Invalid author");
  if (!Array.isArray(p.media) || p.media.length > 10) throw new Error("Invalid media");
  const items = p.media.map(media).sort((x, y) => x.position - y.position);
  if (
    new Set(items.map((x) => x.id)).size !== items.length ||
    new Set(items.map((x) => x.position)).size !== items.length
  )
    throw new Error("Duplicate media");
  return {
    id: parseModerationId(p.id),
    text: nullable(p.text),
    status: p.status as AuthorPost["status"],
    version: number(p.version, 1, 2147483647),
    createdAt: timestamp(p.createdAt),
    updatedAt: timestamp(p.updatedAt),
    likeCount: number(p.likeCount),
    resolvedNoticeUnseen: p.resolvedNoticeUnseen,
    author: { username, displayName: nullable(a.displayName) },
    moderation: { kind: expected, deadline, message },
    media: items,
  };
}
export function parseAuthorPostsResponse(v: unknown): AuthorPostsResponse {
  const r = authorRecord(v);
  if (!Array.isArray(r.items)) throw new Error("Invalid items");
  const items = r.items.map(parseAuthorPost),
    serverNow = timestamp(r.serverNow);
  if (new Set(items.map((p) => p.id)).size !== items.length)
    throw new Error("Duplicate post");
  for (const p of items)
    if (
      p.moderation.deadline &&
      Date.parse(p.moderation.deadline) <= Date.parse(serverNow)
    )
      throw new Error("Expired response");
  const noticeId = r.noticeId === null ? null : parseModerationId(r.noticeId);
  if (noticeId !== null && (items.length !== 1 || items[0].status !== "published"))
    throw new Error("Invalid notice context");
  return { items, serverNow, noticeId };
}
export function parseAuthorAck(v: unknown): { acknowledged: true } {
  if (authorRecord(v).acknowledged !== true) throw new Error("Invalid acknowledgement");
  return { acknowledged: true };
}
