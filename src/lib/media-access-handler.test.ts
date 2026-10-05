// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  ACCESS_CHECK_PATH,
  ACCESS_SIGNATURE_HEADER,
  ACCESS_TIMESTAMP_HEADER,
  signAccessRequest,
} from "./media-delivery-protocol";

const ASSET = "0b2ad7a0-1c0e-4a8d-9a11-0c4f59f0a001";
const SECRET = "synthetic-shared-secret";
const fake = vi.hoisted(() => ({
  calls: [] as { name: string; args: Record<string, unknown> }[],
  result: undefined as { data: unknown; error: unknown } | undefined,
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    async rpc(name: string, args: Record<string, unknown>) {
      fake.calls.push({ name, args });
      return fake.result ?? { data: null, error: { message: "no result" } };
    },
  }),
}));
const { handleMediaAccess } = await import("./media-access-handler");

const state = (delivery: string, domain: string | null = "community") => ({
  data: { exists: domain !== null, domain, delivery, privateUntil: null },
  error: null,
});

async function call(over: {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | undefined>;
  sign?: Parameters<typeof signAccessRequest>[1] | null;
}) {
  const method = over.method ?? "POST";
  const body = over.body === undefined ? { assetId: ASSET } : over.body;
  const headers: Record<string, string | undefined> = { ...over.headers };
  if (over.sign !== null) {
    const signed = await signAccessRequest(
      SECRET,
      over.sign ?? {
        method: "POST",
        path: ACCESS_CHECK_PATH,
        timestampSeconds: Math.floor(Date.now() / 1000),
        assetId: ASSET,
      },
    );
    headers[ACCESS_TIMESTAMP_HEADER] ??= signed.timestamp;
    headers[ACCESS_SIGNATURE_HEADER] ??= signed.signature;
  }
  const out: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const res = {
    setHeader: (k: string, v: string) => ((out.headers[k] = v), res),
    status: (c: number) => ((out.status = c), res),
    json: (b: unknown) => ((out.body = b), res),
  };
  await handleMediaAccess(
    { method, body, headers } as unknown as VercelRequest,
    res as unknown as VercelResponse,
  );
  return out;
}

beforeEach(() => {
  fake.calls = [];
  fake.result = undefined;
  vi.stubEnv("MEDIA_CHECK_SHARED_SECRET", SECRET);
  vi.stubEnv("VITE_SUPABASE_URL", "https://fixture.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-role");
});

describe("POST /api/media/access", () => {
  it("public asset → { public: true } and nothing else", async () => {
    fake.result = state("public");
    const out = await call({});
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ public: true });
    expect(out.headers["Cache-Control"]).toBe("private, no-store");
    expect(fake.calls).toEqual([
      { name: "community_media_delivery_state", args: { p_asset_id: ASSET } },
    ]);
  });
  it.each([
    ["private", "community"],
    ["denied", "community"],
    ["public", null],
  ])(
    "delivery=%s domain=%s → { public: false } with no internal state",
    async (d, domain) => {
      fake.result = state(d, domain);
      const out = await call({});
      expect(out.body).toEqual({ public: false });
    },
  );
  it("rejects non-POST methods without touching the database", async () => {
    const out = await call({ method: "GET" });
    expect(out.status).toBe(405);
    expect(fake.calls).toHaveLength(0);
  });
  it("invalid signature, missing headers, stale and future timestamps → 401, no DB call", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const over of [
      { headers: { [ACCESS_SIGNATURE_HEADER]: "AAAA" } },
      { sign: null },
      {
        sign: {
          method: "POST",
          path: ACCESS_CHECK_PATH,
          timestampSeconds: now - 120,
          assetId: ASSET,
        },
      },
      {
        sign: {
          method: "POST",
          path: ACCESS_CHECK_PATH,
          timestampSeconds: now + 120,
          assetId: ASSET,
        },
      },
    ] as const) {
      const out = await call(over as never);
      expect(out.status).toBe(401);
      expect(out.body).toEqual({ error: "No autorizado" });
    }
    expect(fake.calls).toHaveLength(0);
  });
  it("signature bound to method, path and body", async () => {
    const now = Math.floor(Date.now() / 1000);
    const wrongPath = await call({
      sign: {
        method: "POST",
        path: "/api/media/reserve",
        timestampSeconds: now,
        assetId: ASSET,
      },
    });
    expect(wrongPath.status).toBe(401);
    const otherAsset = "0b2ad7a0-1c0e-4a8d-9a11-0c4f59f0a002";
    const modifiedBody = await call({ body: { assetId: otherAsset } });
    expect(modifiedBody.status).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });
  it("malformed bodies and non-UUID asset ids are rejected before the database", async () => {
    expect((await call({ body: {} })).status).toBe(400);
    expect((await call({ body: "not json" })).status).toBe(400);
    expect((await call({ body: [ASSET] })).status).toBe(400);
    const now = Math.floor(Date.now() / 1000);
    const bad = "not-a-uuid";
    const out = await call({
      body: { assetId: bad },
      sign: {
        method: "POST",
        path: ACCESS_CHECK_PATH,
        timestampSeconds: now,
        assetId: bad,
      },
    });
    expect(out.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });
  it("database error or malformed state → generic 500, no internals", async () => {
    fake.result = { data: null, error: { message: "boom", code: "XX000" } };
    const out = await call({});
    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toMatch(/boom|XX000/);
    fake.result = {
      data: { exists: true, domain: "community", delivery: "weird", privateUntil: null },
      error: null,
    };
    expect((await call({})).status).toBe(500);
  });
  it("missing shared secret fails closed", async () => {
    vi.stubEnv("MEDIA_CHECK_SHARED_SECRET", "");
    expect((await call({})).status).toBe(500);
    expect(fake.calls).toHaveLength(0);
  });
  it("replay of a valid request inside the window only repeats the read-only boolean query", async () => {
    fake.result = state("public");
    const now = Math.floor(Date.now() / 1000);
    const signed = await signAccessRequest(SECRET, {
      method: "POST",
      path: ACCESS_CHECK_PATH,
      timestampSeconds: now,
      assetId: ASSET,
    });
    const headers = {
      [ACCESS_TIMESTAMP_HEADER]: signed.timestamp,
      [ACCESS_SIGNATURE_HEADER]: signed.signature,
    };
    expect((await call({ headers, sign: null })).body).toEqual({ public: true });
    expect((await call({ headers, sign: null })).body).toEqual({ public: true });
  });
});
