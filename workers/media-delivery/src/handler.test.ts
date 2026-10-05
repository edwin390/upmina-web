// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_SIGNATURE_HEADER,
  ACCESS_TIMESTAMP_HEADER,
  importCapabilityPrivateKey,
  signCapability,
  toBase64Url,
  verifyAccessRequest,
  type CapabilityPayload,
  type CapabilityScope,
} from "../../../src/lib/media-delivery-protocol";
import {
  AuthorizationUnavailable,
  COSPLAY_CACHE_CONTROL,
  NEGATIVE_TTL_MS,
  POSITIVE_TTL_MS,
  PRIVATE_CACHE_CONTROL,
  PUBLIC_CACHE_CONTROL,
  PublicDecisionCache,
  handleMediaRequest,
  parseRange,
  type MediaBucket,
  type MediaEnv,
} from "./handler";

const ASSET = "0b2ad7a0-1c0e-4a8d-9a11-0c4f59f0a001";
const OTHER = "0b2ad7a0-1c0e-4a8d-9a11-0c4f59f0a002";
const AUD = "upmina-media-testing";
const SECRET = "synthetic-shared-secret";
const CHECK_URL = "https://app.example.test/api/media/access";
const BASE = "https://media.example.test";
const T0 = 1_800_000_000_000;
const BYTES = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
const b64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64");

let signKey: CryptoKey;
let publicKeysJson: string;
let wrongKey: CryptoKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  signKey = await importCapabilityPrivateKey(
    b64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  );
  publicKeysJson = JSON.stringify({
    k1: b64(await crypto.subtle.exportKey("spki", pair.publicKey)),
  });
  const other = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  wrongKey = await importCapabilityPrivateKey(
    b64(await crypto.subtle.exportKey("pkcs8", other.privateKey)),
  );
});

interface Harness {
  env: MediaEnv;
  clock: { now: number };
  bucketCalls: string[];
  checkCalls: Request[];
  setCheck(mode: "public" | "private" | "error" | "garbage"): void;
  request(path: string, init?: RequestInit): Promise<Response>;
}

function harness(): Harness {
  const objects = new Map<string, Uint8Array>();
  const keys = [
    `community/${ASSET}/w960.webp`,
    `community/${ASSET}/original.mp4`,
    `cosplay/${ASSET}/w960.webp`,
  ];
  for (const key of keys) objects.set(key, BYTES);
  const bucketCalls: string[] = [];
  const bucket: MediaBucket = {
    async head(key) {
      bucketCalls.push(`head:${key}`);
      const data = objects.get(key);
      return data ? { size: data.length, httpEtag: '"etag-1"' } : null;
    },
    async get(key, options) {
      bucketCalls.push(
        `get:${key}${options?.range ? `:${options.range.offset}+${options.range.length}` : ""}`,
      );
      const data = objects.get(key);
      if (!data) return null;
      const slice = options?.range
        ? data.slice(options.range.offset, options.range.offset + options.range.length)
        : data;
      return { size: data.length, body: new Blob([slice as BlobPart]).stream() };
    },
  };
  const env: MediaEnv = {
    MEDIA_BUCKET: bucket,
    MEDIA_CAP_PUBLIC_KEYS: publicKeysJson,
    MEDIA_CAP_AUDIENCE: AUD,
    MEDIA_CHECK_URL: CHECK_URL,
    MEDIA_CHECK_SHARED_SECRET: SECRET,
  };
  const clock = { now: T0 };
  const checkCalls: Request[] = [];
  let mode: "public" | "private" | "error" | "garbage" = "public";
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    checkCalls.push(new Request(input, init));
    if (mode === "error") return new Response("boom", { status: 500 });
    if (mode === "garbage")
      return new Response(JSON.stringify({ public: "yes", extra: 1 }));
    return new Response(JSON.stringify({ public: mode === "public" }));
  }) as typeof fetch;
  const cache = new PublicDecisionCache();
  return {
    env,
    clock,
    bucketCalls,
    checkCalls,
    setCheck: (m) => {
      mode = m;
    },
    request: (path, init) =>
      handleMediaRequest(new Request(`${BASE}${path}`, init), env, {
        now: () => clock.now,
        fetchImpl,
        cache,
      }),
  };
}

