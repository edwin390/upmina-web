// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  GC_BATCH_LIMIT,
  GC_LEASE_SECONDS,
  GcUnavailableError,
  deleteMediaAssetObjects,
  deriveAssetObjects,
  isOwnedPrivateKey,
  isOwnedPublicKey,
  runMediaGcBatch,
  type GcDb,
  type PhysicalDeleteIo,
} from "./media-gc";

// R4-E2: primitiva física + motor de lote. R2 y la BD son falsos en memoria: ningún test llama a
// infraestructura real. La política de claves es un espejo de community_asset_gc_objects (E1).

const ID = (n: number) => `0b000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TOK = (n: number) => `0c000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FOREIGN = ID(999);

function fakeIo(
  options: {
    publicError?: () => Error | null;
    privateError?: (key: string) => Error | null;
  } = {},
) {
  const log: string[] = [];
  const io: PhysicalDeleteIo = {
    async deletePublic(keys) {
      log.push(`public:${keys.join(",")}`);
      const error = options.publicError?.();
      if (error) throw error;
    },
    async deletePrivate(key) {
      log.push(`private:${key}`);
      const error = options.privateError?.(key);
      if (error) throw error;
    },
  };
  return { io, log };
}
const partial = () =>
  Object.assign(new Error("partial"), { name: "R2PartialDeleteError" });

describe("key ownership (mirror of the DB contract)", () => {
  it("accepts only keys bound to the asset and domain", () => {
    expect(isOwnedPublicKey("community", ID(1), `community/${ID(1)}/w960.webp`)).toBe(
      true,
    );
    expect(isOwnedPublicKey("community", ID(1), `community/${ID(1)}/original.mp4`)).toBe(
      true,
    );
    expect(isOwnedPublicKey("cosplay", ID(1), `cosplay/${ID(1)}/w480.webp`)).toBe(true);
    for (const [domain, key] of [
      ["community", `community/${FOREIGN}/w960.webp`],
      ["community", `cosplay/${ID(1)}/w960.webp`],
      ["cosplay", `community/${ID(1)}/w960.webp`],
      ["cosplay", `cosplay/${ID(1)}/original.mp4`],
      ["community", `community/${ID(1)}/../x.webp`],
      ["community", `community/${ID(1)}/w123.webp`],
      ["community", `community/${ID(1)}/w480.webp?x=1`],
      ["community", `/community/${ID(1)}/w480.webp`],
      ["community", `community/${ID(1)}/w480.webp/`],
      ["other", `other/${ID(1)}/w480.webp`],
      ["community", ""],
    ] as const)
      expect(isOwnedPublicKey(domain, ID(1), key)).toBe(false);
    expect(
      isOwnedPublicKey("community", "not-a-uuid", "community/not-a-uuid/w480.webp"),
    ).toBe(false);
  });
  it("private originals live under staging|objects/<domain>/<asset>/original.<ext>", () => {
    expect(
      isOwnedPrivateKey("community", ID(1), `staging/community/${ID(1)}/original.png`),
    ).toBe(true);
    expect(
      isOwnedPrivateKey("community", ID(1), `objects/community/${ID(1)}/original.mp4`),
    ).toBe(true);
    for (const key of [
      `objects/community/${FOREIGN}/original.png`,
      `objects/cosplay/${ID(1)}/original.png`,
      `other/community/${ID(1)}/original.png`,
      `objects/community/${ID(1)}/original.exe`,
      `objects/community/${ID(1)}/../original.png`,
      `community/${ID(1)}/original.png`,
    ])
      expect(isOwnedPrivateKey("community", ID(1), key)).toBe(false);
  });
});

describe("deriveAssetObjects", () => {
  it("IMAGE: variants (+ primary storage_key) and a residual private original", () => {
    const { objects, rejected } = deriveAssetObjects(
      {
        id: ID(1),
        domain: "community",
        storage_key: `community/${ID(1)}/w960.webp`,
        private_original_key: `staging/community/${ID(1)}/original.png`,
      },
      [`community/${ID(1)}/w480.webp`, `community/${ID(1)}/w960.webp`],
    );
    expect(rejected).toBe(0);
    expect(objects.publicKeys).toEqual([
      `community/${ID(1)}/w480.webp`,
      `community/${ID(1)}/w960.webp`,
    ]);
    expect(objects.privateKeys).toEqual([`staging/community/${ID(1)}/original.png`]);
  });
  it("VIDEO: the single public object is storage_key, with zero variants", () => {
    const { objects, rejected } = deriveAssetObjects(
      {
        id: ID(2),
        domain: "community",
        storage_key: `community/${ID(2)}/original.mp4`,
        private_original_key: null,
      },
      [],
    );
    expect(rejected).toBe(0);
    expect(objects.publicKeys).toEqual([`community/${ID(2)}/original.mp4`]);
    expect(objects.privateKeys).toEqual([]);
  });
  it("foreign or malformed keys are counted and never returned", () => {
    const { objects, rejected } = deriveAssetObjects(
      {
        id: ID(3),
        domain: "community",
        storage_key: `community/${FOREIGN}/w960.webp`,
        private_original_key: `objects/community/${FOREIGN}/original.png`,
      },
      [`community/${ID(3)}/../x.webp`, `cosplay/${ID(3)}/w480.webp`],
    );
    expect(objects.publicKeys).toEqual([]);
    expect(objects.privateKeys).toEqual([]);
    expect(rejected).toBe(4);
  });
});

