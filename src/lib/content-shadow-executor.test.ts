// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { AdminAuthError } from "./admin-auth";
import { runShadowBatch, coverage } from "./content-shadow-executor";
import {
  FakeModerationTransport,
  ShadowFault,
  retryAfterSeconds,
  retryDelay,
  validateModerationResponse,
} from "./content-shadow-provider";
import {
  createShadowRunHandler,
  handleContentShadowRun,
} from "./content-shadow-handlers";
import {
  shadowMediaReader,
  shadowRepository,
  SHADOW_IMAGE_BYTES,
  type ShadowObjectRead,
} from "./content-shadow-storage";
import type {
  ShadowJob,
  ShadowFinishOutcome,
  ShadowFinishInput,
} from "./content-shadow-contract";
const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("./admin-auth.js", async (original) => ({
  ...(await original<typeof import("./admin-auth")>()),
  requireCapability: mocks.auth,
}));
vi.mock("./r2-client.js", () => ({
  getR2DevConfig: () => {
    throw new Error("Real storage forbidden in tests");
  },
}));
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const now = Date.parse("2026-10-16T00:00:00Z");
const stamp = (ms: number) => new Date(now + ms).toISOString();
const job = (change: Partial<ShadowJob> = {}): ShadowJob =>
  ({
    id: id(1),
    environment: "dev",
    post_id: id(2),
    author_user_id: id(3),
    version: 1,
    target_kind: "post",
    edit_id: null,
    base_version: null,
    snapshot_text: "PRIVATE synthetic text",
    assets: [{ asset_id: id(4), kind: "image", position: 0 }],
    snapshot_hash: "a".repeat(64),
    config_revision: "shadow-v1",
    preprocessing_version: "community-webp-v1",
    state: "processing",
    attempts: 1,
    next_attempt_at: stamp(0),
    lease_until: stamp(120000),
    claim_token: id(5),
    created_at: stamp(0),
    updated_at: stamp(0),
    snapshot_expires_at: stamp(3600000),
    retain_until: stamp(86400000),
    obsolete_at: null,
    obsolete_reason: null,
    last_error_code: null,
    coverage: { overall: null, text: null, images: null, video: null },
    ...change,
  }) as ShadowJob;