const payload = (over: Partial<CapabilityPayload> = {}): CapabilityPayload => ({
  v: 1,
  a: ASSET,
  s: "owner",
  e: Math.floor(T0 / 1000) + 300,
  u: AUD,
  k: "k1",
  ...over,
});
const cap = (over: Partial<CapabilityPayload> = {}, key = signKey) =>
  signCapability(payload(over), key);
const PATH = `/community/${ASSET}/w960.webp`;

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("public Community media", () => {
  it("published asset: authorized, correct headers, bytes served", async () => {
    const res = await h.request(PATH);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    expect(res.headers.get("Cache-Control")).toBe(PUBLIC_CACHE_CONTROL);
    expect(PUBLIC_CACHE_CONTROL).toBe("public, max-age=60");
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe("100");
  });
  it("never uses the long immutable policy for Community", async () => {
    const res = await h.request(PATH);
    expect(res.headers.get("Cache-Control")).not.toMatch(/immutable|31536000/);
  });
  it("private/denied asset: uniform 404 and the bucket is never touched", async () => {
    h.setCheck("private");
    const res = await h.request(PATH);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(h.bucketCalls).toEqual([]);
  });
  it("denied, missing object and bad capability are externally indistinguishable (404)", async () => {
    h.setCheck("private");
    const denied = await h.request(PATH);
    h.setCheck("public");
    const hh = harness();
    const missing = await hh.request(`/community/${OTHER}/w960.webp`);
    const bad = await harness().request(`${PATH}?cap=garbage`);
    h.setCheck("private");
    const privateWithBadCap = await h.request(`${PATH}?cap=garbage`);
    const view = async (r: Response) => [
      r.status,
      r.headers.get("Cache-Control"),
      await r.text(),
    ];
    const expected = await view(denied);
    expect(await view(missing)).toEqual(expected);
    expect(await view(privateWithBadCap)).toEqual(expected);
    expect(bad.status).toBe(200);
  });
  it("backend outage → 503 (operational, not existence), bucket untouched", async () => {
    h.setCheck("error");
    const res = await h.request(PATH);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(h.bucketCalls).toEqual([]);
  });
  it("malformed backend response is treated as an outage, never as permission", async () => {
    h.setCheck("garbage");
    expect((await h.request(PATH)).status).toBe(503);
    expect(h.bucketCalls).toEqual([]);
  });
  it("the check request is signed and verifiable by the backend verifier", async () => {
    await h.request(PATH);
    expect(h.checkCalls).toHaveLength(1);
    const call = h.checkCalls[0];
    expect(call.method).toBe("POST");
    expect(new URL(call.url).pathname).toBe("/api/media/access");
    expect(await call.json()).toEqual({ assetId: ASSET });
    const verified = await verifyAccessRequest(SECRET, {
      method: "POST",
      path: "/api/media/access",
      timestamp: call.headers.get(ACCESS_TIMESTAMP_HEADER) ?? undefined,
      signature: call.headers.get(ACCESS_SIGNATURE_HEADER) ?? undefined,
      assetId: ASSET,
      nowSeconds: Math.floor(T0 / 1000),
    });
    expect(verified).toEqual({ ok: true });
  });
  it("the Worker holds no database credential: the only outbound call is the signed check", async () => {
    await h.request(PATH);
    expect(h.checkCalls.every((c) => c.url === CHECK_URL)).toBe(true);
    expect(JSON.stringify(Object.keys(h.env))).not.toMatch(/SERVICE_ROLE|SUPABASE/i);
  });
});

