import { beforeEach, afterEach, it, expect, vi } from "vitest";
const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { auth } }));
const fresh = vi.hoisted(() => ({ notify: vi.fn(), refresh: vi.fn() }));
vi.mock("./community-visibility-sync", () => ({
  notifyCommunityVisibility: fresh.notify,
}));
vi.mock("./content-freshness", () => ({ refreshCommunityContent: fresh.refresh }));
import {
  fetchModerationCase,
  fetchModerationCasePage,
  ModerationClientError,
} from "./moderation-client";
beforeEach(() => {
  auth.getSession.mockResolvedValue({
    data: { session: { access_token: "synthetic-token" } },
  });
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
it("reads grouped queue/cursor with current Bearer token, no-store and AbortSignal", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ cases: [], nextCursor: null }) });
  vi.stubGlobal("fetch", fetch);
  const c = new AbortController();
  expect(await fetchModerationCasePage("closed", "opaque", c.signal)).toEqual({
    cases: [],
    nextCursor: null,
  });
  expect(fetch).toHaveBeenCalledWith(
    "/api/admin/moderation-cases?scope=closed&cursor=opaque",
    {
      headers: { Authorization: "Bearer synthetic-token" },
      cache: "no-store",
      signal: c.signal,
    },
  );
  expect(fresh.notify).not.toHaveBeenCalled();
  expect(fresh.refresh).not.toHaveBeenCalled();
});
it("detail uses cycle identity and does not produce visibility signals", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ item: validCase() }) });
  vi.stubGlobal("fetch", fetch);
  expect(await fetchModerationCase(ID)).toEqual(validCase());
  expect(fetch.mock.calls[0]![0]).toBe(`/api/admin/moderation-cases?cycleId=${ID}`);
  expect(fresh.notify).not.toHaveBeenCalled();
});
it.each([401, 403, 404, 500])(
  "preserves machine-readable read failure %i",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status,
        json: async () => ({ error: "safe", code: "step_up_required" }),
      }),
    );
    await expect(fetchModerationCase("one")).rejects.toMatchObject({
      status,
      code: "step_up_required",
    });
    expect(fresh.notify).not.toHaveBeenCalled();
  },
);
it("missing session prevents HTTP read", async () => {
  auth.getSession.mockResolvedValue({ data: { session: null } });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(fetchModerationCasePage("active", null)).rejects.toBeInstanceOf(
    ModerationClientError,
  );
  expect(fetch).not.toHaveBeenCalled();
});

const ID = "11111111-1111-4111-8111-111111111111";
const time = "2026-10-01T00:00:00.123456+00:00";
function validCase() {
  return {
    caseId: ID,
    postId: ID,
    cycleId: ID,
    currentCycleId: ID,
    caseVersion: 1,
    cycleNumber: 1,
    currentCycleNumber: 1,
    caseStatus: "pending",
    cycleStatus: "pending",
    closureKind: null,
    isCurrentCycle: true,
    createdAt: time,
    openedAt: time,
    activityAt: time,
    closedAt: null,
    firstReportAt: null,
    lastReportAt: null,
    post: null,
    totalReports: 1,
    qualifyingReporters: 1,
    reasons: [{ reason: "spam", count: 1 }],
    reports: [
      {
        reportId: ID,
        reason: "spam",
        detail: null,
        status: "open",
        version: 1,
        createdAt: time,
      },
    ],
    reportsTruncated: false,
    media: [],
    audit: [],
  };
}

