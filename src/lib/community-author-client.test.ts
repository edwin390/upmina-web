import { beforeEach, it, expect, vi } from "vitest";
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: "synthetic" } } }),
    },
  },
}));
import {
  fetchAuthorPost,
  listOwnCommunityPosts,
  acknowledgeAuthorNotice,
} from "./community-client";
const id = "24655b41-1bc7-487c-834e-d1715a596e9e";
const payload = () => ({
  items: [
    {
      id,
      text: "Texto",
      status: "published",
      version: 1,
      createdAt: "2026-10-04T17:00:00Z",
      updatedAt: "2026-10-04T17:00:00Z",
      likeCount: 0,
      resolvedNoticeUnseen: false,
      media: [],
      author: { username: "author_test", displayName: null },
      moderation: { kind: "none", deadline: null, message: null },
    },
  ],
  serverNow: "2026-10-04T18:00:00Z",
  noticeId: null,
});
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
function reply(v: unknown, status = 200) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(v), { status }));
}
it.each([null, {}, { items: [] }])(
  "malformed own list 200 fails closed %j",
  async (v) => {
    reply(v);
    await expect(listOwnCommunityPosts()).rejects.toMatchObject({
      code: "invalid_response",
    });
  },
);
it("valid detail strips private fields, GET never acknowledges", async () => {
  const v = payload();
  Object.assign(v.items[0], { storage_key: "internal", reporterId: "private" });
  reply(v);
  expect(await fetchAuthorPost(id, true)).toEqual(payload());
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][1].method).toBe("GET");
});
it("wrong detail identity rejected", async () => {
  reply(payload());
  await expect(
    fetchAuthorPost("00000000-0000-4000-8000-000000000001", true),
  ).rejects.toMatchObject({ code: "invalid_response" });
});
it("non-profile read rejects unexpected notice", async () => {
  reply({ ...payload(), noticeId: id });
  await expect(fetchAuthorPost(id, false)).rejects.toMatchObject({
    code: "invalid_response",
  });
});
it("not found is unavailable, not success", async () => {
  reply({ error: "No encontrado" }, 404);
  expect(await fetchAuthorPost(id, true)).toBeNull();
});
it("ack is explicit POST with strict response", async () => {
  reply({ acknowledged: true, storage_key: "internal" });
  expect(await acknowledgeAuthorNotice(id, id)).toEqual({ acknowledged: true });
  expect(fetchMock.mock.calls[0][1].method).toBe("POST");
  reply({ acknowledged: false });
  await expect(acknowledgeAuthorNotice(id, id)).rejects.toMatchObject({
    code: "invalid_response",
  });
});
