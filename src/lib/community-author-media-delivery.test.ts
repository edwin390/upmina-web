// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// R4-D2: entrega de medios en la proyección privada del propio autor (R4-C). Se ejercita el handler
// REAL con requireAuthenticated REAL; el cliente de Supabase es un falso en memoria. Las garantías
// SQL (estado y expiración) ya las cubre community-media-delivery-state.test.ts y
// community-author-access.test.ts; aquí se fija qué URL/capability produce el handler por estado.

const USER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_USER_ID = "44444444-4444-4444-8444-444444444444";
const POST_ID = "24655b41-1bc7-487c-834e-d1715a596e9e";
const ASSET_ID = "0b2ad7a0-1c0e-4a8d-9a11-0c4f59f0a001";
const MEDIA_ID = "b94ec8fc-5fd3-4cdd-a961-e9dfea366b4e";
const BASE = "https://media.synthetic.example";
const SERVER_NOW = () => new Date().toISOString();

const fake = vi.hoisted(() => ({
  rpcResult: undefined as { data: unknown; error: unknown } | undefined,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  assets: [] as Record<string, unknown>[],
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      async getClaims(jwt: string) {
        const sub =
          jwt === "jwt-owner" ? USER_ID : jwt === "jwt-other" ? OTHER_USER_ID : null;
        return sub
          ? { data: { claims: { sub, aal: "aal1" } }, error: null }
          : { data: null, error: { message: "jwt inválido" } };
      },
    },
    from(table: string) {
      if (table !== "media_assets") throw new Error(`tabla inesperada: ${table}`);
      return {
        select: () => ({
          in: async (_c: string, ids: string[]) => ({
            data: fake.assets.filter((a) => ids.includes(a.id as string)),
            error: null,
          }),
        }),
      };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      fake.rpcCalls.push({ name, args });
      return fake.rpcResult ?? { data: null, error: { message: "sin resultado" } };
    },
  }),
}));
vi.mock("./r2-client.js", () => ({
  publicVariantUrl: (key: string) => `https://legacy.synthetic.example/${key}`,
}));

const SIGNING_PKCS8 = Buffer.from(
  await crypto.subtle.exportKey(
    "pkcs8",
    (
      (await crypto.subtle.generateKey("Ed25519", true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair
    ).privateKey,
  ),
).toString("base64");

const { handleCommunityAuthorPosts } = await import("./community-author-handlers");

function secure() {
  vi.stubEnv("MEDIA_DELIVERY_BASE_URL", BASE);
  vi.stubEnv("MEDIA_CAP_SIGNING_PRIVATE_KEY", SIGNING_PKCS8);
  vi.stubEnv("MEDIA_CAP_KEY_ID", "k1");
  vi.stubEnv("MEDIA_CAP_AUDIENCE", "upmina-media-synthetic");
}
function legacy() {
  for (const name of [
    "MEDIA_DELIVERY_BASE_URL",
    "MEDIA_CAP_SIGNING_PRIVATE_KEY",
    "MEDIA_CAP_KEY_ID",
    "MEDIA_CAP_AUDIENCE",
  ])
    vi.stubEnv(name, "");
}

function listItem(status: string, deadline: string | null = null) {
  return {
    id: POST_ID,
    text: "x",
    status,
    version: 2,
    createdAt: "2026-10-04T17:00:00Z",
    updatedAt: "2026-10-04T17:00:00Z",
    likeCount: 0,
    resolvedNoticeUnseen: false,
    author: { username: "author_test", displayName: null },
    moderation: {
      kind:
        status === "hidden_pending_review"
          ? "paused"
          : status === "removed_pending_purge"
            ? "withdrawn"
            : "none",
      deadline,
      message: status === "removed_pending_purge" ? "mensaje" : null,
    },
    media: [{ id: MEDIA_ID, assetId: ASSET_ID, position: 0 }],
  };
}
async function read(status: string, deadline: string | null = null, token = "jwt-owner") {
  fake.rpcResult = {
    data: {
      items: [listItem(status, deadline)],
      serverNow: SERVER_NOW(),
      noticeId: null,
    },
    error: null,
  };
  let body: unknown;
  let code = 0;
  const res = {
    setHeader: () => res,
    status: (c: number) => ((code = c), res),
    json: (b: unknown) => ((body = b), res),
  };
  await handleCommunityAuthorPosts(
    {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      query: {},
    } as unknown as VercelRequest,
    res as unknown as VercelResponse,
  );
  return { status: code, body: body as { items: { media: { url: string | null }[] }[] } };
}
const urlOf = (r: Awaited<ReturnType<typeof read>>) => r.body.items[0].media[0].url;
const payloadOf = (url: string) =>
  JSON.parse(
    Buffer.from(
      new URL(url).searchParams.get("cap")!.split(".")[1],
      "base64url",
    ).toString(),
  );

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://fixture.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-role");
  legacy();
  fake.rpcCalls = [];
  fake.assets = [
    {
      id: ASSET_ID,
      domain: "community",
      status: "ready",
      kind: "image",
      storage_key: `community/${ASSET_ID}/w960.webp`,
      width: 960,
      height: 720,
      duration_seconds: null,
    },
  ];
});

