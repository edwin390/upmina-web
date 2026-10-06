// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// R4-E2: el DELETE propio converge con el GC físico. Se ejecutan los handlers REALES
// (requireAuthenticated, handleCommunityPostDelete, attemptMediaAssetCleanup y la primitiva de
// borrado de media-gc); solo la BD y R2 son falsos en memoria.

const USER_ID = "33333333-3333-4333-8333-333333333333";
const POST_ID = "24655b41-1bc7-487c-834e-d1715a596e9e";
const IMG = "0d000000-0000-4000-8000-000000000001";
const VIDEO = "0d000000-0000-4000-8000-000000000002";

const fake = vi.hoisted(() => ({
  assets: new Map<string, Record<string, unknown>>(),
  variants: new Map<string, { storage_key: string }[]>(),
  deletedAssets: [] as string[],
  rpcCalls: [] as string[],
  rpcAssetIds: [] as string[],
}));
const deletePublicVariants = vi.hoisted(() => vi.fn());
const deletePrivateObject = vi.hoisted(() => vi.fn());
vi.mock("./r2-client.js", () => ({
  deletePublicVariants: (...a: unknown[]) => deletePublicVariants(...a),
  deletePrivateObject: (...a: unknown[]) => deletePrivateObject(...a),
  publicVariantUrl: (k: string) => `https://legacy.synthetic.example/${k}`,
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      async getClaims(jwt: string) {
        return jwt === "jwt-owner"
          ? { data: { claims: { sub: USER_ID, aal: "aal1" } }, error: null }
          : { data: null, error: { message: "jwt inválido" } };
      },
    },
    async rpc(name: string) {
      fake.rpcCalls.push(name);
      if (name === "community_post_delete")
        return { data: { deleted_asset_ids: fake.rpcAssetIds }, error: null };
      return { data: null, error: { message: "rpc inesperada" } };
    },
    from(table: string) {
      if (table === "media_assets") {
        return {
          select: () => {
            const f: Record<string, unknown> = {};
            const b = {
              eq: (c: string, v: unknown) => ((f[c] = v), b),
              async maybeSingle() {
                return { data: fake.assets.get(f.id as string) ?? null, error: null };
              },
            };
            return b;
          },
          delete: () => {
            const f: Record<string, unknown> = {};
            const b = {
              eq: (c: string, v: unknown) => ((f[c] = v), b),
              then(resolve: (v: unknown) => unknown) {
                const row = fake.assets.get(f.id as string);
                if (row && (!f.status || row.status === f.status)) {
                  fake.assets.delete(f.id as string);
                  fake.deletedAssets.push(f.id as string);
                }
                return Promise.resolve({ error: null }).then(resolve);
              },
            };
            return b;
          },
        };
      }
      if (table === "media_asset_variants") {
        return {
          select: () => {
            const f: Record<string, unknown> = {};
            const b = {
              eq: (c: string, v: unknown) => ((f[c] = v), b),
              then(resolve: (v: unknown) => unknown) {
                return Promise.resolve({
                  data: fake.variants.get(f.asset_id as string) ?? [],
                  error: null,
                }).then(resolve);
              },
            };
            return b;
          },
        };
      }
      throw new Error(`tabla inesperada: ${table}`);
    },
  }),
}));

const { handleCommunityPostDelete } = await import("./community-post-handlers");

