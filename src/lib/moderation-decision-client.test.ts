import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
const fresh = vi.hoisted(() => ({ notify: vi.fn(), refresh: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { auth } }));
vi.mock("./community-visibility-sync", () => ({
  notifyCommunityVisibility: fresh.notify,
}));
vi.mock("./content-freshness", () => ({ refreshCommunityContent: fresh.refresh }));
import { decideModerationCase } from "./moderation-client";
import {
  parseGroupedDecisionInput,
  parseGroupedDecisionResult,
  groupedDecisionInputFromCase,
} from "./moderation-decision-contract";
import { parseModerationCase } from "./moderation-case-parser";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const input = {
  caseId: ID,
  cycleId: ID,
  expectedCaseVersion: 2,
  expectedPostVersion: 3,
  originalPostState: "published" as const,
  decision: "content_actioned" as const,
  resolutionMessage: " Mensaje humano ",
};
const result = {
  decisionId: ID,
  caseId: ID,
  cycleId: ID,
  postId: ID,
  decision: "content_actioned",
  caseVersion: 3,
  postStatus: "removed_pending_purge",
  postVersion: 4,
  visibilityChanged: true,
  createdAt: "2026-10-03T00:00:00Z",
};
const client = new QueryClient();
beforeEach(() => {
  vi.clearAllMocks();
  auth.getSession.mockResolvedValue({
    data: { session: { access_token: "synthetic-token" } },
  });
  fresh.refresh.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());
it("sends normalized closed contract and signals only after authoritative success", async () => {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      ...result,
      actor_user_id: ID,
      storage_key: "private",
      metadata: { reporterId: ID },
    }),
  });
  vi.stubGlobal("fetch", fetch);
  expect(await decideModerationCase(client, input)).toEqual(result);
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
    ...input,
    resolutionMessage: "Mensaje humano",
  });
  expect(fetch.mock.calls[0]![1].headers.Authorization).toBe("Bearer synthetic-token");
  expect(fresh.notify).toHaveBeenCalledOnce();
  expect(fresh.notify).toHaveBeenCalledWith(client, ID);
  expect(fresh.refresh).toHaveBeenCalledOnce();
});
it("no signal is emitted before pending response", async () => {
  let finish!: (v: unknown) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockReturnValue(
      new Promise((r) => {
        finish = r;
      }),
    ),
  );
  const pending = decideModerationCase(client, input);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(fresh.notify).not.toHaveBeenCalled();
  finish({ ok: true, json: async () => result });
  await pending;
});
it("refetch failure never turns a committed decision into failure", async () => {
  fresh.refresh.mockRejectedValue(new Error("synthetic refresh failure"));
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => result }),
  );
  expect(await decideModerationCase(client, input)).toEqual(result);
});
it("No procede without visibility change produces no broadcast", async () => {
  const r = {
    ...result,
    decision: "reports_not_valid",
    postStatus: "published",
    postVersion: 3,
    visibilityChanged: false,
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => r }));
  expect(
    await decideModerationCase(client, {
      ...input,
      decision: "reports_not_valid",
      resolutionMessage: null,
    }),
  ).toEqual(r);
  expect(fresh.notify).not.toHaveBeenCalled();
  expect(fresh.refresh).not.toHaveBeenCalled();
});
it.each([
  null,
  {},
  { ...result, caseVersion: 0 },
  { ...result, caseVersion: 2 },
  { ...result, postVersion: null },
  { ...result, postStatus: "hidden_pending_review" },
  { ...result, cycleId: "bad" },
  { ...result, createdAt: "2026-02-30T00:00:00Z" },
  { ...result, visibilityChanged: false },
])("malformed 200 rejected without success/freshness: %j", async (body) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
  await expect(decideModerationCase(client, input)).rejects.toMatchObject({
    code: "invalid_response",
  });
  expect(fresh.notify).not.toHaveBeenCalled();
});
it.each([401, 403, 409, 500])("HTTP %i does not retry or signal", async (status) => {
  const fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ error: "Controlled", code: "case_version_conflict" }),
  });
  vi.stubGlobal("fetch", fetch);
  await expect(decideModerationCase(client, input)).rejects.toMatchObject({
    status,
    code: "case_version_conflict",
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fresh.notify).not.toHaveBeenCalled();
});
it("Unicode normalization counts codepoints rather than UTF-16 units", () => {
  expect(
    parseGroupedDecisionInput({
      ...input,
      resolutionMessage: "\uFEFF" + "😀".repeat(1000) + "\u00a0",
    }).resolutionMessage,
  ).toBe("😀".repeat(1000));
  expect(() =>
    parseGroupedDecisionInput({ ...input, resolutionMessage: "😀".repeat(1001) }),
  ).toThrow();
  expect(() =>
    parseGroupedDecisionInput({ ...input, resolutionMessage: " \n\t" }),
  ).toThrow("resolution_message_required");
});
it("deleted-post result is valid only for no-consequence closure", () => {
  expect(
    parseGroupedDecisionResult(
      {
        ...result,
        decision: "reports_not_valid",
        postStatus: null,
        postVersion: null,
        visibilityChanged: false,
      },
      {
        ...input,
        decision: "reports_not_valid",
        expectedPostVersion: null,
        originalPostState: null,
        resolutionMessage: null,
      },
    ).postStatus,
  ).toBeNull();
  expect(() =>
    parseGroupedDecisionResult({ ...result, postStatus: null, postVersion: null }, input),
  ).toThrow();
});
it.each([1, 2147483646])("int4 input boundary %i accepted", (version) => {
  expect(
    parseGroupedDecisionInput({
      ...input,
      expectedCaseVersion: version,
      expectedPostVersion: version,
    }).expectedPostVersion,
  ).toBe(version);
});
it.each([2147483647, 2147483648, 0, -1, 1.5, NaN, "1", null])(
  "invalid int4 %j never reaches HTTP",
  async (version) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      decideModerationCase(client, { ...input, expectedCaseVersion: version as number }),
    ).rejects.toThrow();
    if (version !== null)
      await expect(
        decideModerationCase(client, {
          ...input,
          expectedPostVersion: version as number,
        }),
      ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each([
  { ...result, postVersion: 3 },
  { ...result, postVersion: 5 },
  { ...result, postVersion: 2147483648 },
  {
    ...result,
    decision: "reports_not_valid",
    postStatus: "hidden",
    visibilityChanged: true,
  },
  {
    ...result,
    decision: "reports_not_valid",
    postStatus: "published",
    visibilityChanged: false,
  },
])("contradictory result never emits freshness %j", async (body) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
  const request =
    body.decision === "reports_not_valid"
      ? { ...input, decision: "reports_not_valid" as const, resolutionMessage: null }
      : input;
  await expect(decideModerationCase(client, request)).rejects.toMatchObject({
    code: "invalid_response",
  });
  expect(fresh.notify).not.toHaveBeenCalled();
  expect(fresh.refresh).not.toHaveBeenCalled();
});
it.each([
  { expectedPostVersion: 3, postStatus: null, postVersion: null },
  { expectedPostVersion: null, postStatus: "published", postVersion: 3 },
])("live/deleted input and result cannot disagree %j", async (state) => {
  const { expectedPostVersion, postStatus, postVersion } = state;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...result,
        decision: "reports_not_valid",
        visibilityChanged: false,
        postStatus,
        postVersion,
      }),
    }),
  );
  await expect(
    decideModerationCase(client, {
      ...input,
      expectedPostVersion,
      decision: "reports_not_valid",
      resolutionMessage: null,
      originalPostState: expectedPostVersion === null ? null : "published",
    }),
  ).rejects.toMatchObject({ code: "invalid_response" });
  expect(fresh.notify).not.toHaveBeenCalled();
  expect(fresh.refresh).not.toHaveBeenCalled();
});
it.each([
  {
    decision: "reports_not_valid",
    postStatus: "published",
    postVersion: 4,
    visibilityChanged: true,
    expectedPostVersion: 3,
    originalPostState: "hidden_pending_review",
  },
  {
    decision: "reports_not_valid",
    postStatus: "hidden",
    postVersion: 3,
    visibilityChanged: false,
    expectedPostVersion: 3,
    originalPostState: "hidden",
  },
  {
    decision: "reports_not_valid",
    postStatus: null,
    postVersion: null,
    visibilityChanged: false,
    expectedPostVersion: null,
    originalPostState: null,
  },
])("valid No procede relationship %j", async (state) => {
  const { expectedPostVersion, originalPostState, ...projection } = state;
  const response = { ...result, ...projection };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => response }),
  );
  expect(
    await decideModerationCase(client, {
      ...input,
      decision: "reports_not_valid",
      resolutionMessage: null,
      expectedPostVersion,
      originalPostState: originalPostState as "hidden_pending_review" | "hidden" | null,
    }),
  ).toEqual(response);
  expect(fresh.notify).toHaveBeenCalledTimes(state.visibilityChanged ? 1 : 0);
});
it("R3 decision field is additive but not an unchecked nested object", () => {
  expect(() =>
    parseModerationCase({ decision: { result: "content_actioned" } }),
  ).toThrow();
});