describe("authorization cache (not a byte cache)", () => {
  it("positive decisions are cached for 30 s, then re-checked", async () => {
    await h.request(PATH);
    h.clock.now += POSITIVE_TTL_MS - 1;
    await h.request(PATH);
    expect(h.checkCalls).toHaveLength(1);
    h.clock.now += 2;
    await h.request(PATH);
    expect(h.checkCalls).toHaveLength(2);
  });
  it("negative decisions are cached for only 5 s", async () => {
    h.setCheck("private");
    await h.request(PATH);
    h.clock.now += NEGATIVE_TTL_MS - 1;
    await h.request(PATH);
    expect(h.checkCalls).toHaveLength(1);
    h.setCheck("public");
    h.clock.now += 2;
    expect((await h.request(PATH)).status).toBe(200);
    expect(h.checkCalls).toHaveLength(2);
  });
  it("revocation: after published → hidden the asset is denied once the 30 s decision expires", async () => {
    expect((await h.request(PATH)).status).toBe(200);
    h.setCheck("private");
    h.clock.now += POSITIVE_TTL_MS + 1;
    expect((await h.request(PATH)).status).toBe(404);
  });
  it("no stale-positive: within 30 s a backend failure is irrelevant; at expiry it fails closed (503)", async () => {
    await h.request(PATH);
    h.setCheck("error");
    h.clock.now += POSITIVE_TTL_MS - 1;
    expect((await h.request(PATH)).status).toBe(200);
    expect(h.checkCalls).toHaveLength(1);
    h.clock.now += 1;
    const res = await h.request(PATH);
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    h.clock.now += 90_000;
    expect((await h.request(PATH)).status).toBe(503);
  });
  it("a positive decision is never reused after its 30 s TTL, even 31 s later with the backend down", async () => {
    await h.request(PATH);
    const callsBefore = h.bucketCalls.length;
    h.setCheck("error");
    h.clock.now += POSITIVE_TTL_MS + 1;
    expect((await h.request(PATH)).status).toBe(503);
    expect(h.bucketCalls.length).toBe(callsBefore);
  });
  it("recovery: once the backend answers again the asset is served", async () => {
    await h.request(PATH);
    h.setCheck("error");
    h.clock.now += POSITIVE_TTL_MS + 1;
    expect((await h.request(PATH)).status).toBe(503);
    h.setCheck("public");
    expect((await h.request(PATH)).status).toBe(200);
  });
  it("a negative decision is never extended by stale-if-error", async () => {
    h.setCheck("private");
    await h.request(PATH);
    h.setCheck("error");
    h.clock.now += NEGATIVE_TTL_MS + 1;
    expect((await h.request(PATH)).status).toBe(503);
  });
  it("an authorization denial is enforced before ANY bucket read, even if bytes were served earlier", async () => {
    await h.request(PATH);
    const callsAfterFirst = h.bucketCalls.length;
    h.setCheck("private");
    h.clock.now += POSITIVE_TTL_MS + 1;
    expect((await h.request(PATH)).status).toBe(404);
    expect(h.bucketCalls.length).toBe(callsAfterFirst);
  });
  it("concurrent requests share a single in-flight check", async () => {
    await Promise.all([h.request(PATH), h.request(PATH), h.request(PATH)]);
    expect(h.checkCalls).toHaveLength(1);
  });
  it("PublicDecisionCache.decide propagates AuthorizationUnavailable without a prior decision", async () => {
    const cache = new PublicDecisionCache();
    await expect(
      cache.decide(
        ASSET,
        () => T0,
        async () => {
          throw new Error("down");
        },
      ),
    ).rejects.toBeInstanceOf(AuthorizationUnavailable);
  });
});

