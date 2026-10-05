import { it, expect } from "vitest";
import { parseAuthorPostsResponse, parseAuthorAck } from "./community-author-contract";
const base = {
  id: "24655b41-1bc7-487c-834e-d1715a596e9e",
  text: "Texto",
  status: "published",
  version: 1,
  createdAt: "2026-10-04T17:00:00.123456+00:00",
  updatedAt: "2026-10-04T17:00:00Z",
  likeCount: 0,
  resolvedNoticeUnseen: false,
  media: [],
  author: { username: "author_test", displayName: null },
  moderation: { kind: "none", deadline: null, message: null },
};
function payload() {
  return {
    items: [structuredClone(base)],
    serverNow: "2026-10-04T18:00:00Z",
    noticeId: null,
  };
}
it("resolvedNoticeUnseen: boolean required, true only for published posts", () => {
  const withFlag = (flag: unknown, extra: Record<string, unknown> = {}) => {
    const p = payload();
    Object.assign(p.items[0], { resolvedNoticeUnseen: flag, ...extra });
    return p;
  };
  expect(parseAuthorPostsResponse(withFlag(true)).items[0].resolvedNoticeUnseen).toBe(
    true,
  );
  expect(parseAuthorPostsResponse(withFlag(false)).items[0].resolvedNoticeUnseen).toBe(
    false,
  );
  for (const bad of ["true", 1, null, undefined])
    expect(() => parseAuthorPostsResponse(withFlag(bad))).toThrow();
  expect(() =>
    parseAuthorPostsResponse(
      withFlag(true, {
        status: "hidden_pending_review",
        moderation: { kind: "paused", deadline: null, message: null },
      }),
    ),
  ).toThrow();
  expect(() =>
    parseAuthorPostsResponse(
      withFlag(true, {
        status: "removed_pending_purge",
        moderation: {
          kind: "withdrawn",
          deadline: "2026-10-07T18:00:00Z",
          message: "x",
        },
      }),
    ),
  ).toThrow();
  expect(() => parseAuthorPostsResponse(withFlag(true, { status: "hidden" }))).toThrow();
});
it("complete normal response and fractional DB timestamp accepted", () => {
  expect(parseAuthorPostsResponse(payload()).items[0]).toEqual(base);
});
it("unknown nested private fields stripped", () => {
  const p = payload();
  Object.assign(p, { email: "private", metadata: {} });
  Object.assign(p.items[0], { reporterId: "private", storage_key: "internal" });
  Object.assign(p.items[0].author, { actor_user_id: "private" });
  expect(parseAuthorPostsResponse(p)).toEqual(payload());
});
it.each([1000, 1001])(
  "resolution Unicode code point boundary %i agrees with R4-A",
  (size) => {
    const p = payload();
    Object.assign(p.items[0], {
      status: "removed_pending_purge",
      moderation: {
        kind: "withdrawn",
        deadline: "2026-10-07T18:00:00Z",
        message: "😀".repeat(size),
      },
    });
    if (size === 1000)
      expect(parseAuthorPostsResponse(p).items[0].moderation.message).toBe(
        "😀".repeat(size),
      );
    else expect(() => parseAuthorPostsResponse(p)).toThrow();
  },
);
it.each([
  null,
  {},
  { items: null },
  { items: [] },
  { ...payload(), noticeId: "wrong" },
  { ...payload(), serverNow: "2026-02-30T10:00:00Z" },
])("malformed root rejected %j", (v) => {
  expect(() => parseAuthorPostsResponse(v)).toThrow();
});
it.each([
  { version: 0 },
  { version: 2147483648 },
  { version: 1.5 },
  { status: "other" },
  { createdAt: "x" },
  { author: null },
  { text: undefined },
  { media: null },
  { media: Array(11).fill({}) },
  { moderation: null },
  { status: "removed_pending_purge" },
  { status: "hidden_pending_review" },
])("malformed post rejected %j", (change) => {
  const p = payload();
  Object.assign(p.items[0], change);
  expect(() => parseAuthorPostsResponse(p)).toThrow();
});
it("withdrawn exact/after expiry fails closed while one millisecond before remains valid", () => {
  const p = payload();
  Object.assign(p.items[0], {
    status: "removed_pending_purge",
    moderation: {
      kind: "withdrawn",
      deadline: "2026-10-04T18:00:00Z",
      message: "Mensaje",
    },
  });
  expect(() => parseAuthorPostsResponse(p)).toThrow();
  p.serverNow = "2026-10-04T17:59:59.999Z";
  expect(parseAuthorPostsResponse(p).items).toHaveLength(1);
  p.serverNow = "2026-10-04T18:00:00.001Z";
  expect(() => parseAuthorPostsResponse(p)).toThrow();
});
it.each([
  { kind: "image", durationSeconds: 1 },
  { url: "javascript:alert(1)" },
  { width: 0 },
  { position: 10 },
  { assetStatus: "unknown" },
])("malformed media rejected %j", (change) => {
  const p = payload();
  Object.assign(p.items[0], {
    media: [
      {
        id: base.id,
        assetId: base.id,
        position: 0,
        kind: "image",
        width: 1,
        height: 1,
        durationSeconds: null,
        assetStatus: "ready",
        url: "https://cdn.example/a?sig=x",
        ...change,
      },
    ],
  });
  expect(() => parseAuthorPostsResponse(p)).toThrow();
});
it("signed video URL and nullable metadata remain compatible", () => {
  const p = payload();
  Object.assign(p.items[0], {
    media: [
      {
        id: base.id,
        assetId: base.id,
        position: 0,
        kind: "video",
        width: null,
        height: null,
        durationSeconds: null,
        assetStatus: "processing",
        url: null,
      },
    ],
  });
  expect(parseAuthorPostsResponse(p).items[0].media).toHaveLength(1);
});
it("ack is strict and allowlisted", () => {
  expect(parseAuthorAck({ acknowledged: true, metadata: "private" })).toEqual({
    acknowledged: true,
  });
  expect(() => parseAuthorAck({ acknowledged: false })).toThrow();
});
