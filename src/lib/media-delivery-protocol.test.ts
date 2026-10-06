// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import {
  ACCESS_CHECK_PATH,
  CAPABILITY_VERSION,
  MAX_CAPABILITY_LIFETIME_SECONDS,
  fromBase64Url,
  importCapabilityPrivateKey,
  importCapabilityPublicKey,
  parseMediaPath,
  signAccessRequest,
  signGcRequest,
  verifyGcRequest,
  signCapability,
  toBase64Url,
  verifyAccessRequest,
  verifyCapability,
  type CapabilityPayload,
} from "./media-delivery-protocol";
import {
  PURGE_SAFETY_MARGIN_SECONDS,
  computeCapabilityExpiry,
  issueCapability,
  loadCapabilitySigningConfig,
  withCapability,
} from "./media-capability";

const ASSET = "0b2ad7a0-1c0e-4a8d-9a11-0c4f59f0a001";
const OTHER_ASSET = "0b2ad7a0-1c0e-4a8d-9a11-0c4f59f0a002";
const NOW = 1_800_000_000;
const AUD = "upmina-media-testing";
const b64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64");

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let otherPublicKey: CryptoKey;
let privateB64: string;
let publicB64: string;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  privateB64 = b64(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  publicB64 = b64(await crypto.subtle.exportKey("spki", pair.publicKey));
  privateKey = await importCapabilityPrivateKey(privateB64);
  publicKey = await importCapabilityPublicKey(publicB64);
  const other = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  otherPublicKey = await importCapabilityPublicKey(
    b64(await crypto.subtle.exportKey("spki", other.publicKey)),
  );
});

const payload = (over: Partial<CapabilityPayload> = {}): CapabilityPayload => ({
  v: CAPABILITY_VERSION,
  a: ASSET,
  s: "owner",
  e: NOW + 300,
  u: AUD,
  k: "k1",
  ...over,
});
const verify = (token: string, over: Record<string, unknown> = {}) =>
  verifyCapability({
    token,
    assetId: ASSET,
    audience: AUD,
    nowSeconds: NOW,
    keys: { k1: publicKey },
    ...over,
  });