const transitions = [
  {
    origin: "published",
    decision: "reports_not_valid",
    status: "published",
    version: 3,
    changed: false,
  },
  {
    origin: "hidden_pending_review",
    decision: "reports_not_valid",
    status: "published",
    version: 4,
    changed: true,
  },
  {
    origin: "hidden",
    decision: "reports_not_valid",
    status: "hidden",
    version: 3,
    changed: false,
  },
  {
    origin: null,
    decision: "reports_not_valid",
    status: null,
    version: null,
    changed: false,
  },
  ...["published", "hidden_pending_review", "hidden"].map((origin) => ({
    origin,
    decision: "content_actioned",
    status: "removed_pending_purge",
    version: 4,
    changed: true,
  })),
] as const;
it.each(transitions)("original-context valid transition %j", async (t) => {
  const request = {
    ...input,
    originalPostState: t.origin as
      "published" | "hidden_pending_review" | "hidden" | null,
    decision: t.decision as "reports_not_valid" | "content_actioned",
    expectedPostVersion: t.origin === null ? null : 3,
    resolutionMessage: t.decision === "content_actioned" ? "Reason" : null,
  };
  const response = {
    ...result,
    decision: t.decision,
    postStatus: t.status,
    postVersion: t.version,
    visibilityChanged: t.changed,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => response }),
  );
  expect(await decideModerationCase(client, request)).toEqual(response);
  expect(fresh.notify).toHaveBeenCalledTimes(t.changed ? 1 : 0);
  expect(fresh.refresh).toHaveBeenCalledTimes(t.changed ? 1 : 0);
});
it.each(transitions)(
  "original-context contradictory responses fail closed %j",
  async (t) => {
    const request = {
      ...input,
      originalPostState: t.origin as
        "published" | "hidden_pending_review" | "hidden" | null,
      decision: t.decision as "reports_not_valid" | "content_actioned",
      expectedPostVersion: t.origin === null ? null : 3,
      resolutionMessage: t.decision === "content_actioned" ? "Reason" : null,
    };
    const response = {
      ...result,
      decision: t.decision,
      postStatus: t.status,
      postVersion: t.version,
      visibilityChanged: t.changed,
    };
    const wrongStates = [
      null,
      "published",
      "hidden_pending_review",
      "hidden",
      "removed_pending_purge",
    ]
      .filter((s) => s !== t.status)
      .map((postStatus) => ({ ...response, postStatus }));
    const wrong = [
      ...wrongStates,
      { ...response, visibilityChanged: !t.changed },
      { ...response, postVersion: t.version === null ? 3 : t.version + 1 },
      { ...response, postVersion: t.version === null ? 3 : t.version - 1 },
      { ...response, caseVersion: 2 },
      {
        ...response,
        postStatus: "published",
        postVersion: t.origin === "published" ? 4 : 3,
        visibilityChanged: t.origin === "published",
      },
    ];
    for (const body of wrong) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: async () => body }),
      );
      await expect(decideModerationCase(client, request)).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
    expect(fresh.notify).not.toHaveBeenCalled();
    expect(fresh.refresh).not.toHaveBeenCalled();
  },
);
it.each(["published", "hidden_pending_review", "hidden", null] as const)(
  "transition-specific overflow %s",
  (origin) => {
    const request = {
      ...input,
      originalPostState: origin,
      expectedCaseVersion: 2147483646,
      expectedPostVersion: origin === null ? null : 2147483646,
      decision: "reports_not_valid" as const,
      resolutionMessage: null,
    };
    expect(parseGroupedDecisionInput(request)).toMatchObject({
      expectedCaseVersion: 2147483646,
    });
    expect(() =>
      parseGroupedDecisionInput({ ...request, expectedCaseVersion: 2147483647 }),
    ).toThrow();
    if (origin === "hidden_pending_review")
      expect(() =>
        parseGroupedDecisionInput({ ...request, expectedPostVersion: 2147483647 }),
      ).toThrow();
    else if (origin !== null)
      expect(
        parseGroupedDecisionInput({ ...request, expectedPostVersion: 2147483647 })
          .expectedPostVersion,
      ).toBe(2147483647);
    if (origin !== null)
      expect(() =>
        parseGroupedDecisionInput({
          ...request,
          decision: "content_actioned",
          resolutionMessage: "Reason",
          expectedPostVersion: 2147483647,
        }),
      ).toThrow();
    else
      expect(() =>
        parseGroupedDecisionInput({
          ...request,
          decision: "content_actioned",
          resolutionMessage: "Reason",
        }),
      ).toThrow();
  },
);
it("missing or mismatched original context never reaches HTTP", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  for (const originalPostState of [undefined, "removed_pending_purge", null])
    await expect(
      decideModerationCase(client, { ...input, originalPostState } as never),
    ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("constructs a stable request snapshot from the exact validated R3 item", () => {
  const item = {
    caseId: ID,
    cycleId: ID,
    caseVersion: 2,
    post: {
      text: "Evidence",
      status: "hidden_pending_review" as const,
      version: 3,
      updatedAt: "2026-10-03T00:00:00Z",
      authorUsername: null,
      quarantineCycleId: ID,
    },
  };
  const request = groupedDecisionInputFromCase(item, "reports_not_valid");
  expect(request).toMatchObject({
    caseId: ID,
    cycleId: ID,
    expectedCaseVersion: 2,
    expectedPostVersion: 3,
    originalPostState: "hidden_pending_review",
  });
  item.post.version = 4;
  item.caseVersion = 3;
  expect(request.expectedPostVersion).toBe(3);
  expect(request.expectedCaseVersion).toBe(2);
  expect(
    groupedDecisionInputFromCase({ ...item, post: null }, "reports_not_valid"),
  ).toMatchObject({ originalPostState: null, expectedPostVersion: null });
});

it.each(["published", "hidden_pending_review", "hidden"] as const)(
  "int4 maximum output remains valid for %s",
  (origin) => {
    const request = {
      ...input,
      originalPostState: origin,
      expectedCaseVersion: 2147483646,
      expectedPostVersion: origin === "hidden_pending_review" ? 2147483646 : 2147483647,
      decision: "reports_not_valid" as const,
      resolutionMessage: null,
    };
    const response = {
      ...result,
      decision: "reports_not_valid",
      caseVersion: 2147483647,
      postStatus: origin === "hidden_pending_review" ? "published" : origin,
      postVersion: 2147483647,
      visibilityChanged: origin === "hidden_pending_review",
    };
    expect(parseGroupedDecisionResult(response, request)).toEqual(response);
  },
);
it("a pending request keeps its original context even if caller context changes", async () => {
  const request = {
    ...input,
    decision: "reports_not_valid" as const,
    resolutionMessage: null,
  };
  let finish!: (value: unknown) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    ),
  );
  const pending = decideModerationCase(client, request);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  request.originalPostState = "hidden_pending_review" as typeof request.originalPostState;
  request.expectedPostVersion = 4;
  finish({
    ok: true,
    json: async () => ({
      ...result,
      decision: "reports_not_valid",
      postStatus: "published",
      postVersion: 4,
      visibilityChanged: true,
    }),
  });
  await expect(pending).rejects.toMatchObject({ code: "invalid_response" });
  expect(fresh.notify).not.toHaveBeenCalled();
  expect(fresh.refresh).not.toHaveBeenCalled();
});