async function deletePost() {
  let status = 0;
  let body: unknown;
  const res = {
    setHeader: () => res,
    status: (c: number) => ((status = c), res),
    json: (b: unknown) => ((body = b), res),
  };
  await handleCommunityPostDelete(
    {
      method: "POST",
      headers: { authorization: "Bearer jwt-owner" },
      body: { postId: POST_ID, expectedVersion: 2 },
      query: {},
    } as unknown as VercelRequest,
    res as unknown as VercelResponse,
  );
  return {
    status,
    body: body as {
      postId: string;
      allCleaned: boolean;
      deletedAssets: { cleaned: boolean }[];
    },
  };
}
function imageAsset(extra: Record<string, unknown> = {}) {
  fake.assets.set(IMG, {
    id: IMG,
    status: "deleting",
    domain: "community",
    storage_key: `community/${IMG}/w960.webp`,
    private_original_key: null,
    ...extra,
  });
  fake.variants.set(IMG, [
    { storage_key: `community/${IMG}/w480.webp` },
    { storage_key: `community/${IMG}/w960.webp` },
  ]);
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://fixture.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-role");
  fake.assets.clear();
  fake.variants.clear();
  fake.deletedAssets = [];
  fake.rpcCalls = [];
  fake.rpcAssetIds = [];
  deletePublicVariants.mockReset().mockResolvedValue(undefined);
  deletePrivateObject.mockReset().mockResolvedValue(undefined);
});

describe("owner DELETE → physical cleanup (R4-E2)", () => {
  it("success: the post is deleted, the objects are removed and the asset row is finalized", async () => {
    imageAsset();
    fake.rpcAssetIds = [IMG];
    const r = await deletePost();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ postId: POST_ID, allCleaned: true });
    expect(deletePublicVariants).toHaveBeenCalledWith([
      `community/${IMG}/w480.webp`,
      `community/${IMG}/w960.webp`,
    ]);
    expect(fake.deletedAssets).toEqual([IMG]);
  });
  it("PARTIAL R2 failure: the post stays deleted, the asset stays 'deleting', no false finalize", async () => {
    imageAsset();
    fake.rpcAssetIds = [IMG];
    deletePublicVariants.mockRejectedValue(
      Object.assign(new Error("partial"), { name: "R2PartialDeleteError" }),
    );
    const r = await deletePost();
    expect(r.status).toBe(200); // the logical delete already happened
    expect(r.body.allCleaned).toBe(false);
    expect(fake.rpcCalls).toEqual(["community_post_delete"]); // never restored or retried in-DB
    expect(fake.assets.get(IMG)?.status).toBe("deleting");
    expect(fake.deletedAssets).toEqual([]);
    expect(JSON.stringify(r.body)).not.toMatch(/community\/|w960|w480/);
  });
  it("private original failure also keeps the asset for the GC", async () => {
    imageAsset({ private_original_key: `objects/community/${IMG}/original.png` });
    fake.rpcAssetIds = [IMG];
    deletePrivateObject.mockRejectedValue(new Error("network"));
    const r = await deletePost();
    expect(r.body.allCleaned).toBe(false);
    expect(fake.assets.has(IMG)).toBe(true);
  });
  it("VIDEO: the public storage_key object (no variants) is deleted", async () => {
    fake.assets.set(VIDEO, {
      id: VIDEO,
      status: "deleting",
      domain: "community",
      storage_key: `community/${VIDEO}/original.mp4`,
      private_original_key: null,
    });
    fake.rpcAssetIds = [VIDEO];
    const r = await deletePost();
    expect(r.body.allCleaned).toBe(true);
    expect(deletePublicVariants).toHaveBeenCalledWith([
      `community/${VIDEO}/original.mp4`,
    ]);
    expect(fake.deletedAssets).toEqual([VIDEO]);
  });
  it("a key that does not belong to the asset is never deleted and keeps the row", async () => {
    imageAsset({ storage_key: `community/${VIDEO}/w960.webp` });
    fake.rpcAssetIds = [IMG];
    const r = await deletePost();
    expect(r.body.allCleaned).toBe(false);
    expect(deletePublicVariants).not.toHaveBeenCalled();
    expect(fake.assets.has(IMG)).toBe(true);
  });
  it("a repeated cleanup after a failure completes it (idempotent R2 deletes)", async () => {
    imageAsset();
    fake.rpcAssetIds = [IMG];
    deletePublicVariants
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue(undefined);
    expect((await deletePost()).body.allCleaned).toBe(false);
    expect((await deletePost()).body.allCleaned).toBe(true);
    expect(fake.deletedAssets).toEqual([IMG]);
  });
});
