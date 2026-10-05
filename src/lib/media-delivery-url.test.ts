// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from "vitest";
import { importCapabilityPublicKey, verifyCapability } from "./media-delivery-protocol";
import { loadCapabilitySigningConfig } from "./media-capability";

vi.mock("./r2-client.js", () => ({
  publicVariantUrl: (key: string) => `https://legacy.synthetic.example/${key}`,
}));
const {
  MediaDeliveryConfigError,
  communityMediaUrlForViewer,
  cosplayPublicMediaUrl,
  creatorPreviewMediaUrl,
  decideCommunityMediaAccess,
  getMediaDeliveryBase,
  loadMediaUrlContext,
  moderatorMediaUrls,
  privateCommunityMediaUrl,
  publicMediaUrl,
} = await import("./media-delivery-url");

const ASSET = "0b2ad7a0-1c0e-4a8d-9a11-0c4f59f0a001";
const OTHER = "0b2ad7a0-1c0e-4a8d-9a11-0c4f59f0a002";
const KEY = `community/${ASSET}/w960.webp`;
const BASE = "https://media.synthetic.example";
const NOW = 1_800_000_000_000;
let env: Record<string, string>;
let publicKey: Awaited<ReturnType<typeof importCapabilityPublicKey>>;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  env = {
    MEDIA_DELIVERY_BASE_URL: BASE,
    MEDIA_CAP_SIGNING_PRIVATE_KEY: Buffer.from(
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    ).toString("base64"),
    MEDIA_CAP_KEY_ID: "k1",
    MEDIA_CAP_AUDIENCE: "aud-test",
  };
  publicKey = await importCapabilityPublicKey(
    Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64"),
  );
});

const verify = (url: string, assetId = ASSET) =>
  verifyCapability({
    token: new URL(url).searchParams.get("cap")!,
    assetId,
    audience: "aud-test",
    nowSeconds: Math.floor(NOW / 1000),
    keys: { k1: publicKey },
  });

describe("delivery base configuration", () => {
  it("unset → legacy mode (null)", () => {
    expect(getMediaDeliveryBase({})).toBeNull();
    expect(getMediaDeliveryBase({ MEDIA_DELIVERY_BASE_URL: "  " })).toBeNull();
  });
  it("valid https origin (trailing slash tolerated) and loopback http for local Worker dev", () => {
    expect(getMediaDeliveryBase({ MEDIA_DELIVERY_BASE_URL: `${BASE}/` })).toBe(BASE);
    expect(
      getMediaDeliveryBase({ MEDIA_DELIVERY_BASE_URL: "http://localhost:8787" }),
    ).toBe("http://localhost:8787");
  });
  it.each([
    "not a url",
    "http://media.example.test",
    "https://user:pass@media.example.test",
    "https://media.example.test/path",
    "https://media.example.test/?x=1",
    "https://media.example.test/#h",
    "ftp://media.example.test",
  ])("a defined but invalid base %s throws instead of silently falling back", (value) => {
    expect(() => getMediaDeliveryBase({ MEDIA_DELIVERY_BASE_URL: value })).toThrow(
      MediaDeliveryConfigError,
    );
  });
});

describe("public URLs (Community and Cosplay)", () => {
  it("secure mode: Worker origin, no token", () => {
    vi.stubEnv("MEDIA_DELIVERY_BASE_URL", BASE);
    expect(publicMediaUrl(KEY)).toBe(`${BASE}/${KEY}`);
    expect(cosplayPublicMediaUrl(`cosplay/${ASSET}/w480.webp`)).toBe(
      `${BASE}/cosplay/${ASSET}/w480.webp`,
    );
    expect(publicMediaUrl(`community/${ASSET}/original.mp4`)).toBe(
      `${BASE}/community/${ASSET}/original.mp4`,
    );
    expect(publicMediaUrl(KEY)).not.toContain("cap=");
  });
  it("legacy mode: unchanged legacy public URL", () => {
    vi.stubEnv("MEDIA_DELIVERY_BASE_URL", "");
    expect(publicMediaUrl(KEY)).toBe(`https://legacy.synthetic.example/${KEY}`);
  });
  it.each([
    "../secret",
    `community/${ASSET}/../${OTHER}/w480.webp`,
    `staging/community/${ASSET}/original.jpg`,
    `objects/community/${ASSET}/original.jpg`,
    `community/${ASSET}/original.jpg`,
    "community/asset-1/w1200.webp",
    "",
  ])("secure mode never builds a URL from the arbitrary key %j", (key) => {
    vi.stubEnv("MEDIA_DELIVERY_BASE_URL", BASE);
    expect(() => publicMediaUrl(key)).toThrow(MediaDeliveryConfigError);
  });
});