describe("owner media delivery by post state (secure delivery configured)", () => {
  beforeEach(secure);
  it("published → public delivery URL, never a capability", async () => {
    const r = await read("published");
    expect(urlOf(r)).toBe(`${BASE}/community/${ASSET_ID}/w960.webp`);
  });
  it("hidden_pending_review → owner capability bound to the asset, ≤10 min", async () => {
    const url = urlOf(await read("hidden_pending_review"))!;
    expect(url.startsWith(`${BASE}/community/${ASSET_ID}/w960.webp?cap=`)).toBe(true);
    const payload = payloadOf(url);
    expect(payload).toMatchObject({
      a: ASSET_ID,
      s: "owner",
      u: "upmina-media-synthetic",
      k: "k1",
    });
    expect(payload.e - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600);
    expect(JSON.stringify(payload)).not.toMatch(/storage|w960|author|email/);
  });
  it("removed_pending_purge before expiry → owner capability capped at purge_after − margin", async () => {
    const deadline = new Date(Date.now() + 90_000);
    const url = urlOf(await read("removed_pending_purge", deadline.toISOString()))!;
    expect(payloadOf(url)).toMatchObject({ s: "owner" });
    expect(payloadOf(url).e).toBe(Math.floor(deadline.getTime() / 1000) - 5);
  });
  it("a deadline far in the future never extends the default 10 min", async () => {
    const url = urlOf(
      await read(
        "removed_pending_purge",
        new Date(Date.now() + 72 * 3600_000).toISOString(),
      ),
    )!;
    expect(payloadOf(url).e - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600);
  });
  it("removed_pending_purge inside the 5 s safety margin → no URL, no capability", async () => {
    const r = await read(
      "removed_pending_purge",
      new Date(Date.now() + 3000).toISOString(),
    );
    expect(r.status).toBe(200);
    expect(urlOf(r)).toBeNull();
  });
  it("manual hidden → no capability and no URL (R4-C access not widened)", async () => {
    expect(urlOf(await read("hidden"))).toBeNull();
  });
  it("a non-ready asset never gets a URL", async () => {
    fake.assets[0].status = "processing";
    fake.assets[0].storage_key = null;
    fake.assets[0].width = null;
    fake.assets[0].height = null;
    expect(urlOf(await read("hidden_pending_review"))).toBeNull();
  });
  it("a storage key that does not belong to the referenced asset yields no capability", async () => {
    fake.assets[0].storage_key =
      "community/0b2ad7a0-1c0e-4a8d-9a11-0c4f59f0a999/w960.webp";
    expect(urlOf(await read("hidden_pending_review"))).toBeNull();
  });
  it("the actor always comes from the verified JWT, never from the request", async () => {
    await read("hidden_pending_review", null, "jwt-other");
    expect(fake.rpcCalls[0].args.p_actor_user_id).toBe(OTHER_USER_ID);
  });
  it("a misconfigured base fails closed with a generic error", async () => {
    vi.stubEnv("MEDIA_DELIVERY_BASE_URL", "http://insecure.synthetic.example");
    const r = await read("published");
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/insecure|MEDIA_/);
  });
  it("secure base without a signing key: public stays public, private states fail closed (no URL)", async () => {
    vi.stubEnv("MEDIA_CAP_SIGNING_PRIVATE_KEY", "");
    expect(urlOf(await read("published"))).toBe(
      `${BASE}/community/${ASSET_ID}/w960.webp`,
    );
    expect(urlOf(await read("hidden_pending_review"))).toBeNull();
  });
  it("never leaks the capability or key material through the response envelope", async () => {
    const r = await read("hidden_pending_review");
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/storage_key|signing|private|PKCS|k1/i);
  });
});

describe("owner media delivery in legacy mode (before the Worker cutover)", () => {
  it("published keeps the legacy public URL", async () => {
    expect(urlOf(await read("published"))).toBe(
      `https://legacy.synthetic.example/community/${ASSET_ID}/w960.webp`,
    );
  });
  it("private states get NO url — a public URL is never passed off as private", async () => {
    expect(urlOf(await read("hidden_pending_review"))).toBeNull();
    expect(
      urlOf(
        await read("removed_pending_purge", new Date(Date.now() + 60_000).toISOString()),
      ),
    ).toBeNull();
  });
  it("manual hidden keeps its existing legacy URL (behavior unchanged until cutover)", async () => {
    expect(urlOf(await read("hidden"))).toBe(
      `https://legacy.synthetic.example/community/${ASSET_ID}/w960.webp`,
    );
  });
});