describeSnapshotStrictNullability();
function describeSnapshotStrictNullability() {
  const snapshot = { caseId: ID, cycleId: ID, caseVersion: 2 };
  const malformed = [
    snapshot,
    { ...snapshot, post: undefined },
    { ...snapshot, post: {} },
    { ...snapshot, post: { version: 3 } },
    { ...snapshot, post: { status: "published" } },
    { ...snapshot, post: { status: undefined, version: 3 } },
    { ...snapshot, post: { status: "published", version: undefined } },
    { ...snapshot, post: { status: null, version: 3 } },
    { ...snapshot, post: { status: "published", version: null } },
    { ...snapshot, post: { status: "invalid", version: 3 } },
    { ...snapshot, post: { status: "removed_pending_purge", version: 3 } },
    ...[0, -1, 1.5, NaN, Infinity, "3"].map((version) => ({
      ...snapshot,
      post: { status: "published", version },
    })),
  ];
  it.each(malformed)(
    "malformed snapshot fails construction for both decisions %j",
    async (item) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      for (const decision of ["reports_not_valid", "content_actioned"] as const) {
        const submit = async () =>
          decideModerationCase(
            client,
            groupedDecisionInputFromCase(
              item as never,
              decision,
              decision === "content_actioned" ? "Reason" : null,
            ),
          );
        await expect(submit()).rejects.toThrow();
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(fresh.notify).not.toHaveBeenCalled();
      expect(fresh.refresh).not.toHaveBeenCalled();
    },
  );
  it.each(["published", "hidden_pending_review", "hidden"] as const)(
    "explicit live snapshot %s valid",
    (status) => {
      expect(
        groupedDecisionInputFromCase(
          { ...snapshot, post: { status, version: 3 } } as never,
          "reports_not_valid",
        ),
      ).toMatchObject({ originalPostState: status, expectedPostVersion: 3 });
    },
  );
  it("only explicit null creates a deleted snapshot; Procede still rejects", () => {
    expect(
      groupedDecisionInputFromCase({ ...snapshot, post: null }, "reports_not_valid"),
    ).toMatchObject({ originalPostState: null, expectedPostVersion: null });
    expect(() =>
      groupedDecisionInputFromCase(
        { ...snapshot, post: null },
        "content_actioned",
        "Reason",
      ),
    ).toThrow();
  });
  it.each(["published", "hidden_pending_review", "hidden"] as const)(
    "constructor retains transition-specific int4 headroom for %s",
    (status) => {
      const item = {
        ...snapshot,
        caseVersion: 2147483646,
        post: { status, version: 2147483646 },
      };
      expect(
        groupedDecisionInputFromCase(item as never, "content_actioned", "Reason")
          .expectedPostVersion,
      ).toBe(2147483646);
      expect(() =>
        groupedDecisionInputFromCase(
          { ...item, caseVersion: 2147483647 } as never,
          "reports_not_valid",
        ),
      ).toThrow();
      const max = { ...item, post: { status, version: 2147483647 } };
      expect(() =>
        groupedDecisionInputFromCase(max as never, "content_actioned", "Reason"),
      ).toThrow();
      if (status === "hidden_pending_review")
        expect(() =>
          groupedDecisionInputFromCase(max as never, "reports_not_valid"),
        ).toThrow();
      else
        expect(
          groupedDecisionInputFromCase(max as never, "reports_not_valid")
            .expectedPostVersion,
        ).toBe(2147483647);
    },
  );
}
