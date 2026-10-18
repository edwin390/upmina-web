// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type {
  ShadowJob,
  ShadowFinishInput,
  ShadowFinishOutcome,
  ShadowAttemptStartOutcome,
} from "./content-shadow-contract";
import {
  OpenAIModerationTransport,
  selectShadowTransport,
  OPENAI_RESPONSE_BYTES,
  OPENAI_TIMEOUT_MS,
} from "./content-shadow-openai";
import {
  FakeModerationTransport,
  ShadowFault,
  SHADOW_MODEL,
  type ModerationRequest,
} from "./content-shadow-provider";
import { shadowSqlBudget } from "./content-shadow-budget";
import { runShadowBatch } from "./content-shadow-executor";
import {
  handleContentShadowRun,
  createShadowRunHandler,
} from "./content-shadow-handlers";
const auth = vi.hoisted(() => vi.fn());
vi.mock("./admin-auth.js", async (original) => ({
  ...(await original<typeof import("./admin-auth")>()),
  requireCapability: auth,
}));
const clock = Date.parse("2026-10-16T12:00:00Z"),
  id = (n: number) => `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`;
const stamp = (seconds: number) => new Date(clock + seconds * 1000).toISOString();
const secret = "synthetic-credential-for-tests";
const text: ModerationRequest = {
  model: SHADOW_MODEL,
  input: [{ type: "text", text: "PRIVATE_SYNTHETIC_TEXT" }],
};
const image = `data:image/webp;base64,${Buffer.from("RIFF0000WEBPsynthetic").toString("base64")}`;
const imageRequest: ModerationRequest = {
  model: SHADOW_MODEL,
  input: [{ type: "image_url", image_url: { url: image } }],
};
const names = [
  "harassment",
  "harassment/threatening",
  "hate",
  "hate/threatening",
  "illicit",
  "illicit/violent",
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
  "sexual",
  "sexual/minors",
  "violence",
  "violence/graphic",
];
function response(modality = "text", flagged = false) {
  return {
    id: "modr-synthetic_fixture",
    model: "omni-moderation-2024-09-26",
    results: [
      {
        flagged,
        categories: Object.fromEntries(
          names.map((k) => [k, flagged && k === "violence"]),
        ),
        category_scores: Object.fromEntries(
          names.map((k) => [k, flagged && k === "violence" ? 0.9 : 0]),
        ),
        category_applied_input_types: Object.fromEntries(
          names.map((k) => [
            k,
            modality === "image" &&
            (names.slice(0, 6).includes(k) || k === "sexual/minors")
              ? []
              : [modality],
          ]),
        ),
      },
    ],
  };
}
const json = (body: unknown = response()) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
function fault(value: unknown): ShadowFault {
  expect(value).toBeInstanceOf(ShadowFault);
  return value as ShadowFault;
}
function environment(): Record<string, string | undefined> {
  return {
    CONTENT_SHADOW_PROVIDER: "openai",
    CONTENT_SHADOW_RUN_ENABLED: "true",
    CONTENT_SHADOW_BUDGET_MODE: "persistent_dev",
    VERCEL: "1",
    VERCEL_ENV: "preview",
    VERCEL_PROJECT_ID: "prj_fz4fs3FBfz2Gn4LH1Qnew18PpBrP",
    VITE_SUPABASE_URL: "https://rkqeqbqwdswhpzwqptac.supabase.co",
    OPENAI_API_KEY: secret,
  };
}
function httpFixture(handler: () => Promise<Response> = async () => json()) {
  const env = environment(),
    http = vi.fn<typeof fetch>(handler);
  const transport = OpenAIModerationTransport.create({ environment: () => env, http });
  return {
    env,
    http,
    transport,
    run: (request = text, signal = new AbortController().signal) =>
      transport.evaluate(request, signal),
  };
}
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("NETWORK FORBIDDEN");
    }),
  );
  vi.spyOn(Date, "now").mockReturnValue(clock);
  for (const name of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, name).mockImplementation(() => undefined);
  auth.mockReset();
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  for (const name of ["log", "info", "warn", "error", "debug"] as const)
    expect(console[name]).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("closed server-side selection", () => {
  it("fake is default, without reading credentials or consuming SQL budget", () => {
    const env = {};
    Object.defineProperty(env, "OPENAI_API_KEY", {
      get: () => {
        throw new Error("must not read");
      },
    });
    expect(selectShadowTransport({ environment: () => env })).toBeInstanceOf(
      FakeModerationTransport,
    );
    expect(
      selectShadowTransport({ environment: () => ({ CONTENT_SHADOW_PROVIDER: "fake" }) }),
    ).toBeInstanceOf(FakeModerationTransport);
  });
  it.each([
    ["CONTENT_SHADOW_PROVIDER", undefined],
    ["CONTENT_SHADOW_PROVIDER", "OPENAI"],
    ["CONTENT_SHADOW_RUN_ENABLED", "false"],
    ["CONTENT_SHADOW_BUDGET_MODE", undefined],
    ["VERCEL", undefined],
    ["VERCEL_ENV", "production"],
    ["VERCEL_ENV", "development"],
    ["VERCEL_PROJECT_ID", undefined],
    ["VERCEL_PROJECT_ID", "upmina-web"],
    ["VITE_SUPABASE_URL", "https://dmtuvzfdaectvqczwfhx.supabase.co"],
    ["OPENAI_API_KEY", undefined],
    ["OPENAI_API_KEY", "bad\r\nheader"],
  ])("real transport rejects missing/incorrect %s=%s", (key, value) => {
    const env = environment();
    env[key!] = value;
    const http = vi.fn();
    expect(() =>
      OpenAIModerationTransport.create({ environment: () => env, http }),
    ).toThrow("auth_unavailable");
    expect(http).not.toHaveBeenCalled();
  });
  it("unknown mode cannot fall back to a real transport", () => {
    expect(() =>
      selectShadowTransport({ environment: () => ({ CONTENT_SHADOW_PROVIDER: "auto" }) }),
    ).toThrow("auth_unavailable");
  });
  it("rechecks flags on every send and never serializes credentials on the object", async () => {
    const s = httpFixture();
    expect(JSON.stringify(s.transport)).not.toContain(secret);
    s.env.CONTENT_SHADOW_RUN_ENABLED = "false";
    await expect(s.run()).rejects.toThrow("auth_unavailable");
    expect(s.http).not.toHaveBeenCalled();
  });
  it("default endpoint rejects incomplete real DEV identity before Auth/network", async () => {
    vi.stubEnv("CONTENT_SHADOW_PROVIDER", "openai");
    vi.stubEnv("VITE_SUPABASE_URL", "https://rkqeqbqwdswhpzwqptac.supabase.co");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_PROJECT_ID", "");
    const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handleContentShadowRun(
      { method: "POST", body: {}, query: {} } as VercelRequest,
      res as unknown as VercelResponse,
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(auth).not.toHaveBeenCalled();
  });
  it("HTTP caller cannot select provider, scope, credential or budget", async () => {
    auth.mockResolvedValue({ userId: id(3) });
    vi.stubEnv("CONTENT_SHADOW_RUN_ENABLED", "true");
    const runner = vi.fn(),
      handler = createShadowRunHandler(runner);
    for (const body of [
      { provider: "openai" },
      { scope: "dev" },
      { OPENAI_API_KEY: secret },
      { units: 1 },
    ]) {
      const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
      await handler(
        { method: "POST", body, query: {} } as VercelRequest,
        res as unknown as VercelResponse,
      );
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(runner).not.toHaveBeenCalled();
    expect(auth).toHaveBeenCalledWith(expect.anything(), "developer_panel");
  });
});
describe("bounded HTTP transport (no native network)", () => {
  it.each([false, true])(
    "text JSON and validated provider model, flagged=%s",
    async (flagged) => {
      const s = httpFixture(async () => json(response("text", flagged)));
      const out = await s.run();
      expect(out).toMatchObject({
        model: "omni-moderation-2024-09-26",
        results: [{ flagged }],
      });
      expect(s.http).toHaveBeenCalledTimes(1);
      const [url, init] = s.http.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/moderations");
      expect(init).toMatchObject({
        method: "POST",
        redirect: "manual",
        credentials: "omit",
      });
      expect(JSON.parse(init!.body as string)).toEqual(text);
      expect(init!.headers).toMatchObject({ Authorization: `Bearer ${secret}` });
    },
  );
  it("image uses a WebP data URL and a single independent request", async () => {
    const s = httpFixture(async () => json(response("image")));
    await s.run(imageRequest);
    expect(JSON.parse(s.http.mock.calls[0][1]!.body as string)).toEqual(imageRequest);
    expect(s.http).toHaveBeenCalledTimes(1);
  });
  it.each([
    "https://private.example/image.webp",
    "http://127.0.0.1/image",
    "file:///secret",
    "data:video/mp4;base64,AAAA",
  ])("rejects arbitrary image input %s before HTTP", async (url) => {
    const s = httpFixture();
    await expect(
      s.run({ model: SHADOW_MODEL, input: [{ type: "image_url", image_url: { url } }] }),
    ).rejects.toThrow("invalid_input");
    expect(s.http).not.toHaveBeenCalled();
  });
  it.each([
    (r: ReturnType<typeof response>) => ({ ...r, results: [] }),
    (r: ReturnType<typeof response>) => ({ ...r, id: "foreign" }),
    (r: ReturnType<typeof response>) => ({ ...r, model: "another-model" }),
    (r: ReturnType<typeof response>) => {
      delete (r.results[0] as Partial<(typeof r.results)[0]>)
        .category_applied_input_types;
      return r;
    },
    (r: ReturnType<typeof response>) => {
      delete r.results[0].categories.violence;
      return r;
    },
    (r: ReturnType<typeof response>) => {
      r.results[0].category_scores.violence = 2;
      return r;
    },
    (r: ReturnType<typeof response>) => {
      r.results[0].flagged = true;
      return r;
    },
    (r: ReturnType<typeof response>) => {
      r.results[0].category_applied_input_types.violence = ["image"];
      return r;
    },
  ])("malformed/mismatched provider response is never safe %#", async (mutate) => {
    const s = httpFixture(async () => json(mutate(response())));
    await expect(s.run()).rejects.toThrow("invalid_input");
    expect(s.http).toHaveBeenCalledTimes(1);
  });
  it.each([
    "{",
    '{"category_scores":{"violence":NaN}}',
    '{"category_scores":{"violence":Infinity}}',
  ])("invalid JSON %s", async (raw) => {
    const s = httpFixture(
      async () => new Response(raw, { headers: { "Content-Type": "application/json" } }),
    );
    await expect(s.run()).rejects.toThrow("invalid_input");
  });
  it("nonfinite parsed score is rejected", async () => {
    const raw = JSON.stringify(response()).replace('"violence":0', '"violence":1e999');
    const s = httpFixture(
      async () => new Response(raw, { headers: { "Content-Type": "application/json" } }),
    );
    await expect(s.run()).rejects.toThrow("invalid_input");
  });
  it.each([400, 422, 401, 403, 429, 500, 503])(
    "classifies HTTP %s without reading/leaking body or retrying",
    async (status) => {
      const s = httpFixture(
        async () =>
          new Response("PRIVATE body and credential", {
            status,
            headers: { "Retry-After": "120" },
          }),
      );
      const error = fault(await s.run().catch((e) => e));
      expect(error.code).toBe(
        status === 429
          ? "provider_rate_limit"
          : status === 401 || status === 403
            ? "auth_unavailable"
            : status >= 500
              ? "provider_unavailable"
              : "invalid_input",
      );
      expect(error.retryable).toBe(status === 429 || status >= 500);
      expect(String(error)).not.toContain("PRIVATE");
      expect(s.http).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["120", new Date(clock + 120000).toUTCString()])(
    "429 preserves Retry-After %s",
    async (value) => {
      const s = httpFixture(
        async () =>
          new Response(null, { status: 429, headers: { "Retry-After": value } }),
      );
      await expect(s.run()).rejects.toMatchObject({
        code: "provider_rate_limit",
        retryAfter: "120",
      });
    },
  );
  it.each(["-1", "invalid", new Date(clock - 1000).toUTCString()])(
    "invalid/past Retry-After %s uses conservative fallback",
    async (value) => {
      const s = httpFixture(
        async () =>
          new Response(null, { status: 429, headers: { "Retry-After": value } }),
      );
      await expect(s.run()).rejects.toMatchObject({ retryAfter: "60" });
    },
  );
  it("excessive Retry-After is not shortened into a normal retry", async () => {
    const s = httpFixture(
      async () =>
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "999999999999999999999999" },
        }),
    );
    const e = fault(await s.run().catch((e) => e));
    expect(Number(e.retryAfter)).toBeGreaterThan(604800);
  });
  it.each([301, 302, 307])(
    "redirect %s is rejected without following",
    async (status) => {
      const s = httpFixture(
        async () =>
          new Response(null, {
            status,
            headers: { Location: "https://foreign.invalid" },
          }),
      );
      await expect(s.run()).rejects.toThrow("invalid_input");
      expect(s.http).toHaveBeenCalledTimes(1);
    },
  );
  it("content type and declared/streamed size are bounded", async () => {
    for (const r of [
      new Response("html", { headers: { "Content-Type": "text/html" } }),
      new Response("{}", {
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(OPENAI_RESPONSE_BYTES + 1),
        },
      }),
      new Response("x".repeat(OPENAI_RESPONSE_BYTES + 1), {
        headers: { "Content-Type": "application/json" },
      }),
    ]) {
      const s = httpFixture(async () => r);
      await expect(s.run()).rejects.toThrow("invalid_input");
    }
  });
  it("network rejection is sanitized and does not cause HTTP retries", async () => {
    const s = httpFixture(async () => {
      throw new Error(`PRIVATE ${secret}`);
    });
    await expect(s.run()).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: true,
    });
    expect(s.http).toHaveBeenCalledTimes(1);
  });
  it("empty stream fragments cannot cause an unbounded read loop", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(0));
      },
    });
    const s = httpFixture(
      async () =>
        new Response(stream, { headers: { "Content-Type": "application/json" } }),
    );
    await expect(s.run()).rejects.toThrow("invalid_input");
    expect(s.http).toHaveBeenCalledTimes(1);
  });
  it("the same HTTP timeout bounds stalled response bodies, not just headers", async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>({
        pull() {
          /* stalled body */
        },
      }),
      getReader = vi.spyOn(stream, "getReader");
    const s = httpFixture(
      async () =>
        new Response(stream, { headers: { "Content-Type": "application/json" } }),
    );
    const result = s.run().catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(getReader).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(OPENAI_TIMEOUT_MS + 1);
    expect(fault(await result).code).toBe("provider_timeout");
  });
  it("timeout aborts HTTP and rejects even a non-cooperative fetch", async () => {
    vi.useFakeTimers();
    const s = httpFixture(() => new Promise(() => undefined));
    const result = s.run().catch((e) => e);
    await vi.advanceTimersByTimeAsync(OPENAI_TIMEOUT_MS + 1);
    expect(await result).toMatchObject({ code: "provider_timeout" });
    expect((s.http.mock.calls[0][1]!.signal as AbortSignal).aborted).toBe(true);
    expect(s.http).toHaveBeenCalledTimes(1);
  });
  it("parent abort stops body reads; an already-aborted signal sends nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const s = httpFixture();
    await expect(s.run(text, controller.signal)).rejects.toThrow("provider_timeout");
    expect(s.http).not.toHaveBeenCalled();
    const during = new AbortController(),
      pending = httpFixture(
        async () =>
          new Response(
            new ReadableStream({
              start() {
                /* deliberately never produces bytes */
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
      );
    const result = pending.run(text, during.signal).catch((e) => e);
    await Promise.resolve();
    during.abort();
    expect(fault(await result).code).toBe("provider_timeout");
  });
});

function execution() {
  const s = httpFixture();
  const job = {
    id: id(1),
    environment: "dev",
    post_id: id(2),
    author_user_id: id(3),
    version: 1,
    target_kind: "post",
    edit_id: null,
    base_version: null,
    snapshot_text: "PRIVATE_SYNTHETIC_TEXT",
    assets: [1, 2, 3].map((i) => ({
      asset_id: id(10 + i),
      kind: "image",
      position: i - 1,
    })),
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
    defer: vi.fn(async () => "deferred" as const),
    finish: vi.fn(async (_p: ShadowFinishInput) => "finished" as ShadowFinishOutcome),
  };
  const answers = new Map<string, { data: unknown; error: unknown }>(),
    order: string[] = [];
  const rpc = vi.fn((name: string, p: Record<string, unknown>) => ({
    abortSignal: async () => {
      order.push(name);
      return (
        answers.get(name) ?? {
          data:
            name === "community_shadow_budget_reserve"
              ? { status: "reserved", reservation_id: id(5), units: p.p_units }
              : name === "community_shadow_budget_check"
                ? { status: "allowed" }
                : { status: "cooldown_active", retry_at: stamp(120), halted: false },
          error: null,
        }
      );
    },
  }));
  const budget = shadowSqlBudget({ rpc } as unknown as SupabaseClient);
  const media = {
    verify: vi.fn(async () => undefined),
    read: vi.fn(async () => Buffer.from("RIFF0000WEBPsynthetic")),
  };
  s.http.mockImplementation(async (_url, init) => {
    order.push("HTTP");
    const request = JSON.parse(init!.body as string);
    return json(response(request.input[0].type === "text" ? "text" : "image"));
  });
  const deps = {
    repository,
    media,
    budget,
    transport: s.transport,
    now: () => clock,
    random: () => 0,
  };
  return {
    ...s,
    job,
    repository,
    answers,
    rpc,
    order,
    deps,
    run: () => runShadowBatch(deps),
  };
}
describe("real adapter wired through existing SQL authority, using HTTP mock", () => {
  it("four components reserve four units once, then authorize each send and persist observations", async () => {
    const s = execution();
    const before = JSON.stringify(s.job);
    const out = await s.run();
    expect(out.mode).toBe("openai");
    expect(out.completed).toBe(1);
    expect(s.http).toHaveBeenCalledTimes(4);
    expect(
      s.rpc.mock.calls.filter(([n]) => n === "community_shadow_budget_reserve"),
    ).toEqual([
      [
        "community_shadow_budget_reserve",
        { p_job_id: s.job.id, p_claim_token: s.job.claim_token, p_units: 4 },
      ],
    ]);
    expect(
      s.rpc.mock.calls.filter(([n]) => n === "community_shadow_budget_check"),
    ).toHaveLength(4);
    expect(s.order.indexOf("HTTP")).toBeGreaterThan(
      s.order.indexOf("community_shadow_budget_reserve"),
    );
    expect(JSON.stringify(s.job)).toBe(before);
    expect(Object.keys(s.repository).sort()).toEqual([
      "acquire",
      "claim",
      "defer",
      "finish",
      "start",
    ]);
  });
  it("a mode string cannot substitute a fake budget for SQL authority", async () => {
    const s = execution();
    await expect(
      runShadowBatch({
        ...s.deps,
        budget: {
          mode: "persistent_dev",
          reserve: async () => ({ status: "reserved", reservation_id: id(5), units: 4 }),
          check: async () => ({ status: "allowed" }),
          cooldown: async () => undefined,
        },
      }),
    ).rejects.toThrow("invalid_input");
    expect(s.http).not.toHaveBeenCalled();
  });
  it("SQL reservation failure means zero external attempts", async () => {
    const s = execution();
    s.answers.set("community_shadow_budget_reserve", {
      data: null,
      error: { message: "PRIVATE" },
    });
    expect((await s.run()).persistenceErrors).toBe(1);
    expect(s.http).not.toHaveBeenCalled();
    expect(s.repository.start).not.toHaveBeenCalled();
  });
  it.each(["quota_exhausted", "cooldown_active"])(
    "%s defers without attempts or HTTP",
    async (status) => {
      const s = execution();
      s.answers.set("community_shadow_budget_reserve", {
        data: { status, retry_at: stamp(120) },
        error: null,
      });
      expect((await s.run()).deferred).toBe(1);
      expect(s.repository.start).not.toHaveBeenCalled();
      expect(s.http).not.toHaveBeenCalled();
    },
  );
  it("cooldown or SQL gate outage prevents the next component", async () => {
    for (const answer of [
      { data: { status: "cooldown_active", retry_at: stamp(120) }, error: null },
      { data: null, error: { message: "PRIVATE" } },
    ]) {
      const s = execution();
      s.http.mockImplementationOnce(async () => {
        s.answers.set("community_shadow_budget_check", answer);
        return json(response());
      });
      const out = await s.run();
      expect(out.completed).toBe(0);
      expect(s.http).toHaveBeenCalledTimes(1);
    }
  });
  it.each([401, 403])(
    "HTTP %s records credential cooldown and stops the batch",
    async (status) => {
      const s = execution();
      s.http.mockResolvedValue(new Response(null, { status }));
      const out = await s.run();
      expect(out.failed).toBe(1);
      expect(s.http).toHaveBeenCalledTimes(1);
      expect(s.rpc).toHaveBeenCalledWith("community_shadow_budget_cooldown", {
        p_retry_after_seconds: 3600,
      });
    },
  );
  it.each(["120", "5000", "604801"])(
    "429 %s persists global wait; individual retry never shortens it",
    async (value) => {
      const s = execution();
      s.http.mockResolvedValue(
        new Response(null, { status: 429, headers: { "Retry-After": value } }),
      );
      const out = await s.run();
      expect(s.rpc).toHaveBeenCalledWith("community_shadow_budget_cooldown", {
        p_retry_after_seconds: Number(value),
      });
      expect(out.completed).toBe(0);
      expect(s.http).toHaveBeenCalledTimes(1);
      const finish = s.repository.finish.mock.calls[0][0];
      expect(finish.p_state).toBe(value === "120" ? "retry_wait" : "failed");
      if (value === "120") expect(finish.p_retry_delay_seconds).toBe(120);
    },
  );
  it("429 after success preserves partial results without unsafe component replay", async () => {
    const s = execution();
    s.http
      .mockResolvedValueOnce(json())
      .mockResolvedValue(
        new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
      );
    const out = await s.run();
    expect(out.partial).toBe(1);
    expect(out.retryWait).toBe(0);
    expect(s.http).toHaveBeenCalledTimes(2);
  });
  it("lease loss or replaced token before sending results in zero HTTP calls", async () => {
    const s = execution();
    s.repository.start.mockResolvedValue("stale_claim");
    expect((await s.run()).rejected).toBe(1);
    expect(s.http).not.toHaveBeenCalled();
    const t = execution();
    t.answers.set("community_shadow_budget_check", {
      data: { status: "stale_claim" },
      error: null,
    });
    await t.run();
    expect(t.http).not.toHaveBeenCalled();
  });
  it("late finish is rejected and cannot be counted as successful", async () => {
    const s = execution();
    s.repository.finish.mockResolvedValue("obsolete");
    const out = await s.run();
    expect(out.finished).toBe(0);
    expect(out.rejected).toBe(1);
  });
  it("lease expiry during HTTP discards the late result and sends no more components", async () => {
    const s = execution();
    let time = clock;
    s.deps.now = () => time;
    s.http.mockImplementation(async () => {
      time = clock + 121000;
      return json();
    });
    const out = await s.run();
    expect(out.finished).toBe(0);
    expect(out.rejected).toBe(1);
    expect(s.http).toHaveBeenCalledTimes(1);
    expect(s.repository.finish).not.toHaveBeenCalled();
  });
  it("flagged remains an observation; no decisions or private payloads are persisted", async () => {
    const s = execution();
    s.job.assets = [];
    s.http.mockResolvedValue(json(response("text", true)));
    const out = await s.run();
    expect(out.completed).toBe(1);
    const finish = s.repository.finish.mock.calls[0][0];
    expect(finish.p_results?.[0]).toMatchObject({ flagged: true, state: "succeeded" });
    const serialized = JSON.stringify(finish);
    for (const privateValue of [secret, "PRIVATE_SYNTHETIC_TEXT", "data:image/"])
      expect(serialized).not.toContain(privateValue);
    expect(s.job.snapshot_text).toBe("PRIVATE_SYNTHETIC_TEXT");
  });
  it("video is never sent or fully evaluated", async () => {
    const s = execution();
    s.job.snapshot_text = null;
    s.job.assets = [{ asset_id: id(11), kind: "video", position: 0 }];
    const out = await s.run();
    expect(out.partial).toBe(1);
    expect(out.completed).toBe(0);
    expect(s.http).not.toHaveBeenCalled();
    expect(s.rpc).not.toHaveBeenCalled();
  });
});