describe("deleteMediaAssetObjects", () => {
  const image = {
    assetId: ID(1),
    domain: "community",
    publicKeys: [`community/${ID(1)}/w480.webp`, `community/${ID(1)}/w960.webp`],
    privateKeys: [`staging/community/${ID(1)}/original.png`],
  };
  it("IMAGE: deletes variants and the private residual", async () => {
    const { io, log } = fakeIo();
    expect(await deleteMediaAssetObjects(image, io)).toEqual({ ok: true });
    expect(log).toEqual([
      `public:${image.publicKeys.join(",")}`,
      `private:${image.privateKeys[0]}`,
    ]);
  });
  it("already absent objects are idempotent success (the io layer reports no error)", async () => {
    const { io } = fakeIo();
    expect(await deleteMediaAssetObjects(image, io)).toEqual({ ok: true });
    expect(await deleteMediaAssetObjects(image, io)).toEqual({ ok: true });
  });
  it("IMAGE: partial DeleteObjects errors, network failures and private failures all fail", async () => {
    expect(
      await deleteMediaAssetObjects(image, fakeIo({ publicError: partial }).io),
    ).toEqual({ ok: false, errorClass: "r2_partial_delete" });
    expect(
      await deleteMediaAssetObjects(
        image,
        fakeIo({ publicError: () => new Error("net") }).io,
      ),
    ).toEqual({ ok: false, errorClass: "r2_public_delete_failed" });
    expect(
      await deleteMediaAssetObjects(
        image,
        fakeIo({ privateError: () => new Error("net") }).io,
      ),
    ).toEqual({ ok: false, errorClass: "r2_private_delete_failed" });
  });
  it("a public failure still attempts the private residual (progress), but never reports ok", async () => {
    const { io, log } = fakeIo({ publicError: partial });
    const result = await deleteMediaAssetObjects(image, io);
    expect(result.ok).toBe(false);
    expect(log.some((l) => l.startsWith("private:"))).toBe(true);
  });
  it("VIDEO: deletes storage_key without any variants; residual private; partial/network failures", async () => {
    const video = {
      assetId: ID(2),
      domain: "community",
      publicKeys: [`community/${ID(2)}/original.mp4`],
      privateKeys: [`objects/community/${ID(2)}/original.mp4`],
    };
    const ok = fakeIo();
    expect(await deleteMediaAssetObjects(video, ok.io)).toEqual({ ok: true });
    expect(ok.log).toEqual([
      `public:${video.publicKeys[0]}`,
      `private:${video.privateKeys[0]}`,
    ]);
    expect(
      await deleteMediaAssetObjects(video, fakeIo({ publicError: partial }).io),
    ).toEqual({ ok: false, errorClass: "r2_partial_delete" });
    expect(
      await deleteMediaAssetObjects(
        video,
        fakeIo({ publicError: () => new Error("x") }).io,
      ),
    ).toEqual({ ok: false, errorClass: "r2_public_delete_failed" });
  });
  it("COSPLAY: valid domain deletes; a partial delete does not succeed", async () => {
    const cosplay = {
      assetId: ID(3),
      domain: "cosplay",
      publicKeys: [`cosplay/${ID(3)}/w480.webp`],
      privateKeys: [],
    };
    expect(await deleteMediaAssetObjects(cosplay, fakeIo().io)).toEqual({ ok: true });
    expect(
      await deleteMediaAssetObjects(cosplay, fakeIo({ publicError: partial }).io),
    ).toEqual({ ok: false, errorClass: "r2_partial_delete" });
  });
  it("SECURITY: one invalid key rejects the whole asset BEFORE any physical deletion", async () => {
    for (const bad of [
      { ...image, publicKeys: [...image.publicKeys, `community/${FOREIGN}/w480.webp`] },
      { ...image, publicKeys: [`community/${ID(1)}/../${FOREIGN}/w480.webp`] },
      { ...image, domain: "cosplay" },
      { ...image, privateKeys: [`objects/community/${FOREIGN}/original.png`] },
      { ...image, domain: "other" },
    ]) {
      const { io, log } = fakeIo();
      expect(await deleteMediaAssetObjects(bad, io)).toEqual({
        ok: false,
        errorClass: "invalid_object_reference",
      });
      expect(log).toEqual([]);
    }
  });
  it("an asset without objects is trivially successful", async () => {
    const { io, log } = fakeIo();
    expect(
      await deleteMediaAssetObjects(
        { assetId: ID(4), domain: "community", publicKeys: [], privateKeys: [] },
        io,
      ),
    ).toEqual({ ok: true });
    expect(log).toEqual([]);
  });
});