describe("capabilities Ed25519", () => {
  it.each(["owner", "moderator", "creator-preview"] as const)("valid %s", async (s) => {
    const result = await verify(await signCapability(payload({ s }), privateKey));
    expect(result).toMatchObject({ ok: true, payload: { s, a: ASSET } });
  });
  it("the payload carries no identity or moderation data", async () => {
    const token = await signCapability(payload(), privateKey);
    const decoded = JSON.parse(
      new TextDecoder().decode(fromBase64Url(token.split(".")[1])!),
    );
    expect(Object.keys(decoded).sort()).toEqual(["a", "e", "k", "s", "u", "v"]);
  });
  it("expired and exact expiry boundary (exp == now is expired, exp == now+1 is valid)", async () => {
    expect(await verify(await signCapability(payload({ e: NOW }), privateKey))).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(
      await verify(await signCapability(payload({ e: NOW - 1 }), privateKey)),
    ).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(
      (await verify(await signCapability(payload({ e: NOW + 1 }), privateKey))).ok,
    ).toBe(true);
  });
  it("rejects lifetimes beyond the cap even when correctly signed", async () => {
    const tooLong = await signCapability(
      payload({ e: NOW + MAX_CAPABILITY_LIFETIME_SECONDS + 1 }),
      privateKey,
    );
    expect(await verify(tooLong)).toEqual({ ok: false, reason: "lifetime" });
    const maxOk = await signCapability(
      payload({ e: NOW + MAX_CAPABILITY_LIFETIME_SECONDS }),
      privateKey,
    );
    expect((await verify(maxOk)).ok).toBe(true);
  });
  it("wrong audience, wrong asset, disallowed scope", async () => {
    const token = await signCapability(payload(), privateKey);
    expect(await verify(token, { audience: "upmina-media-production" })).toEqual({
      ok: false,
      reason: "audience",
    });
    expect(await verify(token, { assetId: OTHER_ASSET })).toEqual({
      ok: false,
      reason: "asset",
    });
    expect(await verify(token, { allowedScopes: ["moderator"] })).toEqual({
      ok: false,
      reason: "scope",
    });
  });
  it("a moderator capability is bound to one asset, never universal", async () => {
    const token = await signCapability(payload({ s: "moderator" }), privateKey);
    expect((await verify(token)).ok).toBe(true);
    expect((await verify(token, { assetId: OTHER_ASSET })).ok).toBe(false);
  });
  it("unknown kid, wrong public key, prototype-key kid", async () => {
    const token = await signCapability(payload(), privateKey);
    expect(await verify(token, { keys: { other: publicKey } })).toEqual({
      ok: false,
      reason: "unknown-kid",
    });
    expect(await verify(token, { keys: { k1: otherPublicKey } })).toEqual({
      ok: false,
      reason: "signature",
    });
    const proto = await signCapability(payload({ k: "constructor" }), privateKey);
    expect(await verify(proto)).toEqual({ ok: false, reason: "unknown-kid" });
  });
  it("malformed tokens fail closed", async () => {
    for (const token of [
      "",
      "garbage",
      "v1.a.b",
      "v1..",
      "v1.!!!.???",
      `v1.${toBase64Url(new TextEncoder().encode("{}"))}.${toBase64Url(new Uint8Array(64))}`,
      "x".repeat(600),
      "v1.a.b.c",
      "\u0000v1.a.b",
    ])
      expect((await verify(token)).ok).toBe(false);
  });
  it("modified payload or modified signature is rejected", async () => {
    const token = await signCapability(payload(), privateKey);
    const [v, p, s] = token.split(".");
    const forged = toBase64Url(
      new TextEncoder().encode(JSON.stringify(payload({ a: OTHER_ASSET }))),
    );
    expect(await verify(`${v}.${forged}.${s}`, { assetId: OTHER_ASSET })).toEqual({
      ok: false,
      reason: "signature",
    });
    const sig = fromBase64Url(s)!;
    sig[0] ^= 0xff;
    expect(await verify(`${v}.${p}.${toBase64Url(sig)}`)).toEqual({
      ok: false,
      reason: "signature",
    });
  });
  it("unsupported version and extra payload fields are rejected", async () => {
    const token = await signCapability(payload(), privateKey);
    expect(await verify(token.replace(/^v1/, "v2"))).toEqual({
      ok: false,
      reason: "version",
    });
    const extra = await signCapability(
      { ...payload(), email: "x@example.test" } as unknown as CapabilityPayload,
      privateKey,
    );
    expect(await verify(extra)).toEqual({ ok: false, reason: "malformed" });
    const fakeVersion = await signCapability(
      payload({ v: 2 as unknown as 1 }),
      privateKey,
    );
    expect(await verify(fakeVersion)).toEqual({ ok: false, reason: "version" });
  });
  it("Unicode / non-canonical encodings in the token are rejected", async () => {
    const token = await signCapability(payload(), privateKey);
    expect((await verify(token + "é")).ok).toBe(false);
    const [v, p, sig] = token.split(".");
    expect(await verify(`${v}.${p}=.${sig}`)).toEqual({ ok: false, reason: "malformed" });
    expect((await verify(token.split(".").join(" "))).ok).toBe(false);
  });
});

describe("expiry helpers and issuance", () => {
  const nowMs = NOW * 1000;
  it("default ttl: owner/moderator 10 min, creator-preview 60 min", () => {
    expect(computeCapabilityExpiry({ scope: "owner", nowMs })).toBe(NOW + 600);
    expect(computeCapabilityExpiry({ scope: "moderator", nowMs })).toBe(NOW + 600);
    expect(computeCapabilityExpiry({ scope: "creator-preview", nowMs })).toBe(NOW + 3600);
  });
  it("removed content never outlives purge_after minus the safety margin", () => {
    const purgeAfterMs = (NOW + 120) * 1000;
    expect(computeCapabilityExpiry({ scope: "owner", nowMs, purgeAfterMs })).toBe(
      NOW + 120 - PURGE_SAFETY_MARGIN_SECONDS,
    );
  });
  it("no capability when purge_after is within the margin, exact, or past", () => {
    for (const offset of [PURGE_SAFETY_MARGIN_SECONDS, 0, -1, -3600])
      expect(
        computeCapabilityExpiry({
          scope: "owner",
          nowMs,
          purgeAfterMs: (NOW + offset) * 1000,
        }),
      ).toBeNull();
    expect(
      computeCapabilityExpiry({ scope: "owner", nowMs, purgeAfterMs: Number.NaN }),
    ).toBeNull();
  });
  it("far purge_after does not extend the default ttl", () => {
    expect(
      computeCapabilityExpiry({
        scope: "owner",
        nowMs,
        purgeAfterMs: (NOW + 72 * 3600) * 1000,
      }),
    ).toBe(NOW + 600);
  });
  it("issue → verify round trip via env config; missing config fails closed", async () => {
    const config = await loadCapabilitySigningConfig({
      MEDIA_CAP_SIGNING_PRIVATE_KEY: privateB64,
      MEDIA_CAP_KEY_ID: "k1",
      MEDIA_CAP_AUDIENCE: AUD,
    });
    expect(config).not.toBeNull();
    const token = await issueCapability(config!, {
      assetId: ASSET,
      scope: "creator-preview",
      expiresAtSeconds: NOW + 60,
    });
    expect((await verify(token)).ok).toBe(true);
    expect(await loadCapabilitySigningConfig({})).toBeNull();
    expect(
      await loadCapabilitySigningConfig({
        MEDIA_CAP_SIGNING_PRIVATE_KEY: "not-base64!!",
        MEDIA_CAP_KEY_ID: "k1",
        MEDIA_CAP_AUDIENCE: AUD,
      }),
    ).toBeNull();
  });
  it("withCapability appends only the cap parameter", () => {
    expect(
      withCapability("https://media.example.test/community/a/w480.webp", "tok"),
    ).toBe("https://media.example.test/community/a/w480.webp?cap=tok");
  });
});

