// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ShadowJob,
  ShadowAttemptStartOutcome,
  ShadowFinishInput,
  ShadowDeferInput,
} from "./content-shadow-contract";
import { runShadowBatch } from "./content-shadow-executor";
import {
  shadowSqlBudget,
  type BudgetReservation,
  type PersistentShadowBudget,
} from "./content-shadow-budget";
import { FakeModerationTransport, ShadowFault } from "./content-shadow-provider";
const id = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const clock = Date.parse("2026-10-16T12:00:00Z");
const stamp = (seconds: number) => new Date(clock + seconds * 1000).toISOString();
function fixture() {
  const job = {
    id: id(1),
    post_id: id(2),
    author_user_id: id(3),
    target_kind: "post",
    edit_id: null,
    base_version: null,
    environment: "dev",
    version: 1,
    snapshot_text: "Synthetic private text",
    assets: [1, 2, 3].map((i) => ({ asset_id: id(10 + i), kind: "image", position: i })),
    snapshot_hash: "a".repeat(64),
    preprocessing_version: "community-webp-v1",
    config_revision: "shadow-v1",
    state: "processing",
    attempts: 0,
    attempt_claim_token: null,
    administrative_defer_reason: null,
    claim_token: id(4),
    lease_until: stamp(120),
    snapshot_expires_at: stamp(3600),
    retain_until: stamp(86400),
    obsolete_at: null,
    obsolete_reason: null,
    created_at: stamp(0),
    updated_at: stamp(0),
    next_attempt_at: stamp(0),
    last_error_code: null,
    coverage: { overall: null, text: null, images: null, video: null },
  } as ShadowJob;
  const repository = {
    claim: vi.fn(async () => []),
    acquire: vi.fn(async () => [job]),
    start: vi.fn(async () => "started" as ShadowAttemptStartOutcome),
    defer: vi.fn(async (_input: ShadowDeferInput) => "deferred" as const),
    finish: vi.fn(async (_input: ShadowFinishInput) => "finished" as const),
  };
  const reserve = vi.fn(
    async (_job: ShadowJob, units: number): Promise<BudgetReservation> => ({
      status: "reserved",
      reservation_id: id(5),
      units,
    }),
  );
  const check = vi.fn<PersistentShadowBudget["check"]>(async () => ({
    status: "allowed",
  }));
  const cooldown = vi.fn(async () => undefined);
  const budget: PersistentShadowBudget = {
    mode: "persistent_dev",
    reserve,
    check,
    cooldown,
  };
  const media = {
    verify: vi.fn(async () => undefined),
    read: vi.fn(async () => Buffer.from("fake private bytes")),
  };
  const transport = new FakeModerationTransport();
  const evaluate = vi.spyOn(transport, "evaluate");
  const deps = {
    repository,
    media,
    budget,
    transport,
    now: () => clock,
    random: () => 0,
  };
  return {
    job,
    repository,
    reserve,
    check,
    cooldown,
    media,
    deps,
    evaluate,
    run: () => runShadowBatch(deps),
  };
}
beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("External requests prohibited");
    }),
  ),
);
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("persistent budget protocol with isolated fakes", () => {
  it("reserves exactly text plus three images once, starts afterwards, processes sequentially", async () => {
    const s = fixture();
    const order: string[] = [];
    s.reserve.mockImplementation(async (_j, n) => {
      order.push("reserve");
      return { status: "reserved", reservation_id: id(5), units: n };
    });
    s.repository.start.mockImplementation(async () => {
      order.push("start");
      return "started";
    });
    let active = 0,
      max = 0;
    const response = new FakeModerationTransport();
    s.evaluate.mockImplementation(async (r, signal) => {
      order.push("send");
      max = Math.max(max, ++active);
      const out = await response.evaluate(r, signal);
      active--;
      return out;
    });
    const out = await s.run();
    expect(s.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1 }),
      4,
      expect.any(AbortSignal),
    );
    expect(order.slice(0, 2)).toEqual(["reserve", "start"]);
    expect(max).toBe(1);
    expect(out.completed).toBe(1);
    expect(out.attemptedEvaluations).toBe(4);
    expect(s.check).toHaveBeenCalledTimes(4);
    expect(s.repository.claim).not.toHaveBeenCalled();
  });
  it.each(["quota_exhausted", "cooldown_active"] as const)(
    "%s defers with authoritative deadline and no attempt",
    async (status) => {
      const s = fixture();
      s.reserve.mockResolvedValue({ status, retry_at: stamp(300) });
      expect((await s.run()).deferred).toBe(1);
      expect(s.repository.defer).toHaveBeenCalledWith(
        {
          p_job_id: s.job.id,
          p_claim_token: s.job.claim_token,
          p_resume_at: stamp(300),
          p_reason: status,
        },
        expect.any(AbortSignal),
      );
      expect(s.repository.start).not.toHaveBeenCalled();
      expect(s.evaluate).not.toHaveBeenCalled();
      expect(s.repository.finish).not.toHaveBeenCalled();
      expect(s.job.attempts).toBe(0);
    },
  );
  it("a later window expires through the existing defer contract without extending TTL", async () => {
    const s = fixture();
    s.reserve.mockResolvedValue({ status: "quota_exhausted", retry_at: stamp(86400) });
    await s.run();
    expect(s.repository.defer.mock.calls[0][0]).toMatchObject({
      p_resume_at: stamp(3600),
    });
    expect(s.evaluate).not.toHaveBeenCalled();
  });
  it("database unavailable fails closed before start or transport", async () => {
    const s = fixture();
    s.reserve.mockRejectedValue(new Error("private internal DB details"));
    const out = await s.run();
    expect(out.persistenceErrors).toBe(1);
    expect(s.repository.start).not.toHaveBeenCalled();
    expect(s.evaluate).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain("private");
  });
  it.each(["stale_claim", "busy", "obsolete", "not_found", "already_started"] as const)(
    "reservation is never refunded after start returns %s",
    async (outcome) => {
      const s = fixture();
      s.repository.start.mockResolvedValue(outcome);
      expect((await s.run()).rejected).toBe(1);
      expect(s.reserve).toHaveBeenCalledTimes(1);
      expect(s.evaluate).not.toHaveBeenCalled();
      expect(s.repository.finish).not.toHaveBeenCalled();
    },
  );
  it("lease expires after reservation: no start, transport or refund", async () => {
    const s = fixture();
    let time = clock;
    s.deps.now = () => time;
    s.reserve.mockImplementation(async () => {
      time += 121000;
      return { status: "reserved", reservation_id: id(5), units: 4 };
    });
    expect((await s.run()).persistenceErrors).toBe(1);
    expect(s.repository.start).not.toHaveBeenCalled();
    expect(s.evaluate).not.toHaveBeenCalled();
  });
  it("cooldown appearing after first component stops remaining sends and records partial coverage", async () => {
    const s = fixture();
    s.check
      .mockResolvedValueOnce({ status: "allowed" })
      .mockResolvedValue({ status: "cooldown_active", retry_at: stamp(120) });
    const out = await s.run();
    expect(out.partial).toBe(1);
    expect(out.completed).toBe(0);
    expect(s.evaluate).toHaveBeenCalledTimes(1);
    expect(s.cooldown).not.toHaveBeenCalled();
    expect(s.repository.finish.mock.calls[0][0]).toMatchObject({ p_state: "partial" });
  });
  it.each(["120", new Date(clock + 120000).toUTCString()])(
    "provider 429 persists global Retry-After %s before stopping",
    async (retryAfter) => {
      const s = fixture();
      const real = new FakeModerationTransport();
      s.evaluate
        .mockImplementationOnce((r, signal) => real.evaluate(r, signal))
        .mockRejectedValue(new ShadowFault("provider_rate_limit", true, retryAfter));
      const out = await s.run();
      expect(s.cooldown).toHaveBeenCalledWith(120, expect.any(AbortSignal));
      expect(out.partial).toBe(1);
      expect(out.retryWait).toBe(0);
      expect(s.evaluate).toHaveBeenCalledTimes(2);
    },
  );
  it("timeout consumes reservation with bounded provider retry and no refund", async () => {
    const s = fixture();
    s.evaluate.mockRejectedValue(new ShadowFault("provider_timeout", true));
    const out = await s.run();
    expect(s.reserve).toHaveBeenCalledTimes(1);
    expect(out.retryWait).toBe(1);
    expect(out.completed).toBe(0);
  });
  it("third effective attempt cannot schedule a fourth", async () => {
    const s = fixture();
    s.job.attempts = 2;
    s.evaluate.mockRejectedValue(new ShadowFault("provider_timeout", true));
    const out = await s.run();
    expect(out.failed).toBe(1);
    expect(out.retryWait).toBe(0);
  });
  it("video-only coverage uses no provider reservations and remains unsupported", async () => {
    const s = fixture();
    s.job.snapshot_text = null;
    s.job.assets = [{ asset_id: id(11), kind: "video", position: 0 }];
    expect((await s.run()).partial).toBe(1);
    expect(s.reserve).not.toHaveBeenCalled();
    expect(s.evaluate).not.toHaveBeenCalled();
  });
  it("persistent budget cannot accidentally run on a legacy-only repository", async () => {
    const s = fixture();
    await expect(
      runShadowBatch({
        ...s.deps,
        repository: { claim: s.repository.claim, finish: s.repository.finish },
      }),
    ).rejects.toThrow("invalid_input");
  });
});
describe("SQL budget adapter closed responses", () => {
  function sql(data: unknown, error: unknown = null) {
    const rpc = vi.fn(() => ({ abortSignal: async () => ({ data, error }) }));
    return { rpc, budget: shadowSqlBudget({ rpc } as unknown as SupabaseClient) };
  }
  it("uses exact job/token/count and never client-selected scope or cap", async () => {
    const s = fixture(),
      a = sql({ status: "reserved", reservation_id: id(5), units: 4 });
    await a.budget.reserve(s.job, 4, new AbortController().signal);
    expect(a.rpc).toHaveBeenCalledWith("community_shadow_budget_reserve", {
      p_job_id: s.job.id,
      p_claim_token: s.job.claim_token,
      p_units: 4,
    });
  });
  it.each([
    {},
    { status: "allowed" },
    { status: "quota_exhausted", retry_at: "invalid" },
    { status: "reserved", reservation_id: id(5), units: 3 },
  ])("rejects malformed reserve response %j", async (data) => {
    const s = fixture(),
      a = sql(data);
    await expect(
      a.budget.reserve(s.job, 4, new AbortController().signal),
    ).rejects.toThrow("internal_failure");
  });
  it("sanitizes SQL errors", async () => {
    const a = sql(null, { message: "PRIVATE token" });
    await expect(a.budget.cooldown(120, new AbortController().signal)).rejects.toThrow(
      /^internal_failure$/,
    );
  });
  it("sanitizes rejected RPC promises as well as returned SQL errors", async () => {
    const rpc = vi.fn(() => ({
      abortSignal: async () => {
        throw new Error("PRIVATE network credential");
      },
    }));
    const budget = shadowSqlBudget({ rpc } as unknown as SupabaseClient);
    await expect(
      budget.reserve(fixture().job, 4, new AbortController().signal),
    ).rejects.toThrow(/^internal_failure$/);
  });
});
