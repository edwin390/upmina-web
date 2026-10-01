import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  saveCosplayPost,
  getCosplayPostAdmin,
  detachCosplayMedia,
  deleteCosplayPost,
  type SaveCosplayPostInput,
} from "./cosplay-admin-client";
import {
  reserveMediaUpload,
  completeMediaUpload,
  abortMediaUpload,
} from "./media-client";

const f = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: f.getSession } } }));
const identity = { userId: "owner", isActive: () => true };
const input: SaveCosplayPostInput = {
  postId: null,
  expectedVersion: null,
  status: "draft",
  title: "Local text",
  description: null,
  characterName: null,
  series: null,
  event: null,
  shotOn: null,
  photographerCredit: null,
  images: [],
};
const operations = {
  load: () => getCosplayPostAdmin("post", true, identity),
  save: () => saveCosplayPost(input, identity),
  detach: () =>
    detachCosplayMedia(
      { postId: "post", expectedVersion: 1, imageId: "image" },
      identity,
    ),
  delete: () => deleteCosplayPost({ postId: "post", expectedVersion: 1 }, identity),
  reserve: () =>
    reserveMediaUpload(
      { domain: "cosplay", sourceMime: "image/jpeg", sourceBytes: 10 },
      identity,
    ),
  complete: () => completeMediaUpload({ assetId: "asset" }, identity),
  abort: () => abortMediaUpload("asset", identity),
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());
it.each(Object.entries(operations))(
  "%s checks actual token identity before sending old editor contents",
  async (_name, operation) => {
    f.getSession.mockResolvedValue({
      data: { session: { user: { id: "other" }, access_token: "synthetic-other-token" } },
    });
    await expect(operation()).rejects.toMatchObject({
      status: 401,
      privilegedFailure: "unauthenticated",
    });
    expect(fetch).not.toHaveBeenCalled();
  },
);
it("logout while token lookup is pending prevents a privileged fetch", async () => {
  let active = true;
  let resolve!: (value: unknown) => void;
  f.getSession.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const request = saveCosplayPost(input, { userId: "owner", isActive: () => active });
  active = false;
  resolve({
    data: { session: { user: { id: "owner" }, access_token: "synthetic-old-token" } },
  });
  await expect(request).rejects.toMatchObject({ status: 401 });
  expect(fetch).not.toHaveBeenCalled();
});
it("binding is local metadata, excluded from the server save payload", async () => {
  f.getSession.mockResolvedValue({
    data: { session: { user: { id: "owner" }, access_token: "synthetic-owner-token" } },
  });
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ post: { id: "post" }, images: [] }), { status: 200 }),
  );
  await saveCosplayPost(input, identity);
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toEqual(input);
});