const response = (flagged = false, type: "text" | "image" = "text") => ({
  id: "fixture_response",
  model: "fixture-model",
  results: [
    {
      flagged,
      categories: { violence: flagged },
      category_scores: { violence: flagged ? 0.9 : 0.01 },
      category_applied_input_types: { violence: [type] },
    },
  ],
});
function setup(jobs: ShadowJob[] = [job()]) {
  const queue = [...jobs];
  const repo = {
    claim: vi.fn(async () => (queue.length ? [queue.shift()!] : [])),
    finish: vi.fn(async (_input: ShadowFinishInput) => "finished" as ShadowFinishOutcome),
  };
  const media = {
    verify: vi.fn(async () => undefined),
    read: vi.fn(async () => Buffer.from("synthetic webp bytes")),
  };
  const deps = {
    repository: repo,
    media,
    transport: new FakeModerationTransport(),
    now: () => now,
    random: () => 0,
  };
  return { deps, repo, media, run: (limit = 1) => runShadowBatch(deps, limit) };
}
beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue({ userId: id(3) });
  vi.stubEnv("CONTENT_SHADOW_RUN_ENABLED", "true");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("External calls forbidden");
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("sequential executor and modalities", () => {
  it("empty queue", async () => {
    const s = setup([]);
    expect((await s.run()).claimed).toBe(0);
    expect(s.repo.finish).not.toHaveBeenCalled();
  });
  it("claims once per job, two jobs maximum, no duplicates", async () => {
    const s = setup([job(), job({ id: id(6) }), job({ id: id(7) })]);
    expect((await s.run(2)).finished).toBe(2);
    expect(s.repo.claim).toHaveBeenCalledTimes(2);
    await expect(s.run(3)).rejects.toThrow("invalid_input");
    expect(Object.keys(s.repo).sort()).toEqual(["claim", "finish"]);
  });
  it("independent text and image calls, zeroed buffers, concurrency one", async () => {
    const s = setup();
    let active = 0,
      max = 0;
    const buffers: Buffer[] = [];
    s.media.read.mockImplementation(async () => {
      const b = Buffer.from("PRIVATE bytes");
      buffers.push(b);
      return b;
    });
    s.deps.transport = new FakeModerationTransport(async (r) => {
      max = Math.max(max, ++active);
      await Promise.resolve();
      active--;
      return response(false, r.input[0].type === "text" ? "text" : "image");
    });
    const result = await s.run();
    expect(max).toBe(1);
    expect(result.attemptedEvaluations).toBe(2);
    expect(result.completed).toBe(1);
    expect(buffers.every((b) => b.every((n) => n === 0))).toBe(true);
    expect(
      s.repo.finish.mock.calls[0][0].p_results?.map((r) => r.component_kind),
    ).toEqual(["text", "image"]);
  });
  it.each([false, true])(
    "safe/flagged text %s does not change outcome",
    async (flagged) => {
      const s = setup([job({ assets: [] })]);
      s.deps.transport = new FakeModerationTransport(async () => response(flagged));
      expect((await s.run()).completed).toBe(1);
      expect(s.repo.finish.mock.calls[0][0].p_results?.[0]).toMatchObject({ flagged });
    },
  );
  it.each([false, true])("safe/flagged image %s", async (flagged) => {
    const s = setup([job({ snapshot_text: null })]);
    s.deps.transport = new FakeModerationTransport(async () =>
      response(flagged, "image"),
    );
    expect((await s.run()).attemptedEvaluations).toBe(1);
    expect(s.repo.finish.mock.calls[0][0].p_results?.[0]).toMatchObject({
      flagged,
      component_kind: "image",
    });
  });
  it("multiple unique images, no empty text", async () => {
    const s = setup([
      job({
        snapshot_text: null,
        assets: [4, 6, 7].map((n, position) => ({
          asset_id: id(n),
          position,
          kind: "image",
        })),
      }),
    ]);
    expect((await s.run()).attemptedEvaluations).toBe(3);
    expect(s.media.read).toHaveBeenCalledTimes(3);
  });
  it.each([null, "text"])(
    "video never has complete visual coverage (text %s)",
    async (text) => {
      const j = job({
        snapshot_text: text,
        assets: [{ asset_id: id(4), kind: "video", position: 0 }],
      });
      const s = setup([j]);
      expect((await s.run()).partial).toBe(1);
      expect(s.media.read).not.toHaveBeenCalled();
      expect(coverage(j, s.repo.finish.mock.calls[0][0].p_results!)).toMatchObject({
        overall: text ? "partial" : "unsupported_video",
        video: "unsupported_video",
      });
    },
  );
  it("not applicable is distinct from unsupported video", async () => {
    const s = setup([job({ snapshot_text: null, assets: [] })]);
    expect((await s.run()).completed).toBe(1);
    expect(coverage(job({ snapshot_text: null, assets: [] }), []).overall).toBe(
      "not_applicable",
    );
  });
  it("invalid target identity and duplicate assets are not evaluated", async () => {
    for (const j of [
      job({ version: 0 }),
      job({ assets: [job().assets[0], job().assets[0]] }),
      job({ environment: "production" as "dev" }),
    ]) {
      const s = setup([j]);
      expect((await s.run()).rejected).toBe(1);
      expect(s.media.verify).not.toHaveBeenCalled();
    }
  });
});