// ── Motor de lote con BD simulada que respeta el contrato de E1

interface FakeAsset {
  n: number;
  domain?: string;
  objects?: Record<string, unknown> | { valid: false };
  objectsError?: boolean;
  objectsThrow?: boolean;
  finalize?: string | "error" | "throw";
}
function fakeDb(
  assets: FakeAsset[],
  options: { claimError?: boolean; failError?: boolean; failResult?: string } = {},
) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const order: string[] = [];
  const finalizeAttempts = new Map<number, number>();
  const byId = new Map(assets.map((a) => [ID(a.n), a]));
  const db: GcDb = {
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === "community_asset_gc_claim") {
        if (options.claimError) return { data: null, error: { message: "boom" } };
        return {
          data: {
            claimed: assets.slice(0, Number(args.p_limit) + 10).map((a) => ({
              assetId: ID(a.n),
              domain: a.domain ?? "community",
              kind: "image",
              claimToken: TOK(a.n),
              attempts: 0,
            })),
          },
          error: null,
        };
      }
      const asset = byId.get(String(args.p_asset_id))!;
      if (name === "community_asset_gc_objects") {
        if (asset.objectsThrow) throw new Error("network");
        if (asset.objectsError) return { data: null, error: { message: "boom" } };
        return {
          data: asset.objects ?? {
            valid: true,
            assetId: ID(asset.n),
            domain: asset.domain ?? "community",
            kind: "image",
            publicKeys: [`${asset.domain ?? "community"}/${ID(asset.n)}/w960.webp`],
            privateKeys: [],
            rejectedKeys: 0,
          },
          error: null,
        };
      }
      if (name === "community_asset_gc_finalize") {
        order.push(`finalize:${asset.n}`);
        const attempts = (finalizeAttempts.get(asset.n) ?? 0) + 1;
        finalizeAttempts.set(asset.n, attempts);
        if (asset.finalize === "throw") throw new Error("network");
        if (asset.finalize === "error" && attempts === 1)
          return { data: null, error: { message: "boom" } };
        return {
          data: {
            result:
              asset.finalize && asset.finalize !== "error" ? asset.finalize : "deleted",
          },
          error: null,
        };
      }
      if (name === "community_asset_gc_fail") {
        if (options.failError) return { data: null, error: { message: "boom" } };
        return { data: { result: options.failResult ?? "retry_scheduled" }, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  };
  return {
    db,
    calls,
    order,
    failCalls: () => calls.filter((c) => c.name === "community_asset_gc_fail"),
  };
}
const run = (db: GcDb, io: PhysicalDeleteIo) =>
  runMediaGcBatch({ db, io, log: () => undefined });