describe("signed access request (HMAC)", () => {
  const secret = "synthetic-shared-secret";
  const base = { method: "POST", path: ACCESS_CHECK_PATH, assetId: ASSET };
  const check = async (
    over: Record<string, unknown> = {},
    signOver: Record<string, unknown> = {},
  ) => {
    const signed = await signAccessRequest(secret, {
      ...base,
      timestampSeconds: NOW,
      ...signOver,
    });
    return verifyAccessRequest(secret, {
      ...base,
      timestamp: signed.timestamp,
      signature: signed.signature,
      nowSeconds: NOW,
      ...over,
    });
  };
  it("accepts a valid signature, including within the tolerance window", async () => {
    expect(await check()).toEqual({ ok: true });
    expect(await check({ nowSeconds: NOW + 30 })).toEqual({ ok: true });
    expect(await check({ nowSeconds: NOW - 30 })).toEqual({ ok: true });
  });
  it("rejects stale and future timestamps", async () => {
    expect(await check({ nowSeconds: NOW + 31 })).toEqual({
      ok: false,
      reason: "timestamp",
    });
    expect(await check({ nowSeconds: NOW - 31 })).toEqual({
      ok: false,
      reason: "timestamp",
    });
  });
  it("rejects wrong method, path, assetId and secret", async () => {
    expect((await check({ method: "GET" })).ok).toBe(false);
    expect((await check({ path: "/api/media/other" })).ok).toBe(false);
    expect((await check({ assetId: OTHER_ASSET })).ok).toBe(false);
    const signed = await signAccessRequest("other-secret", {
      ...base,
      timestampSeconds: NOW,
    });
    expect(
      (
        await verifyAccessRequest(secret, {
          ...base,
          timestamp: signed.timestamp,
          signature: signed.signature,
          nowSeconds: NOW,
        })
      ).ok,
    ).toBe(false);
  });
  it("rejects missing or malformed headers", async () => {
    expect(await check({ signature: undefined })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await check({ timestamp: undefined })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await check({ timestamp: "12abc" })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await check({ signature: "!!!" })).toEqual({ ok: false, reason: "malformed" });
  });
  it("replay inside the window is accepted by design: it can only repeat the same read-only boolean query for the same signed asset", async () => {
    const signed = await signAccessRequest(secret, { ...base, timestampSeconds: NOW });
    const input = { ...base, ...signed, nowSeconds: NOW + 5 };
    expect((await verifyAccessRequest(secret, input)).ok).toBe(true);
    expect((await verifyAccessRequest(secret, input)).ok).toBe(true);
    expect(
      (await verifyAccessRequest(secret, { ...input, assetId: OTHER_ASSET })).ok,
    ).toBe(false);
  });
});

