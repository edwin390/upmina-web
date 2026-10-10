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
/** Claves canónicas posibles de un asset (ordenadas como deriveAssetObjects). */
const CANON = (domain: string, id: string) => [
  ...(domain === "community"
    ? ["mov", "mp4", "webm"].map((e) => `community/${id}/original.${e}`)
    : []),
  ...["1600", "2560", "480", "960"].map((w) => `${domain}/${id}/w${w}.webp`),
];

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
    // Variantes registradas + claves canónicas posibles (variantes subidas sin fila): todo del asset.
    expect(objects.publicKeys).toEqual(CANON("community", ID(1)));
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
    expect(objects.publicKeys).toEqual(CANON("community", ID(2)));
    expect(objects.publicKeys).toContain(`community/${ID(2)}/original.mp4`);
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
    // Solo sobreviven las claves canónicas del PROPIO asset; todo lo ajeno se cuenta y se descarta.
    expect(objects.publicKeys).toEqual(CANON("community", ID(3)));
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

// ── R6: sesiones multipart abandonadas ────────────────────────────────────────────────────────

describe("runMediaGcBatch · sesión multipart abierta (R6)", () => {
  const UP = "synthetic-upload-id-0001";
  const KEY = (n: number) => `staging/community/${ID(n)}/original.mp4`;
  type Step = string;

  function mpEnv(
    options: {
      objects?: Record<string, unknown>;
      cleared?: string | "error" | "throw";
      finalize?: string;
      abortError?: Error | null;
      noAbort?: boolean;
    } = {},
  ) {
    const steps: Step[] = [];
    const db: GcDb = {
      async rpc(name, args) {
        if (name === "community_asset_gc_claim")
          return {
            data: {
              claimed: [
                {
                  assetId: ID(1),
                  domain: "community",
                  kind: "video",
                  claimToken: TOK(1),
                  attempts: 0,
                },
              ],
            },
            error: null,
          };
        if (name === "community_asset_gc_objects") {
          steps.push("objects");
          return {
            data: {
              valid: true,
              assetId: ID(1),
              domain: "community",
              kind: "video",
              publicKeys: [],
              privateKeys: [KEY(1)],
              rejectedKeys: 0,
              multipartUploadId: UP,
              multipartKey: KEY(1),
              ...options.objects,
            },
            error: null,
          };
        }
        if (name === "community_asset_gc_multipart_cleared") {
          steps.push(`cleared:${String(args.p_upload_id)}`);
          if (options.cleared === "throw") throw new Error("network");
          if (options.cleared === "error")
            return { data: null, error: { message: "boom" } };
          return { data: { result: options.cleared ?? "cleared" }, error: null };
        }
        if (name === "community_asset_gc_finalize") {
          steps.push("finalize");
          return { data: { result: options.finalize ?? "deleted" }, error: null };
        }
        if (name === "community_asset_gc_fail") {
          steps.push(`fail:${String(args.p_error_class)}`);
          return { data: { result: "retry_scheduled" }, error: null };
        }
        throw new Error(`unexpected rpc ${name}`);
      },
    };
    const io: PhysicalDeleteIo = {
      async deletePublic(keys) {
        steps.push(`delete-public:${keys.length}`);
      },
      async deletePrivate(key) {
        steps.push(`delete-private:${key}`);
      },
    };
    if (!options.noAbort)
      io.abortMultipart = async (key, uploadId) => {
        steps.push(`abort:${key}:${uploadId}`);
        if (options.abortError) throw options.abortError;
      };
    return { db, io, steps };
  }

  it("aborta con la clave e identificador exactos ANTES de borrar objetos y de finalizar", async () => {
    const { db, io, steps } = mpEnv();
    const summary = await run(db, io);
    expect(summary).toMatchObject({ claimed: 1, finalized: 1, failed: 0 });
    expect(steps).toEqual([
      "objects",
      `abort:${KEY(1)}:${UP}`,
      `cleared:${UP}`,
      `delete-private:${KEY(1)}`,
      "finalize",
    ]);
  });

  it("NoSuchUpload cuenta como éxito (la sesión ya no existe)", async () => {
    const { db, io, steps } = mpEnv({
      abortError: Object.assign(new Error("gone"), { name: "NoSuchUpload" }),
    });
    expect(await run(db, io)).toMatchObject({ finalized: 1, failed: 0 });
    expect(steps).toContain(`cleared:${UP}`);
    expect(steps.at(-1)).toBe("finalize");
  });

  it("si el aborto falla: no limpia el identificador, no borra objetos ni finaliza", async () => {
    const { db, io, steps } = mpEnv({ abortError: new Error("R2 503") });
    const summary = await run(db, io);
    expect(summary).toMatchObject({ claimed: 1, finalized: 0, failed: 1 });
    expect(summary.errorClasses).toEqual({ r2_multipart_abort_failed: 1 });
    expect(steps).toEqual([
      "objects",
      `abort:${KEY(1)}:${UP}`,
      "fail:r2_multipart_abort_failed",
    ]);
  });

  it("sin capacidad de abortar falla cerrado (nunca borra con una sesión abierta)", async () => {
    const { db, io, steps } = mpEnv({ noAbort: true });
    expect(await run(db, io)).toMatchObject({ finalized: 0, failed: 1 });
    expect(steps).toEqual(["objects", "fail:r2_multipart_abort_failed"]);
  });

  it("aborto OK pero la RPC de limpieza falla: nada se borra y el reintento es seguro", async () => {
    const first = mpEnv({ cleared: "error" });
    const r1 = await run(first.db, first.io);
    expect(r1).toMatchObject({ finalized: 0, failed: 1 });
    expect(r1.errorClasses).toEqual({ multipart_clear_failed: 1 });
    expect(first.steps).toEqual([
      "objects",
      `abort:${KEY(1)}:${UP}`,
      `cleared:${UP}`,
      "fail:multipart_clear_failed",
    ]);
    // Reintento: la sesión ya no existe en R2 (NoSuchUpload) y la limpieza puede completarse.
    const second = mpEnv({
      abortError: Object.assign(new Error("gone"), { name: "NoSuchUpload" }),
      cleared: "already_cleared",
    });
    expect(await run(second.db, second.io)).toMatchObject({ finalized: 1, failed: 0 });
  });

  it("limpieza con excepción de red: falla controlada, sin borrar", async () => {
    const { db, io, steps } = mpEnv({ cleared: "throw" });
    expect(await run(db, io)).toMatchObject({ finalized: 0, failed: 1 });
    expect(steps.some((s) => s.startsWith("delete"))).toBe(false);
    expect(steps).not.toContain("finalize");
  });

  it("identificador cambiado o resultado desconocido: no borra ni finaliza", async () => {
    for (const cleared of ["upload_id_changed", "something_else"]) {
      const { db, io, steps } = mpEnv({ cleared });
      expect(await run(db, io)).toMatchObject({ finalized: 0, failed: 1 });
      expect(steps.some((s) => s.startsWith("delete") || s === "finalize")).toBe(false);
    }
  });

  it("claim ya no vigente al limpiar => stale, sin borrar; already_gone => alreadyGone", async () => {
    const stale = mpEnv({ cleared: "invalid_claim" });
    expect(await run(stale.db, stale.io)).toMatchObject({ stale: 1, finalized: 0 });
    expect(stale.steps.some((s) => s.startsWith("delete"))).toBe(false);
    const gone = mpEnv({ cleared: "already_gone" });
    expect(await run(gone.db, gone.io)).toMatchObject({ alreadyGone: 1, finalized: 0 });
  });

  it("datos de sesión incoherentes o ajenos: invalid_object_reference y no se aborta", async () => {
    const cases: Record<string, unknown>[] = [
      { multipartKey: null },
      { multipartUploadId: null },
      { multipartUploadId: "" },
      { multipartKey: `staging/community/${ID(2)}/original.mp4` }, // clave de otro asset
      { multipartKey: `community/${ID(1)}/original.mp4` }, // clave pública, no staging/objects
    ];
    for (const objects of cases) {
      const { db, io, steps } = mpEnv({ objects });
      expect(await run(db, io)).toMatchObject({ finalized: 0, failed: 1 });
      expect(steps.some((s) => s.startsWith("abort") || s.startsWith("delete"))).toBe(
        false,
      );
      expect(steps.at(-1)).toBe("fail:invalid_object_reference");
    }
  });

  it("finalize que informa multipart_pending se cuenta como fallo ya registrado (sin segundo fail)", async () => {
    const { db, io, steps } = mpEnv({ finalize: "multipart_pending" });
    expect(await run(db, io)).toMatchObject({ finalized: 0, failed: 1 });
    expect(steps.filter((s) => s.startsWith("fail")).length).toBe(0);
  });

  it("un asset sin sesión multipart nunca llama al aborto ni a la limpieza", async () => {
    const { db, io, steps } = mpEnv({
      objects: { multipartUploadId: null, multipartKey: null },
    });
    expect(await run(db, io)).toMatchObject({ finalized: 1 });
    expect(steps.some((s) => s.startsWith("abort") || s.startsWith("cleared"))).toBe(
      false,
    );
    // Respuesta antigua sin los campos nuevos: mismo comportamiento.
    const legacy = mpEnv({ objects: {} });
    const original = legacy.db.rpc.bind(legacy.db);
    legacy.db.rpc = async (name, args) => {
      const res = await original(name, args);
      if (name === "community_asset_gc_objects") {
        const d = res.data as Record<string, unknown>;
        delete d.multipartUploadId;
        delete d.multipartKey;
      }
      return res;
    };
    expect(await run(legacy.db, legacy.io)).toMatchObject({ finalized: 1 });
  });
});