describe("failures, leases and persistent retry inputs", () => {
  it.each(["busy", "not_found", "stale_claim", "obsolete"] as const)(
    "SQL %s never reported as success",
    async (outcome) => {
      const s = setup();
      s.repo.finish.mockResolvedValue(outcome);
      const r = await s.run();
      expect(r.rejected).toBe(1);
      expect(r.finished).toBe(0);
    },
  );
  it("persistence failure is not success", async () => {
    const s = setup();
    s.repo.finish.mockRejectedValue(new Error("PRIVATE SQL error"));
    expect((await s.run()).persistenceErrors).toBe(1);
  });
  it("claim failure stops batch", async () => {
    const s = setup();
    s.repo.claim.mockRejectedValue(new Error("PRIVATE"));
    expect((await s.run(2)).persistenceErrors).toBe(1);
    expect(s.repo.finish).not.toHaveBeenCalled();
  });
  it.each(["lease_until", "snapshot_expires_at", "retain_until"] as const)(
    "expired %s rejects without evaluation",
    async (key) => {
      const s = setup([job({ [key]: stamp(-1) })]);
      expect((await s.run()).rejected).toBe(1);
      expect(s.media.verify).not.toHaveBeenCalled();
    },
  );
  it("lease expires during provider evaluation: no finish", async () => {
    let clock = now;
    const s = setup([job({ assets: [] })]);
    s.deps.now = () => clock;
    s.deps.transport = new FakeModerationTransport(async () => {
      clock += 150000;
      return response();
    });
    expect((await s.run()).rejected).toBe(1);
    expect(s.repo.finish).not.toHaveBeenCalled();
  });
  it("transient rate limit preserves 120s and stops other components", async () => {
    const s = setup([job(), job({ id: id(6) })]);
    s.deps.transport = new FakeModerationTransport(async () => {
      throw new ShadowFault("provider_rate_limit", true, "120");
    });
    expect((await s.run(2)).retryWait).toBe(1);
    expect(s.repo.claim).toHaveBeenCalledTimes(1);
    expect(s.repo.finish.mock.calls[0][0]).toMatchObject({
      p_state: "retry_wait",
      p_retry_delay_seconds: 120,
    });
    expect(s.media.read).not.toHaveBeenCalled();
  });
  it("HTTP date Retry-After", async () => {
    const s = setup();
    s.deps.transport = new FakeModerationTransport(async () => {
      throw new ShadowFault(
        "provider_unavailable",
        true,
        new Date(now + 120000).toUTCString(),
      );
    });
    await s.run();
    expect(s.repo.finish.mock.calls[0][0].p_retry_delay_seconds).toBe(120);
  });
  it.each(["3601", "9999999999999999999999999999999999999999999999999"])(
    "excessive wait %s is terminal, not clamped",
    async (retry) => {
      const s = setup();
      s.deps.transport = new FakeModerationTransport(async () => {
        throw new ShadowFault("provider_rate_limit", true, retry);
      });
      expect((await s.run()).failed).toBe(1);
      expect(s.repo.finish.mock.calls[0][0].p_retry_delay_seconds).toBeNull();
    },
  );
  it("retry cannot extend snapshot and attempt 3 is terminal", async () => {
    for (const j of [job({ snapshot_expires_at: stamp(30000) }), job({ attempts: 3 })]) {
      const s = setup([j]);
      s.deps.transport = new FakeModerationTransport(async () => {
        throw new ShadowFault("provider_timeout", true, "120");
      });
      expect((await s.run()).failed).toBe(1);
    }
  });
  it("timeout is bounded and scheduled exactly once", async () => {
    const s = setup();
    s.deps.transport = new FakeModerationTransport(() => new Promise(() => undefined));
    expect((await runShadowBatch({ ...s.deps, componentTimeoutMs: 5 })).retryWait).toBe(
      1,
    );
    expect(s.repo.finish).toHaveBeenCalledTimes(1);
    expect(s.repo.finish.mock.calls[0][0].p_error_code).toBe("provider_timeout");
  });
  it("permanent error and malformed response fail closed", async () => {
    for (const transport of [
      new FakeModerationTransport(async () => {
        throw new ShadowFault("invalid_input");
      }),
      new FakeModerationTransport(async () => ({ results: [] })),
    ]) {
      const s = setup([job({ assets: [] })]);
      s.deps.transport = transport;
      expect((await s.run()).failed).toBe(1);
    }
  });
  it("reader failure is distinct and no private logging", async () => {
    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    const s = setup();
    s.media.read.mockRejectedValue(new ShadowFault("asset_unavailable"));
    expect((await s.run()).partial).toBe(1);
    expect(s.repo.finish.mock.calls[0][0].p_results?.[1]).toMatchObject({
      error_code: "asset_unavailable",
    });
    spies.forEach((s) => expect(s).not.toHaveBeenCalled());
  });
  it("live target rejected before transport (deleted/cancelled)", async () => {
    const s = setup();
    s.media.verify.mockRejectedValue(new ShadowFault("asset_unavailable"));
    const r = await s.run();
    expect(r.attemptedEvaluations).toBe(0);
    expect(r.failed).toBe(1);
  });
  it("simulated budget can deny attempts without claiming real quota enforcement", async () => {
    const s = setup();
    expect(
      (
        await runShadowBatch({
          ...s.deps,
          budget: { mode: "simulated", reserve: async () => false },
        })
      ).attemptedEvaluations,
    ).toBe(0);
  });
});

