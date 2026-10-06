// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  ACCESS_SIGNATURE_HEADER,
  ACCESS_TIMESTAMP_HEADER,
  GC_REQUEST_PATH,
  signAccessRequest,
  signGcRequest,
} from "./media-delivery-protocol";

// R4-E2: autenticación del endpoint interno /api/media/gc. El motor se sustituye por un espía: aquí
// solo importa QUIÉN puede dispararlo y QUE la petición no pueda elegir nada.

const runMediaGcBatch = vi.hoisted(() => vi.fn());
vi.mock("./media-gc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media-gc")>()),
  runMediaGcBatch,
}));
const { GcUnavailableError } = await import("./media-gc");
const { handleMediaGc } = await import("./media-gc-handler");

const SECRET = "synthetic-gc-secret-for-tests-only";
const SUMMARY = { claimed: 2, finalized: 2, failed: 0 };
const nowSeconds = () => Math.floor(Date.now() / 1000);

interface Captured {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}
async function call(
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    query?: Record<string, unknown>;
  } = {},
): Promise<Captured> {
  const out: Captured = { status: 0, body: undefined, headers: {} };
  const res = {
    setHeader: (k: string, v: string) => ((out.headers[k] = v), res),
    status: (c: number) => ((out.status = c), res),
    json: (b: unknown) => ((out.body = b), res),
  };
  await handleMediaGc(
    {
      method: options.method ?? "POST",
      headers: options.headers ?? {},
      body: options.body,
      query: options.query ?? { resource: "gc" },
    } as unknown as VercelRequest,
    res as unknown as VercelResponse,
  );
  return out;
}
async function signed(
  overrides: {
    secret?: string;
    timestampSeconds?: number;
    path?: string;
    method?: string;
  } = {},
) {
  const { timestamp, signature } = await signGcRequest(overrides.secret ?? SECRET, {
    method: overrides.method ?? "POST",
    path: overrides.path ?? GC_REQUEST_PATH,
    timestampSeconds: overrides.timestampSeconds ?? nowSeconds(),
  });
  return { [ACCESS_TIMESTAMP_HEADER]: timestamp, [ACCESS_SIGNATURE_HEADER]: signature };
}

beforeEach(() => {
  vi.stubEnv("MEDIA_GC_SHARED_SECRET", SECRET);
  runMediaGcBatch.mockReset().mockResolvedValue(SUMMARY);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/media/gc — authentication", () => {
  it("a valid HMAC runs exactly one server-authoritative batch and returns only counts", async () => {
    const r = await call({ headers: await signed() });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(SUMMARY);
    expect(runMediaGcBatch).toHaveBeenCalledTimes(1);
    expect(runMediaGcBatch).toHaveBeenCalledWith(); // nothing from the request reaches the engine
    expect(r.headers["Cache-Control"]).toBe("private, no-store");
  });
  it("missing authentication → 401 and no work", async () => {
    const r = await call();
    expect(r.status).toBe(401);
    expect(runMediaGcBatch).not.toHaveBeenCalled();
  });
  it("invalid signature → 401", async () => {
    const h = await signed();
    h[ACCESS_SIGNATURE_HEADER] = h[ACCESS_SIGNATURE_HEADER].slice(0, -2) + "AA";
    expect((await call({ headers: h })).status).toBe(401);
    expect(runMediaGcBatch).not.toHaveBeenCalled();
  });
  it("a signature made with another secret → 401", async () => {
    expect(
      (await call({ headers: await signed({ secret: "another-secret" }) })).status,
    ).toBe(401);
  });
  it.each([-31, 31, -3600, 3600])("timestamp %i s away from now → 401", async (delta) => {
    const r = await call({
      headers: await signed({ timestampSeconds: nowSeconds() + delta }),
    });
    expect(r.status).toBe(401);
    expect(runMediaGcBatch).not.toHaveBeenCalled();
  });
  it("a timestamp inside the window is accepted", async () => {
    expect(
      (await call({ headers: await signed({ timestampSeconds: nowSeconds() - 20 }) }))
        .status,
    ).toBe(200);
  });
  it("malformed headers → 401", async () => {
    const malformed: Record<string, string>[] = [
      { [ACCESS_TIMESTAMP_HEADER]: "abc", [ACCESS_SIGNATURE_HEADER]: "AAAA" },
      { [ACCESS_TIMESTAMP_HEADER]: String(nowSeconds()) },
      { [ACCESS_SIGNATURE_HEADER]: "AAAA" },
      { [ACCESS_TIMESTAMP_HEADER]: String(nowSeconds()), [ACCESS_SIGNATURE_HEADER]: "" },
    ];
    for (const headers of malformed) expect((await call({ headers })).status).toBe(401);
    expect(runMediaGcBatch).not.toHaveBeenCalled();
  });
  it("only POST is accepted", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const r = await call({ method, headers: await signed({ method }) });
      expect(r.status).toBe(405);
      expect(r.headers.Allow).toBe("POST");
    }
    expect(runMediaGcBatch).not.toHaveBeenCalled();
  });
  it("fails closed when the secret is not configured (even with a plausible signature)", async () => {
    vi.stubEnv("MEDIA_GC_SHARED_SECRET", "");
    const r = await call({ headers: await signed() });
    expect(r.status).toBe(500);
    expect(runMediaGcBatch).not.toHaveBeenCalled();
  });
});

