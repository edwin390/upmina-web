import { expect, it, vi } from "vitest";
import { resolveModerationMedia } from "./moderation-case-media";
import { mapFeedMediaRow } from "./community-feed-domain";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ref = { id, assetId: id, position: 0 };
const asset = {
  id,
  domain: "community",
  status: "ready",
  kind: "image",
  storage_key: "synthetic/image",
  width: 640,
  height: 480,
  duration_seconds: null,
};
it.each(["image", "video"])(
  "resolves %s through the established mapper",
  async (kind) => {
    const lookup = vi.fn().mockResolvedValue([
      {
        ...asset,
        kind,
        duration_seconds: kind === "video" ? 3 : null,
        metadata: "private",
      },
    ]);
    const rows = await resolveModerationMedia(
      [{ ...ref, storage_key: "untrusted", reporterId: id }],
      lookup,
    );
    const safe = rows.map((r) =>
      mapFeedMediaRow(r, (k) => `https://cdn.synthetic.example/${k}`),
    );
    expect(safe[0]).toMatchObject({
      kind,
      url: "https://cdn.synthetic.example/synthetic/image",
      durationSeconds: kind === "video" ? 3 : null,
    });
    expect(JSON.stringify(safe)).not.toMatch(/storage_key|metadata|reporterId/);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith([id]);
  },
);
it("batches at most ten references and preserves position order", async () => {
  const lookup = vi.fn().mockResolvedValue([asset]);
  const rows = await resolveModerationMedia(
    Array.from({ length: 10 }, (_, position) => ({ ...ref, position: 9 - position })),
    lookup,
  );
  expect(rows.map((r) => r.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(lookup).toHaveBeenCalledWith([id]);
});
it("empty/deleted-post media needs no lookup", async () => {
  const lookup = vi.fn();
  expect(await resolveModerationMedia([], lookup)).toEqual([]);
  expect(lookup).not.toHaveBeenCalled();
});
it.each([
  null,
  {},
  [{ ...ref, assetId: "invalid" }],
  [{ ...ref, position: -1 }],
  Array(11).fill(ref),
])("rejects malformed references before lookup (%j)", async (value) => {
  const lookup = vi.fn();
  await expect(resolveModerationMedia(value, lookup)).rejects.toThrow();
  expect(lookup).not.toHaveBeenCalled();
});
it.each([
  [],
  null,
  [{ ...asset, kind: "audio" }],
  [{ ...asset, width: 0 }],
  [{ ...asset, domain: "cosplay" }],
  [asset, asset],
])("rejects missing/malformed lookup (%j)", async (value) => {
  await expect(resolveModerationMedia([ref], async () => value)).rejects.toThrow();
});
it("provider failure stays a rejection without fabricating media", async () => {
  await expect(
    resolveModerationMedia([ref], async () => {
      throw new Error("lookup unavailable");
    }),
  ).rejects.toThrow();
});
it("non-ready assets with nullable metadata remain filtered", async () => {
  const rows = await resolveModerationMedia([ref], async () => [
    {
      ...asset,
      status: "processing",
      storage_key: null,
      width: null,
      height: null,
      duration_seconds: null,
    },
  ]);
  expect(mapFeedMediaRow(rows[0], () => "unused")).toBeNull();
});