describe("private capabilities", () => {
  it.each(["owner", "moderator", "creator-preview"] as CapabilityScope[])(
    "valid %s capability: served without consulting the backend, private no-store",
    async (s) => {
      h.setCheck("private");
      const res = await h.request(`${PATH}?cap=${await cap({ s })}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe(PRIVATE_CACHE_CONTROL);
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(h.checkCalls).toHaveLength(0);
    },
  );
  it.each(["owner", "moderator", "creator-preview"] as CapabilityScope[])(
    "R4-D5: valid %s capability keeps serving while the authorization backend is down",
    async (s) => {
      h.setCheck("error");
      h.clock.now += POSITIVE_TTL_MS + 1;
      const res = await h.request(`${PATH}?cap=${await cap({ s })}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe(PRIVATE_CACHE_CONTROL);
      expect(h.checkCalls).toHaveLength(0);
      // Sin capability el mismo asset falla cerrado (503): nunca fallback ni positivo obsoleto.
      expect((await h.request(PATH)).status).toBe(503);
    },
  );
  it.each([
    ["expired", () => cap({ e: Math.floor(T0 / 1000) - 1 })],
    ["wrong asset", () => cap({ a: OTHER })],
    ["wrong audience", () => cap({ u: "upmina-media-production" })],
    ["unknown kid", () => cap({ k: "k9" })],
    ["wrong signing key", () => cap({}, wrongKey)],
    ["lifetime beyond the cap", () => cap({ e: Math.floor(T0 / 1000) + 99999 })],
  ])("%s capability on a non-public asset → uniform 404", async (_name, make) => {
    h.setCheck("private");
    const res = await h.request(`${PATH}?cap=${await make()}`);
    expect(res.status).toBe(404);
    expect(h.bucketCalls).toEqual([]);
  });
  it("tampered capability is rejected", async () => {
    h.setCheck("private");
    const token = await cap();
    const [v, p, s] = token.split(".");
    const forged = toBase64Url(
      new TextEncoder().encode(
        JSON.stringify(payload({ s: "moderator", e: payload().e + 9 })),
      ),
    );
    expect((await h.request(`${PATH}?cap=${v}.${forged}.${s}`)).status).toBe(404);
    expect((await h.request(`${PATH}?cap=${v}.${p}.${s.slice(0, -2)}AA`)).status).toBe(
      404,
    );
  });
  it("an invalid capability on a PUBLIC asset still gets the public response (never revealing why)", async () => {
    const res = await h.request(`${PATH}?cap=${await cap({ a: OTHER })}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(PUBLIC_CACHE_CONTROL);
  });
  it("R4-D2: a malformed or rejected capability is never reflected in any response", async () => {
    h.setCheck("private");
    const secretish = "v1.SENTINEL-TOKEN-VALUE.AAAA";
    const res = await h.request(`${PATH}?cap=${secretish}`);
    const text = await res.text();
    expect(text).not.toContain("SENTINEL");
    const headerDump: string[] = [];
    res.headers.forEach((value, name) => headerDump.push(`${name}:${value}`));
    expect(headerDump.join(" | ")).not.toContain("SENTINEL");
    h.setCheck("error");
    h.clock.now += POSITIVE_TTL_MS + 1;
    const outage = await h.request(`${PATH}?cap=${secretish}`);
    expect(await outage.text()).not.toContain("SENTINEL");
    expect(h.checkCalls.every((c) => !c.url.includes("SENTINEL"))).toBe(true);
  });
  it("capabilities are bound to the URL asset", async () => {
    h.setCheck("private");
    const token = await cap({ a: ASSET });
    expect((await h.request(`/community/${OTHER}/w960.webp?cap=${token}`)).status).toBe(
      404,
    );
  });
});

describe("path and object-key safety", () => {
  it.each([
    "/",
    "/community/not-a-uuid/w960.webp",
    `/community/${ASSET}/w700.webp`,
    `/community/${ASSET}/original.jpg`,
    `/community/${ASSET}/original.heic`,
    `/community/${ASSET}/w960.webp/extra`,
    `/community/${ASSET}/%2e%2e/w960.webp`,
    `/community/${ASSET}/%2E%2E%2Fw960.webp`,
    `/community/${ASSET}/..%2fw960.webp`,
    `/community/${ASSET}%2fw960.webp`,
    `/community/${ASSET}/w960.webp%00`,
    `/community/${ASSET}/%252e%252e/w960.webp`,
    `/staging/community/${ASSET}/original.jpg`,
    `/objects/community/${ASSET}/original.jpg`,
    `/other/${ASSET}/w960.webp`,
    `/cosplay/${ASSET}/original.mp4`,
    `/cosplay/${ASSET}/w700.webp`,
  ])("rejects %s without touching the bucket or the backend", async (path) => {
    const res = await h.request(path);
    expect(res.status).toBe(404);
    expect(h.bucketCalls).toEqual([]);
    expect(h.checkCalls).toHaveLength(0);
  });
  it("traversal that the URL parser normalizes still maps only to a validated key for the SAME checked asset", async () => {
    const res = await h.request(`/community/${OTHER}/../${ASSET}/w960.webp`);
    expect(res.status).toBe(200);
    expect(h.bucketCalls.every((c) => c.includes(`community/${ASSET}/w960.webp`))).toBe(
      true,
    );
    expect(JSON.parse(await h.checkCalls[0].text())).toEqual({ assetId: ASSET });
  });
  it("accepts the real video extensions and sets the matching content type", async () => {
    const res = await h.request(`/community/${ASSET}/original.mp4`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
  });
  it("only GET and HEAD are accepted", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await h.request(PATH, { method });
      expect(res.status).toBe(405);
    }
    expect(h.bucketCalls).toEqual([]);
  });
});

describe("Cosplay passthrough", () => {
  const COS = `/cosplay/${ASSET}/w960.webp`;
  it("served without any authorization check, with the long immutable policy", async () => {
    h.setCheck("error");
    const res = await h.request(COS);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(COSPLAY_CACHE_CONTROL);
    expect(COSPLAY_CACHE_CONTROL).toBe("public, max-age=31536000, immutable");
    expect(h.checkCalls).toHaveLength(0);
  });
  it("Community policy never affects Cosplay and vice versa", async () => {
    h.setCheck("private");
    expect((await h.request(PATH)).status).toBe(404);
    expect((await h.request(COS)).status).toBe(200);
    expect(h.bucketCalls).toEqual([
      `head:cosplay/${ASSET}/w960.webp`,
      `get:cosplay/${ASSET}/w960.webp`,
    ]);
  });
  it("a Cosplay key is built from the Cosplay prefix only", async () => {
    await h.request(`/cosplay/${OTHER}/w960.webp`);
    expect(h.bucketCalls).toEqual([`head:cosplay/${OTHER}/w960.webp`]);
  });
});

describe("Range support", () => {
  const VIDEO = `/community/${ASSET}/original.mp4`;
  it("valid single range: 206, Content-Range, Content-Length, only that range is read", async () => {
    const res = await h.request(VIDEO, { headers: { Range: "bytes=10-19" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 10-19/100");
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES.slice(10, 20));
    expect(h.bucketCalls).toContain(`get:community/${ASSET}/original.mp4:10+10`);
    expect(h.bucketCalls).not.toContain(`get:community/${ASSET}/original.mp4`);
  });
  it("open-ended and suffix ranges", async () => {
    const open = await h.request(VIDEO, { headers: { Range: "bytes=90-" } });
    expect(open.headers.get("Content-Range")).toBe("bytes 90-99/100");
    const suffix = await h.request(VIDEO, { headers: { Range: "bytes=-5" } });
    expect(suffix.headers.get("Content-Range")).toBe("bytes 95-99/100");
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(BYTES.slice(95));
  });
  it("end beyond the object is clamped", async () => {
    const res = await h.request(VIDEO, { headers: { Range: "bytes=95-5000" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 95-99/100");
  });
  it("unsatisfiable range → 416 with Content-Range */size and no body read", async () => {
    const res = await h.request(VIDEO, { headers: { Range: "bytes=100-120" } });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */100");
    expect(h.bucketCalls.some((c) => c.startsWith("get:"))).toBe(false);
    expect((await h.request(VIDEO, { headers: { Range: "bytes=-0" } })).status).toBe(416);
  });
  it("malformed or multi-range headers are ignored (full 200 response)", async () => {
    for (const range of [
      "bytes=abc",
      "items=1-2",
      "bytes=5-2",
      "bytes=0-1,5-6",
      "bytes=-",
    ]) {
      const res = await h.request(VIDEO, { headers: { Range: range } });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Length")).toBe("100");
    }
  });
  it("HEAD returns headers only and never reads the body", async () => {
    const res = await h.request(VIDEO, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("100");
    expect(await res.text()).toBe("");
    expect(h.bucketCalls.some((c) => c.startsWith("get:"))).toBe(false);
  });
  it("conditional request with a matching ETag → 304 (still authorized first)", async () => {
    const res = await h.request(PATH, { headers: { "If-None-Match": '"etag-1"' } });
    expect(res.status).toBe(304);
    h.setCheck("private");
    h.clock.now += POSITIVE_TTL_MS + 1;
    const denied = await h.request(PATH, { headers: { "If-None-Match": '"etag-1"' } });
    expect(denied.status).toBe(404);
  });
  it("Range works with a private capability too", async () => {
    h.setCheck("private");
    const res = await h.request(`${VIDEO}?cap=${await cap()}`, {
      headers: { Range: "bytes=0-4" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Cache-Control")).toBe(PRIVATE_CACHE_CONTROL);
  });
});

describe("parseRange", () => {
  it.each([
    [null, 10, { kind: "none" }],
    ["bytes=0-3", 10, { kind: "range", start: 0, end: 3 }],
    ["bytes=8-", 10, { kind: "range", start: 8, end: 9 }],
    ["bytes=-4", 10, { kind: "range", start: 6, end: 9 }],
    ["bytes=-50", 10, { kind: "range", start: 0, end: 9 }],
    ["bytes=10-", 10, { kind: "unsatisfiable" }],
    ["bytes=0-1", 0, { kind: "unsatisfiable" }],
    ["bytes=x-y", 10, { kind: "none" }],
  ])("%s on size %i", (header, size, expected) => {
    expect(parseRange(header as string | null, size)).toEqual(expected);
  });
});

vi.setConfig({ testTimeout: 15000 });