describe("response and Retry-After validation", () => {
  it.each(["text", "image"] as const)(
    "audit: no applied modality cannot complete %s",
    async (modality) => {
      const s = setup([
        job(modality === "text" ? { assets: [] } : { snapshot_text: null }),
      ]);
      s.deps.transport = new FakeModerationTransport(async () => {
        const r = response(false, modality);
        r.results[0].category_applied_input_types.violence = [];
        return r;
      });
      const result = await s.run();
      expect(result.failed).toBe(1);
      expect(result.completed).toBe(0);
    },
  );
  it.each([
    undefined,
    "",
    "garbage",
    "-1",
    "1.5",
    "Fri, 30 Feb 2026 00:00:00 GMT",
    "Thu, 15 Oct 2026 00:00:00 GMT",
  ])("invalid/absent/past %s", (value) => expect(retryAfterSeconds(value, now)).toBe(0));
  it("integer, HTTP date, floor, jitter, no implicit retries", () => {
    expect(retryAfterSeconds("120", now)).toBe(120);
    expect(retryAfterSeconds(new Date(now + 120000).toUTCString(), now)).toBe(120);
    expect(retryDelay(1, undefined, now, 0.5)).toBe(13);
    expect(retryDelay(2, "1", now, 0)).toBe(20);
  });
  it.each(["Friday, 16-Oct-26 00:02:00 GMT", "Fri Oct 16 00:02:00 2026"])(
    "legacy HTTP date %s respects wait",
    (value) => {
      expect(retryAfterSeconds(value, now)).toBe(120);
    },
  );
  it.each([NaN, 2, -1])("bad score %s", (value) => {
    const r = response();
    r.results[0].category_scores.violence = value;
    expect(() => validateModerationResponse(r)).toThrow("invalid_input");
  });
  it("text-only category cannot claim image support", () => {
    expect(() =>
      validateModerationResponse({
        ...response(),
        results: [
          {
            flagged: false,
            categories: { "sexual/minors": false },
            category_scores: { "sexual/minors": 0 },
            category_applied_input_types: { "sexual/minors": ["image"] },
          },
        ],
      }),
    ).toThrow("invalid_input");
  });
  it("applied types must match the component actually sent", () => {
    expect(() => validateModerationResponse(response(false, "image"), "text")).toThrow(
      "invalid_input",
    );
    expect(() => validateModerationResponse(response(false, "text"), "image")).toThrow(
      "invalid_input",
    );
  });
});

