import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { submitCommunityReport } from "./moderation-client";
import { refreshCommunityContent } from "./content-freshness";
import { notifyCommunityVisibility } from "./community-visibility-sync";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: "synthetic-token" } },
      })),
    },
  },
}));
vi.mock("./content-freshness", () => ({
  refreshCommunityContent: vi.fn(async () => undefined),
}));
vi.mock("./community-visibility-sync", () => ({ notifyCommunityVisibility: vi.fn() }));
const post = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const client = new QueryClient();
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
it.each([
  ["threshold", true, false, "hidden_pending_review"],
  ["below threshold", false, false, "published"],
  ["duplicate", false, true, "published"],
  ["additional HPR", false, false, "hidden_pending_review"],
] as const)(
  "%s emits visibility refresh only for committed first quarantine",
  async (_, visibilityChanged, alreadyReported, postStatus) => {
    const response = {
      reportId: post,
      caseId: post,
      cycleId: post,
      caseVersion: 4,
      reportStatus: "open",
      distinctReporterCount: 3,
      visibilityChanged,
      alreadyReported,
      postStatus,
      postVersion: 2,
    };
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(response), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await submitCommunityReport(client, post, "spam")).toEqual(response);
    expect(notifyCommunityVisibility).toHaveBeenCalledTimes(visibilityChanged ? 1 : 0);
    expect(refreshCommunityContent).toHaveBeenCalledTimes(visibilityChanged ? 1 : 0);
    if (visibilityChanged)
      expect(refreshCommunityContent).toHaveBeenCalledWith(client, undefined, post);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      postId: post,
      reason: "spam",
    });
  },
);
it.each([401, 403, 409, 500])(
  "failed HTTP %i cannot signal a successful visibility mutation",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Safe error", code: "conflict" }), {
            status,
          }),
      ),
    );
    await expect(submitCommunityReport(client, post, "spam")).rejects.toMatchObject({
      status,
      code: "conflict",
    });
    expect(notifyCommunityVisibility).not.toHaveBeenCalled();
    expect(refreshCommunityContent).not.toHaveBeenCalled();
  },
);
it("network failure emits no signal", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("offline");
    }),
  );
  await expect(submitCommunityReport(client, post, "spam")).rejects.toThrow("offline");
  expect(notifyCommunityVisibility).not.toHaveBeenCalled();
});
it("query refresh failure preserves successful committed response", async () => {
  vi.mocked(refreshCommunityContent).mockRejectedValueOnce(new Error("offline"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ visibilityChanged: true }))),
  );
  await expect(submitCommunityReport(client, post, "spam")).resolves.toMatchObject({
    visibilityChanged: true,
  });
});