describe("POST /api/media/gc — domain separation", () => {
  it("a signature minted for /api/media/access (same secret) can never trigger the GC", async () => {
    const { timestamp, signature } = await signAccessRequest(SECRET, {
      method: "POST",
      path: "/api/media/access",
      timestampSeconds: nowSeconds(),
      assetId: "",
    });
    const r = await call({
      headers: {
        [ACCESS_TIMESTAMP_HEADER]: timestamp,
        [ACCESS_SIGNATURE_HEADER]: signature,
      },
    });
    expect(r.status).toBe(401);
    const asGcPath = await signAccessRequest(SECRET, {
      method: "POST",
      path: GC_REQUEST_PATH,
      timestampSeconds: nowSeconds(),
      assetId: "",
    });
    expect(
      (
        await call({
          headers: {
            [ACCESS_TIMESTAMP_HEADER]: asGcPath.timestamp,
            [ACCESS_SIGNATURE_HEADER]: asGcPath.signature,
          },
        })
      ).status,
    ).toBe(401);
    expect(runMediaGcBatch).not.toHaveBeenCalled();
  });
  it("a GC signature is bound to path and method", async () => {
    expect(
      (await call({ headers: await signed({ path: "/api/media/access" }) })).status,
    ).toBe(401);
    expect((await call({ headers: await signed({ method: "GET" }) })).status).toBe(401);
  });
  it("the GC secret is its own variable: the access secret does not authorize GC", async () => {
    vi.stubEnv("MEDIA_CHECK_SHARED_SECRET", "access-secret-only");
    expect(
      (await call({ headers: await signed({ secret: "access-secret-only" }) })).status,
    ).toBe(401);
  });
});

describe("POST /api/media/gc — the request cannot choose anything", () => {
  it.each([
    ["keys in the body", { keys: ["community/x/w480.webp"] }],
    ["asset ids in the body", { assetIds: ["0b2ad7a0-1c0e-4a8d-9a11-0c4f59f0a001"] }],
    ["a bucket in the body", { bucket: "upmina-media-dev-public" }],
    ["a limit in the body", { limit: 100000 }],
    ["an array", []],
    ["a non-empty string", '{"keys":[]}'],
  ])("authenticated but with %s → 400, no work", async (_name, body) => {
    const r = await call({ headers: await signed(), body });
    expect(r.status).toBe(400);
    expect(runMediaGcBatch).not.toHaveBeenCalled();
  });
  it("extra query parameters → 400 (only the route resource is allowed)", async () => {
    for (const query of [
      { resource: "gc", limit: "100" },
      { resource: "gc", bucket: "x" },
      { resource: "gc", key: "community/x/w480.webp" },
    ]) {
      expect((await call({ headers: await signed(), query })).status).toBe(400);
    }
    expect(runMediaGcBatch).not.toHaveBeenCalled();
  });
  it("an absent, null, empty-string or key-less object body is the only accepted shape", async () => {
    // Vercel delivers `{}` for Content-Type: application/json with no body (observed on Testing)
    for (const body of [undefined, null, "", {}])
      expect((await call({ headers: await signed(), body })).status).toBe(200);
  });
});

describe("POST /api/media/gc — failures and replay", () => {
  it("an unavailable engine or an unexpected error is a generic 500 with no detail", async () => {
    runMediaGcBatch.mockRejectedValueOnce(new GcUnavailableError());
    const a = await call({ headers: await signed() });
    runMediaGcBatch.mockRejectedValueOnce(new Error("secret key community/abc leaked"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const b = await call({ headers: await signed() });
    spy.mockRestore();
    for (const r of [a, b]) {
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.body)).not.toMatch(/secret|community|abc|key/i);
    }
  });
  it("replay inside the ±30 s window only re-runs the same idempotent DB-decided batch", async () => {
    const headers = await signed();
    expect((await call({ headers })).status).toBe(200);
    expect((await call({ headers })).status).toBe(200);
    expect(runMediaGcBatch.mock.calls.every((c) => c.length === 0)).toBe(true);
  });
});