describe("runMediaGcBatch", () => {
  it("claims with the fixed limit/lease and sends NO keys, buckets or asset ids from the caller", async () => {
    const { db, calls } = fakeDb([]);
    const summary = await run(db, fakeIo().io);
    expect(summary).toMatchObject({ claimed: 0, finalized: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      name: "community_asset_gc_claim",
      args: { p_limit: GC_BATCH_LIMIT, p_lease_seconds: GC_LEASE_SECONDS },
    });
    expect(GC_BATCH_LIMIT).toBe(20);
  });
  it("one asset: deletes THEN finalizes (finalize is always the last step)", async () => {
    const { db, order } = fakeDb([{ n: 1 }]);
    const { io, log } = fakeIo();
    const shared: string[] = [];
    const tracked: PhysicalDeleteIo = {
      deletePublic: async (k) => {
        shared.push("delete");
        await io.deletePublic(k);
      },
      deletePrivate: io.deletePrivate,
    };
    const summary = await run(db, tracked);
    expect(summary).toMatchObject({ claimed: 1, finalized: 1, failed: 0 });
    expect(shared).toEqual(["delete"]);
    expect(order).toEqual(["finalize:1"]);
    expect(log).toHaveLength(1);
  });
  it("multiple assets all succeed", async () => {
    const { db } = fakeDb([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(await run(db, fakeIo().io)).toMatchObject({ claimed: 3, finalized: 3 });
  });
  it("one failing asset never stops the others; its failure class is bounded", async () => {
    const { db, failCalls, order } = fakeDb([{ n: 1 }, { n: 2 }]);
    let first = true;
    const { io } = fakeIo({
      publicError: () => {
        if (first) {
          first = false;
          return new Error("provider body <xml>");
        }
        return null;
      },
    });
    const summary = await run(db, io);
    expect(summary).toMatchObject({
      claimed: 2,
      finalized: 1,
      failed: 1,
      errorClasses: { r2_public_delete_failed: 1 },
    });
    expect(order).toEqual(["finalize:2"]);
    expect(failCalls()).toHaveLength(1);
    expect(failCalls()[0].args).toEqual({
      p_asset_id: ID(1),
      p_claim_token: TOK(1),
      p_error_class: "r2_public_delete_failed",
    });
    expect(JSON.stringify(failCalls())).not.toMatch(/xml|provider|community\//);
  });
  it("rejectedKeys > 0 → fail(invalid_object_reference) and ZERO physical deletes for that asset", async () => {
    const { db, order, failCalls } = fakeDb([
      {
        n: 1,
        objects: {
          valid: true,
          assetId: ID(1),
          domain: "community",
          kind: "image",
          publicKeys: [`community/${ID(1)}/w480.webp`],
          privateKeys: [],
          rejectedKeys: 1,
        },
      },
    ]);
    const { io, log } = fakeIo();
    const summary = await run(db, io);
    expect(summary.errorClasses).toEqual({ invalid_object_reference: 1 });
    expect(log).toEqual([]);
    expect(order).toEqual([]);
    expect(failCalls()[0].args.p_error_class).toBe("invalid_object_reference");
  });
  it("objects that do not match the claimed asset/domain are rejected without deleting", async () => {
    const { db } = fakeDb([
      {
        n: 1,
        objects: {
          valid: true,
          assetId: FOREIGN,
          domain: "community",
          publicKeys: [],
          privateKeys: [],
          rejectedKeys: 0,
        },
      },
      {
        n: 2,
        objects: {
          valid: true,
          assetId: ID(2),
          domain: "cosplay",
          publicKeys: [],
          privateKeys: [],
          rejectedKeys: 0,
        },
      },
      {
        n: 3,
        objects: {
          valid: true,
          assetId: ID(3),
          domain: "community",
          publicKeys: "nope",
          privateKeys: [],
          rejectedKeys: 0,
        },
      },
      // a key the DB returned that does not belong to the asset: the primitive re-checks it
      {
        n: 4,
        objects: {
          valid: true,
          assetId: ID(4),
          domain: "community",
          publicKeys: [`community/${FOREIGN}/w480.webp`],
          privateKeys: [],
          rejectedKeys: 0,
        },
      },
    ]);
    const { io, log } = fakeIo();
    const summary = await run(db, io);
    expect(summary.errorClasses).toEqual({ invalid_object_reference: 4 });
    expect(log).toEqual([]);
  });
  it("partial R2 delete → fail(r2_partial_delete), never finalized", async () => {
    const { db, order } = fakeDb([{ n: 1 }]);
    const summary = await run(db, fakeIo({ publicError: partial }).io);
    expect(summary.errorClasses).toEqual({ r2_partial_delete: 1 });
    expect(order).toEqual([]);
  });
  it("private original failure → fail(r2_private_delete_failed), never finalized", async () => {
    const { db, order } = fakeDb([
      {
        n: 1,
        objects: {
          valid: true,
          assetId: ID(1),
          domain: "community",
          kind: "image",
          publicKeys: [],
          privateKeys: [`objects/community/${ID(1)}/original.png`],
          rejectedKeys: 0,
        },
      },
    ]);
    const summary = await run(db, fakeIo({ privateError: () => new Error("x") }).io);
    expect(summary.errorClasses).toEqual({ r2_private_delete_failed: 1 });
    expect(order).toEqual([]);
  });
  it("finalize failure after a successful R2 delete → fail(gc_finalize_failed); the next run re-deletes idempotently and finalizes", async () => {
    const { db, order, failCalls } = fakeDb([{ n: 1, finalize: "error" }]);
    const { io, log } = fakeIo();
    const first = await run(db, io);
    expect(first.errorClasses).toEqual({ gc_finalize_failed: 1 });
    expect(failCalls()[0].args.p_error_class).toBe("gc_finalize_failed");
    const second = await run(db, io);
    expect(second).toMatchObject({ finalized: 1, failed: 0 });
    expect(order).toEqual(["finalize:1", "finalize:1"]);
    expect(log).toHaveLength(2); // the second delete is the idempotent repeat
  });
  it("a finalize that throws is also recorded as gc_finalize_failed", async () => {
    const { db } = fakeDb([{ n: 1, finalize: "throw" }]);
    expect((await run(db, fakeIo().io)).errorClasses).toEqual({ gc_finalize_failed: 1 });
  });
  it("if recording the failure ALSO fails, nothing else is mutated: the lease will expire", async () => {
    const { db, calls } = fakeDb([{ n: 1 }], { failError: true });
    const summary = await run(db, fakeIo({ publicError: () => new Error("x") }).io);
    expect(summary).toMatchObject({ failed: 1, failRecordFailed: 1 });
    expect(new Set(calls.map((c) => c.name))).toEqual(
      new Set([
        "community_asset_gc_claim",
        "community_asset_gc_objects",
        "community_asset_gc_fail",
      ]),
    );
  });
  it("stale or invalid claim: objects lookup says valid:false → no deletes, no fail, no finalize", async () => {
    const { db, calls } = fakeDb([{ n: 1, objects: { valid: false } }]);
    const { io, log } = fakeIo();
    const summary = await run(db, io);
    expect(summary).toMatchObject({ stale: 1, failed: 0, finalized: 0 });
    expect(log).toEqual([]);
    expect(calls.map((c) => c.name)).toEqual([
      "community_asset_gc_claim",
      "community_asset_gc_objects",
    ]);
  });
  it("finalize results: already_gone, invalid_claim and blocked are counted, not retried as failures", async () => {
    const { db, failCalls } = fakeDb([
      { n: 1, finalize: "already_gone" },
      { n: 2, finalize: "invalid_claim" },
      { n: 3, finalize: "blocked" },
    ]);
    const summary = await run(db, fakeIo().io);
    expect(summary).toMatchObject({ alreadyGone: 1, stale: 1, blocked: 1, failed: 0 });
    expect(failCalls()).toHaveLength(0);
  });
  it("objects lookup failure (error or thrown) → fail(gc_objects_failed) and the batch continues", async () => {
    const { db, order } = fakeDb([
      { n: 1, objectsError: true },
      { n: 2, objectsThrow: true },
      { n: 3 },
    ]);
    const summary = await run(db, fakeIo().io);
    expect(summary).toMatchObject({
      claimed: 3,
      finalized: 1,
      failed: 2,
      errorClasses: { gc_objects_failed: 2 },
    });
    expect(order).toEqual(["finalize:3"]);
  });
  it("never processes more than 20 assets per run, even if the DB returned more", async () => {
    const { db, order } = fakeDb(Array.from({ length: 30 }, (_, i) => ({ n: i + 1 })));
    const summary = await run(db, fakeIo().io);
    expect(summary.claimed).toBe(20);
    expect(order).toHaveLength(20);
  });
  it("malformed claim entries are skipped and counted, never acted on", async () => {
    const db: GcDb = {
      async rpc(name) {
        if (name === "community_asset_gc_claim")
          return {
            data: {
              claimed: [
                { assetId: "x", domain: "community", claimToken: TOK(1) },
                { assetId: ID(1), domain: "evil", claimToken: TOK(1) },
                null,
              ],
            },
            error: null,
          };
        throw new Error("must not be called");
      },
    };
    expect(await run(db, fakeIo().io)).toMatchObject({ claimed: 0, malformed: 3 });
  });
  it("a claim RPC error or a null client makes the whole run unavailable (no partial work)", async () => {
    await expect(
      run(fakeDb([], { claimError: true }).db, fakeIo().io),
    ).rejects.toBeInstanceOf(GcUnavailableError);
    await expect(runMediaGcBatch({ db: null })).rejects.toBeInstanceOf(
      GcUnavailableError,
    );
  });
  it("logs only the asset id and the bounded class (no keys, no provider text)", async () => {
    const log = vi.fn();
    const { db } = fakeDb([{ n: 1 }]);
    await runMediaGcBatch({
      db,
      io: fakeIo({
        publicError: () => new Error(`secret-body community/${ID(1)}/w960.webp`),
      }).io,
      log,
    });
    expect(log).toHaveBeenCalledWith(
      `[media-gc] asset=${ID(1)} failed class=r2_public_delete_failed`,
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret-body|w960/);
  });
});