describe("access policy by post state", () => {
  const at = (status: string, purge: number | null) =>
    decideCommunityMediaAccess({ status, purgeAfterMs: purge, nowMs: NOW });
  it("published → public", () =>
    expect(at("published", null)).toEqual({ kind: "public" }));
  it("hidden_pending_review → private", () =>
    expect(at("hidden_pending_review", null)).toEqual({
      kind: "private",
      purgeAfterMs: null,
    }));
  it("removed before expiry → private with the deadline", () =>
    expect(at("removed_pending_purge", NOW + 1)).toEqual({
      kind: "private",
      purgeAfterMs: NOW + 1,
    }));
  it("removed at exact expiry, after expiry, missing or invalid deadline → none", () => {
    for (const purge of [NOW, NOW - 1, null, Number.NaN])
      expect(at("removed_pending_purge", purge)).toEqual({ kind: "none" });
  });
  it("manual hidden and unknown states → none", () => {
    for (const status of ["hidden", "deleted", "", "PUBLISHED"])
      expect(at(status, null)).toEqual({ kind: "none" });
  });
});

describe("private capabilities", () => {
  const input = { storageKey: KEY, assetId: ASSET, scope: "owner" as const, nowMs: NOW };
  it("issued only in secure mode, bound to the asset, with the right scope", async () => {
    const ctx = await loadMediaUrlContext(env);
    const url = await privateCommunityMediaUrl(ctx, input);
    expect(url!.startsWith(`${BASE}/${KEY}?cap=`)).toBe(true);
    expect(await verify(url!)).toMatchObject({
      ok: true,
      payload: { a: ASSET, s: "owner" },
    });
    expect((await verify(url!, OTHER)).ok).toBe(false);
  });
  it("legacy mode or missing signing key → null (never a public URL)", async () => {
    expect(
      await privateCommunityMediaUrl(await loadMediaUrlContext({}), input),
    ).toBeNull();
    const noKey = await loadMediaUrlContext({ MEDIA_DELIVERY_BASE_URL: BASE });
    expect(noKey.signing).toBeNull();
    expect(await privateCommunityMediaUrl(noKey, input)).toBeNull();
  });
  it("refuses to bind a key to a different asset or to a Cosplay key", async () => {
    const ctx = await loadMediaUrlContext(env);
    expect(await privateCommunityMediaUrl(ctx, { ...input, assetId: OTHER })).toBeNull();
    expect(
      await privateCommunityMediaUrl(ctx, {
        ...input,
        storageKey: `cosplay/${ASSET}/w480.webp`,
      }),
    ).toBeNull();
  });
  it("the capability is bound to the asset, not to one variant, and carries no storage key", async () => {
    const ctx = await loadMediaUrlContext(env);
    const a = await privateCommunityMediaUrl(ctx, input);
    const b = await privateCommunityMediaUrl(ctx, {
      ...input,
      storageKey: `community/${ASSET}/w480.webp`,
    });
    expect((await verify(a!)).ok).toBe(true);
    expect((await verify(b!)).ok).toBe(true);
    const payload = Buffer.from(
      new URL(a!).searchParams.get("cap")!.split(".")[1],
      "base64url",
    ).toString();
    expect(payload).not.toMatch(/w960|storage|community\//);
  });
});

describe("viewer / moderator / creator-preview URLs", () => {
  it("owner: published public, HPR capability, removed capped, expired/hidden none", async () => {
    vi.stubEnv("MEDIA_DELIVERY_BASE_URL", BASE);
    const ctx = await loadMediaUrlContext(env);
    const base = { scope: "owner" as const, nowMs: NOW, storageKey: KEY, assetId: ASSET };
    expect(
      await communityMediaUrlForViewer(ctx, {
        ...base,
        status: "published",
        purgeAfterMs: null,
      }),
    ).toBe(`${BASE}/${KEY}`);
    const hpr = await communityMediaUrlForViewer(ctx, {
      ...base,
      status: "hidden_pending_review",
      purgeAfterMs: null,
    });
    expect((await verify(hpr!)).ok).toBe(true);
    const purge = NOW + 60_000;
    const removed = await communityMediaUrlForViewer(ctx, {
      ...base,
      status: "removed_pending_purge",
      purgeAfterMs: purge,
    });
    const verified = await verify(removed!);
    expect(verified.ok && verified.payload.e).toBe(Math.floor(purge / 1000) - 5);
    for (const [status, purgeAfterMs] of [
      ["removed_pending_purge", NOW],
      ["hidden", null],
    ] as const)
      expect(
        await communityMediaUrlForViewer(ctx, { ...base, status, purgeAfterMs }),
      ).toBeNull();
  });
  it("moderatorMediaUrls: only keys with an available URL, moderator scope", async () => {
    vi.stubEnv("MEDIA_DELIVERY_BASE_URL", BASE);
    const ctx = await loadMediaUrlContext(env);
    const urls = await moderatorMediaUrls(ctx, {
      status: "hidden_pending_review",
      purgeAfterMs: null,
      nowMs: NOW,
      storageKeys: [KEY, KEY],
    });
    expect([...urls.keys()]).toEqual([KEY]);
    expect(await verify(urls.get(KEY)!)).toMatchObject({
      ok: true,
      payload: { s: "moderator" },
    });
    // R4-D5: removed sin vencer → capability de moderador acotada a purge_after − margen.
    const purge = NOW + 90_000;
    const removed = await moderatorMediaUrls(ctx, {
      status: "removed_pending_purge",
      purgeAfterMs: purge,
      nowMs: NOW,
      storageKeys: [KEY],
    });
    const removedCap = await verify(removed.get(KEY)!);
    expect(removedCap.ok && removedCap.payload.s).toBe("moderator");
    expect(removedCap.ok && removedCap.payload.e).toBe(Math.floor(purge / 1000) - 5);
    const none = await moderatorMediaUrls(ctx, {
      status: "removed_pending_purge",
      purgeAfterMs: NOW - 1,
      nowMs: NOW,
      storageKeys: [KEY],
    });
    expect(none.size).toBe(0);
  });
  it("creator preview: capability in secure mode (never the public URL), legacy URL in legacy mode", async () => {
    const ctx = await loadMediaUrlContext(env);
    const url = await creatorPreviewMediaUrl(ctx, {
      storageKey: KEY,
      assetId: ASSET,
      nowMs: NOW,
    });
    expect(url).toContain("cap=");
    expect(url).not.toBe(`${BASE}/${KEY}`);
    expect(await verify(url!)).toMatchObject({
      ok: true,
      payload: { s: "creator-preview" },
    });
    const legacy = await loadMediaUrlContext({});
    expect(
      await creatorPreviewMediaUrl(legacy, {
        storageKey: KEY,
        assetId: ASSET,
        nowMs: NOW,
      }),
    ).toBe(`https://legacy.synthetic.example/${KEY}`);
  });
  it("signing configuration is loaded consistently", async () => {
    expect((await loadCapabilitySigningConfig(env))?.keyId).toBe("k1");
  });
});