describe("parseMediaPath", () => {
  it.each([
    ["/community/" + ASSET + "/w480.webp", "image/webp"],
    ["/community/" + ASSET + "/w960.webp", "image/webp"],
    ["/community/" + ASSET + "/w1600.webp", "image/webp"],
    ["/community/" + ASSET + "/w2560.webp", "image/webp"],
    ["/community/" + ASSET + "/original.mp4", "video/mp4"],
    ["/community/" + ASSET + "/original.mov", "video/quicktime"],
    ["/community/" + ASSET + "/original.webm", "video/webm"],
    ["/cosplay/" + ASSET + "/w960.webp", "image/webp"],
  ])("accepts %s", (path, contentType) => {
    const parsed = parseMediaPath(path);
    expect(parsed).not.toBeNull();
    expect(parsed!.contentType).toBe(contentType);
    expect(parsed!.key).toBe(path.slice(1));
  });
  it.each([
    "/community/" + ASSET + "/w700.webp",
    "/community/" + ASSET + "/original.jpg",
    "/community/" + ASSET + "/original.heic",
    "/community/" + ASSET + "/../" + OTHER_ASSET + "/w480.webp",
    "/community/" + ASSET + "/%2e%2e/w480.webp",
    "/community/" + ASSET + "/%2E%2E%2Fw480.webp",
    "/community/" + ASSET + "/w480.webp%00",
    "/community/" + ASSET + "/w480%2ewebp",
    "/community/" + ASSET + "%2fw480.webp",
    "/community/" + ASSET + "/%252e%252e/w480.webp",
    "/community\\" + ASSET + "/w480.webp",
    "/community/" + ASSET + "\\w480.webp",
    "//community/" + ASSET + "/w480.webp",
    "/community//" + ASSET + "/w480.webp",
    "/community/" + ASSET.toUpperCase() + "/w480.webp",
    "/community/not-a-uuid/w480.webp",
    "/community/" + ASSET + "/w480.webp/extra",
    "/community/" + ASSET,
    "/cosplay/" + ASSET + "/original.mp4",
    "/staging/community/" + ASSET + "/original.jpg",
    "/objects/community/" + ASSET + "/original.jpg",
    "/other/" + ASSET + "/w480.webp",
    "/community/" + ASSET + "/w480.webp?x=1",
    "/community/" + ASSET + "/w480.webp ",
    "",
    "/",
  ])("rejects %j", (path) => {
    expect(parseMediaPath(path)).toBeNull();
  });
});

describe("GC request signing (R4-E2) — domain separated from access", () => {
  const SECRET = "synthetic-gc-secret";
  const input = {
    method: "POST",
    path: "/api/media/gc",
    timestampSeconds: 1_800_000_000,
  };
  it("round-trips and is bound to method, path and timestamp", async () => {
    const { timestamp, signature } = await signGcRequest(SECRET, input);
    const base = {
      method: "POST",
      path: "/api/media/gc",
      timestamp,
      signature,
      nowSeconds: 1_800_000_000,
    };
    expect((await verifyGcRequest(SECRET, base)).ok).toBe(true);
    for (const tampered of [
      { ...base, method: "GET" },
      { ...base, path: "/api/media/access" },
      { ...base, timestamp: String(Number(timestamp) + 1) },
    ])
      expect((await verifyGcRequest(SECRET, tampered)).ok).toBe(false);
    expect((await verifyGcRequest("other-secret", base)).ok).toBe(false);
  });
  it("±30 s freshness window", async () => {
    const { timestamp, signature } = await signGcRequest(SECRET, input);
    const at = (nowSeconds: number) =>
      verifyGcRequest(SECRET, {
        method: "POST",
        path: "/api/media/gc",
        timestamp,
        signature,
        nowSeconds,
      });
    expect((await at(1_800_000_030)).ok).toBe(true);
    expect((await at(1_799_999_970)).ok).toBe(true);
    expect(await at(1_800_000_031)).toEqual({ ok: false, reason: "timestamp" });
    expect(await at(1_799_999_969)).toEqual({ ok: false, reason: "timestamp" });
  });
  it("an access signature never verifies as a GC signature, nor the reverse (same secret)", async () => {
    const access = await signAccessRequest(SECRET, { ...input, assetId: "" });
    expect(
      (
        await verifyGcRequest(SECRET, {
          method: "POST",
          path: "/api/media/gc",
          timestamp: access.timestamp,
          signature: access.signature,
          nowSeconds: 1_800_000_000,
        })
      ).ok,
    ).toBe(false);
    const gc = await signGcRequest(SECRET, input);
    expect(
      (
        await verifyAccessRequest(SECRET, {
          method: "POST",
          path: "/api/media/gc",
          timestamp: gc.timestamp,
          signature: gc.signature,
          assetId: "",
          nowSeconds: 1_800_000_000,
        })
      ).ok,
    ).toBe(false);
  });
  it("malformed input is rejected as malformed", async () => {
    for (const bad of [
      { timestamp: undefined, signature: "AAAA" },
      { timestamp: "12x", signature: "AAAA" },
      { timestamp: "1800000000", signature: "AAAA" },
      { timestamp: "1800000000", signature: undefined },
    ])
      expect(
        await verifyGcRequest(SECRET, {
          method: "POST",
          path: "/api/media/gc",
          nowSeconds: 1_800_000_000,
          ...bad,
        }),
      ).toEqual({ ok: false, reason: "malformed" });
  });
});