function storageFixture(j = job()) {
  const tables: Record<string, unknown> = {
    community_posts: {
      id: j.post_id,
      author_user_id: j.author_user_id,
      version: j.version,
      status: "published",
      text: j.snapshot_text,
    },
    community_post_pending_edits: {
      id: j.edit_id,
      post_id: j.post_id,
      base_version: j.version,
      status: "pending",
      text: j.snapshot_text,
    },
    community_post_media: j.assets.map((a) => ({
      asset_id: a.asset_id,
      position: a.position,
    })),
    community_post_pending_edit_media: j.assets.map((a) => ({
      asset_id: a.asset_id,
      position: a.position,
    })),
    media_assets: {
      id: id(4),
      domain: "community",
      created_by: j.author_user_id,
      status: "ready",
      kind: "image",
      mime: "image/webp",
    },
    media_asset_variants: [1600, 960, 480].map((variant) => ({
      variant,
      bytes: 0,
      storage_key: `community/${id(4)}/w${variant}.webp`,
    })),
  };
  const from = vi.fn((table: string) => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      order: () => builder,
      limit: () => builder,
      abortSignal: () => builder,
      maybeSingle: async () => ({ data: tables[table], error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(resolve({ data: tables[table], error: null })),
    };
    return builder;
  });
  return { tables, client: { from } as unknown as SupabaseClient, from };
}
describe("bounded canonical WebP reader", () => {
  let webp: Buffer;
  beforeEach(async () => {
    webp = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "blue" },
    })
      .webp()
      .toBuffer();
  });
  function reader(j = job()) {
    const f = storageFixture(j);
    const variants = f.tables.media_asset_variants as {
      bytes: number;
      variant: number;
    }[];
    variants.forEach((v) => (v.bytes = webp.length));
    const object: Awaited<ReturnType<ShadowObjectRead>> = {
      contentType: "image/webp",
      contentLength: webp.length,
      stream: {
        async *[Symbol.asyncIterator]() {
          yield webp;
        },
      },
    };
    const read = vi.fn(async () => object);
    return { ...f, object, read, reader: shadowMediaReader(f.client, read) };
  }
  it("one canonical 1600 variant, smaller fallback, bytes verified", async () => {
    const f = reader();
    const bytes = await f.reader.read(job(), id(4), new AbortController().signal);
    expect(bytes.equals(webp)).toBe(true);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.read.mock.calls[0]).toContain(`community/${id(4)}/w1600.webp`);
    (f.tables.media_asset_variants as unknown[]).shift();
    await f.reader.read(job(), id(4), new AbortController().signal);
    expect(f.read.mock.calls[1]).toContain(`community/${id(4)}/w960.webp`);
  });
  it("unassociated asset never reaches R2", async () => {
    const f = reader();
    await expect(
      f.reader.read(job(), id(99), new AbortController().signal),
    ).rejects.toThrow("asset_unavailable");
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each([
    "mime",
    "owner",
    "status",
    "path",
    "association",
    "deleted",
    "version",
    "oversized-record",
  ])("rejects %s before R2", async (bad) => {
    const f = reader();
    const a = f.tables.media_assets as Record<string, unknown>;
    if (bad === "mime") a.mime = "image/png";
    if (bad === "owner") a.created_by = id(99);
    if (bad === "status") a.status = "deleting";
    if (bad === "path")
      (f.tables.media_asset_variants as { storage_key: string }[]).forEach(
        (v) => (v.storage_key = "https://foreign.invalid/"),
      );
    if (bad === "association") f.tables.community_post_media = [];
    if (bad === "deleted") f.tables.community_posts = null;
    if (bad === "version")
      (f.tables.community_posts as Record<string, unknown>).version = 2;
    if (bad === "oversized-record")
      (f.tables.media_asset_variants as { bytes: number }[]).forEach(
        (v) => (v.bytes = SHADOW_IMAGE_BYTES + 1),
      );
    await expect(
      f.reader.read(job(), id(4), new AbortController().signal),
    ).rejects.toThrow("asset_unavailable");
    expect(f.read).not.toHaveBeenCalled();
  });
  it("cancelled pending edit denied", async () => {
    const j = job({ target_kind: "pending_edit", edit_id: id(9), base_version: 1 });
    const f = reader(j);
    (f.tables.community_post_pending_edits as Record<string, unknown>).status =
      "cancelled";
    await expect(f.reader.read(j, id(4), new AbortController().signal)).rejects.toThrow(
      "asset_unavailable",
    );
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["mime", "length", "stream", "magic"])("rejects response %s", async (bad) => {
    const f = reader();
    if (bad === "mime") f.object.contentType = "image/jpeg";
    if (bad === "length") f.object.contentLength = SHADOW_IMAGE_BYTES + 1;
    if (bad === "stream")
      f.object.stream = {
        async *[Symbol.asyncIterator]() {
          yield Buffer.alloc(SHADOW_IMAGE_BYTES + 1);
        },
      };
    if (bad === "magic")
      f.object.stream = {
        async *[Symbol.asyncIterator]() {
          yield Buffer.alloc(webp.length);
        },
      };
    await expect(
      f.reader.read(job(), id(4), new AbortController().signal),
    ).rejects.toThrow("asset_unavailable");
  });
  it("R2 denied is sanitized", async () => {
    const f = reader();
    f.read.mockRejectedValue(new Error("PRIVATE signed-url and credential"));
    await expect(
      f.reader.read(job(), id(4), new AbortController().signal),
    ).rejects.toThrow(/^asset_unavailable$/);
  });
  it("audit: excessive empty stream fragments are rejected before unbounded retention", async () => {
    const f = reader();
    let fragments = 0;
    f.object.stream = {
      async *[Symbol.asyncIterator]() {
        for (let n = 0; n < 65537; n++) {
          fragments++;
          yield Buffer.alloc(0);
        }
        yield webp;
      },
    };
    await expect(
      f.reader.read(job(), id(4), new AbortController().signal),
    ).rejects.toThrow("asset_unavailable");
    expect(fragments).toBeLessThanOrEqual(65537);
  });
  it("audit: legitimate fragmented WebP remains readable", async () => {
    const f = reader();
    f.object.stream = {
      async *[Symbol.asyncIterator]() {
        for (const byte of webp) yield Uint8Array.of(byte);
      },
    };
    expect(
      (await f.reader.read(job(), id(4), new AbortController().signal)).equals(webp),
    ).toBe(true);
  });
});

describe("RPC adapter and protected endpoint", () => {
  it("only claim/finish RPCs, exact arguments; no direct shadow table access", async () => {
    const calls: unknown[][] = [];
    const client = {
      rpc: (name: string, args: unknown) => {
        calls.push([name, args]);
        return {
          abortSignal: async () => ({
            data: name.endsWith("claim") ? [job()] : "finished",
            error: null,
          }),
        };
      },
    } as unknown as SupabaseClient;
    const repo = shadowRepository(client);
    const signal = new AbortController().signal;
    expect(await repo.claim(signal)).toHaveLength(1);
    const args = {
      p_job_id: id(1),
      p_claim_token: id(5),
      p_state: "retry_wait" as const,
      p_retry_delay_seconds: 120,
    };
    expect(await repo.finish(args, signal)).toBe("finished");
    expect(calls).toEqual([
      ["community_shadow_claim", { p_limit: 1, p_lease_seconds: 120 }],
      ["community_shadow_finish", args],
    ]);
  });
  async function endpoint(
    body: unknown = {},
    method = "POST",
    handler = createShadowRunHandler(async () => ({
      mode: "simulated",
      claimed: 0,
      attemptedEvaluations: 0,
      finished: 0,
      completed: 0,
      partial: 0,
      failed: 0,
      retryWait: 0,
      rejected: 0,
      persistenceErrors: 0,
    })),
  ) {
    const result = {
      status: 0,
      body: undefined as unknown,
      headers: {} as Record<string, string>,
    };
    const res = {
      setHeader: (k: string, v: string) => {
        result.headers[k] = v;
        return res;
      },
      status: (s: number) => {
        result.status = s;
        return res;
      },
      json: (b: unknown) => {
        result.body = b;
        return res;
      },
    } as unknown as VercelResponse;
    await handler(
      {
        method,
        body,
        query: { action: "content-shadow-run" },
        headers: {},
      } as unknown as VercelRequest,
      res,
    );
    return result;
  }
  it("developer_panel guard, private response and only operational fields", async () => {
    const r = await endpoint();
    expect(r.status).toBe(200);
    expect(mocks.auth.mock.calls[0][1]).toBe("developer_panel");
    expect(r.headers["Cache-Control"]).toBe("private, no-store");
    expect(JSON.stringify(r.body)).not.toMatch(/PRIVATE|claim_token|asset|scores/);
  });
  it.each([
    [401, undefined],
    [403, undefined],
    [403, "step_up_required"],
  ] as const)("auth/capability/MFA rejection %s %s", async (status, code) => {
    mocks.auth.mockRejectedValue(new AdminAuthError("No autorizado", status, code));
    expect((await endpoint()).status).toBe(status);
  });
  it.each([undefined, "false", "1", "TRUE", " true"])("flag %s denies", async (flag) => {
    vi.stubEnv("CONTENT_SHADOW_RUN_ENABLED", flag);
    expect((await endpoint()).status).toBe(503);
  });
  it.each([
    { limit: 0 },
    { limit: 3 },
    { limit: 1.5 },
    { limit: null },
    { limit: "2" },
    { actor: id(9) },
    [],
    "not json",
    null,
  ])("invalid body %j", async (body) => expect((await endpoint(body)).status).toBe(400));
  it("POST only, failures sanitized, DEV isolation", async () => {
    expect((await endpoint({}, "GET")).status).toBe(405);
    expect(
      (
        await endpoint(
          {},
          "POST",
          createShadowRunHandler(async () => {
            throw new Error("PRIVATE key");
          }),
        )
      ).body,
    ).toEqual({ error: "Servicio no disponible" });
    vi.stubEnv("VITE_SUPABASE_URL", "https://foreign.invalid");
    expect((await endpoint({}, "POST", handleContentShadowRun)).status).toBe(503);
  });
  it("default handler rejects wrong environment before any Auth connection", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://foreign.invalid");
    expect((await endpoint({}, "POST", handleContentShadowRun)).status).toBe(503);
    expect(mocks.auth).not.toHaveBeenCalled();
  });
  it("audit: overlapping HTTP batches are bounded within one server instance", async () => {
    const summary = await setup([]).run();
    let enter!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async () => {
      enter();
      await gate;
      return summary;
    });
    const handler = createShadowRunHandler(run);
    const first = endpoint({}, "POST", handler);
    await reached;
    const second = endpoint({}, "POST", handler);
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    const results = await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.status)).toEqual([200, 409]);
    expect((await endpoint({}, "POST", handler)).status).toBe(200);
  });
  it("dispatcher includes action, executor and provider contain no HTTP, Community writes or logs", () => {
    expect(readFileSync("api/admin/[action].ts", "utf8")).toContain(
      'case "content-shadow-run":',
    );
    for (const file of ["content-shadow-executor.ts", "content-shadow-provider.ts"]) {
      const source = readFileSync(`src/lib/${file}`, "utf8");
      expect(source).not.toMatch(
        /\bfetch\s*\(|api\.openai\.com|console\.|community_post_(?:save|delete)|content_review_decide|OPENAI_API_KEY/,
      );
    }
  });
});