const media = {
  id: ID,
  position: 0,
  kind: "image",
  url: "https://media.synthetic.example/image",
  width: 640,
  height: 480,
  durationSeconds: null,
};
const audit = {
  id: ID,
  action: "post_hidden",
  actorKind: "human",
  createdAt: time,
  states: {
    fromPostStatus: "published",
    toPostStatus: "hidden",
    fromReportStatus: null,
    toReportStatus: null,
  },
};
const queueInvalid: [string, unknown][] = [
  ["null", null],
  ["cases null", { cases: null, nextCursor: null }],
  ["cases object", { cases: {}, nextCursor: null }],
  ["missing cases", { nextCursor: null }],
  ["bad case", { cases: [null], nextCursor: null }],
  ["21 cases", { cases: Array.from({ length: 21 }, validCase), nextCursor: null }],
  ["pagination missing", { cases: [] }],
  ["pagination number", { cases: [], nextCursor: 1 }],
  ["cursor malformed", { cases: [], nextCursor: "not-a-cursor" }],
];
it.each(queueInvalid)(
  "queue rejects %s as controlled invalid_response",
  async (_, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => body }),
    );
    await expect(fetchModerationCasePage("active", null)).rejects.toMatchObject({
      code: "invalid_response",
    });
  },
);
const invalidFields: [string, unknown][] = [
  ["cycleId", undefined],
  ["caseId", "bad"],
  ["caseVersion", 0],
  ["cycleNumber", 1.5],
  ["caseStatus", "bogus"],
  ["reasons", undefined],
  ["reasons", {}],
  ["reasons", [{ reason: "bogus", count: 1 }]],
  ["reasons", [{ reason: "spam", count: 0 }]],
  ["totalReports", -1],
  ["qualifyingReporters", 2],
  ["createdAt", "invalid"],
  ["openedAt", "2026-02-30T00:00:00Z"],
  ["post", {}],
];
it.each(invalidFields)("queue rejects malformed field %s (%j)", async (field, value) => {
  const item = { ...validCase(), [field]: value };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ cases: [item], nextCursor: null }),
    }),
  );
  await expect(fetchModerationCasePage("active", null)).rejects.toMatchObject({
    code: "invalid_response",
  });
});
const invalidDetail: [string, unknown][] = [
  ["reports", undefined],
  ["reports", {}],
  ["reports", Array(51).fill(validCase().reports[0])],
  ["reports", [{}]],
  ["reports", [{ ...validCase().reports[0], reason: "unknown" }]],
  ["reports", [{ ...validCase().reports[0], createdAt: "bad" }]],
  ["media", {}],
  ["media", Array(11).fill(media)],
  ["media", [{}]],
  ["media", [{ ...media, url: "javascript:alert(1)" }]],
  ["media", [{ ...media, width: 0 }]],
  ["media", [{ ...media, kind: "audio" }]],
  ["audit", {}],
  ["audit", Array(21).fill(audit)],
  ["audit", [{}]],
  ["audit", [{ ...audit, createdAt: "bad" }]],
  ["audit", [{ ...audit, actorKind: "unknown" }]],
  ["audit", [{ ...audit, states: { ...audit.states, toPostStatus: "bogus" } }]],
  ["activityAt", "bad"],
  ["post", {}],
  ["reportsTruncated", 1],
];
it.each(invalidDetail)("detail rejects %s (%j)", async (field, value) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ item: { ...validCase(), [field]: value } }),
    }),
  );
  await expect(fetchModerationCase(ID)).rejects.toMatchObject({
    code: "invalid_response",
  });
});
it("incomplete successful detail and invalid JSON fail controlled", async () => {
  for (const body of [{ item: { cycleId: ID } }, null]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => body }),
    );
    await expect(fetchModerationCase(ID)).rejects.toMatchObject({
      code: "invalid_response",
    });
  }
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("private raw body");
      },
    }),
  );
  await expect(fetchModerationCase(ID)).rejects.toMatchObject({
    code: "invalid_response",
    message: "No se pudo cargar el caso",
  });
});
it("complete queue/detail preserve valid dates and strip private extra fields", async () => {
  const item = {
    ...validCase(),
    post: {
      text: "text",
      status: "published",
      version: 1,
      updatedAt: time,
      authorUsername: null,
      quarantineCycleId: null,
      email: "private",
    },
    media: [{ ...media, storage_key: "private" }],
    audit: [{ ...audit, actor_user_id: ID, metadata: { secret: true } }],
    reporter_user_id: ID,
  };
  const cursor = btoa(time + "|" + ID).replace(/=/g, "");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ cases: [item], nextCursor: cursor, email: "private" }),
    }),
  );
  const page = await fetchModerationCasePage("active", null);
  expect(page.nextCursor).toBe(cursor);
  expect(page.cases[0].createdAt).toBe(time);
  expect(JSON.stringify(page)).not.toMatch(
    /email|reporter_user_id|actor_user_id|storage_key|metadata/,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ item }) }),
  );
  expect(await fetchModerationCase(ID)).toEqual(page.cases[0]);
});
