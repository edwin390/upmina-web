// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseModerationCase } from "./moderation-case-parser";

// R4-E4: el parser del read model acepta la acción histórica post_purged y post: null, rechaza
// acciones realmente desconocidas y nunca reenvía campos no incluidos en el allowlist.

const id = (k: number, n = 1) =>
  `${String(k).repeat(8)}-1111-4111-8111-${String(n).padStart(12, "0")}`;
const states = {
  fromPostStatus: null,
  toPostStatus: null,
  fromReportStatus: null,
  toReportStatus: null,
};
const raw = (over: Record<string, unknown> = {}) => ({
  caseId: id(1),
  caseVersion: 4,
  postId: id(2),
  cycleId: id(3),
  currentCycleId: id(3),
  cycleNumber: 1,
  currentCycleNumber: 1,
  isCurrentCycle: true,
  caseStatus: "closed",
  cycleStatus: "closed",
  closureKind: "decision",
  createdAt: "2026-10-01T00:00:00Z",
  openedAt: "2026-10-01T00:00:00Z",
  closedAt: "2026-10-02T00:00:00Z",
  activityAt: "2026-10-02T00:00:00Z",
  firstReportAt: "2026-10-01T00:00:00Z",
  lastReportAt: "2026-10-01T00:00:00Z",
  totalReports: 3,
  qualifyingReporters: 0,
  reasons: [{ reason: "spam", count: 3 }],
  reportsTruncated: false,
  post: null,
  decision: {
    decisionId: id(5),
    result: "content_actioned",
    resolutionMessage: "Mensaje del moderador",
    createdAt: "2026-10-02T00:00:00Z",
  },
  reports: [],
  media: [],
  audit: [
    {
      id: id(6),
      action: "post_purged",
      actorKind: "system",
      createdAt: "2026-10-05T00:00:00Z",
      states,
    },
  ],
  ...over,
});

describe("moderation case parser — purged history", () => {
  it("accepts post: null together with the post_purged system action", () => {
    const parsed = parseModerationCase(raw());
    expect(parsed.post).toBeNull();
    expect(parsed.audit).toEqual([
      expect.objectContaining({ action: "post_purged", actorKind: "system" }),
    ]);
    expect(parsed.decision?.resolutionMessage).toBe("Mensaje del moderador");
  });
  it("accepts an expired removed post whose text is null and whose media is empty", () => {
    const parsed = parseModerationCase(
      raw({
        post: {
          text: null,
          status: "removed_pending_purge",
          version: 5,
          updatedAt: "2026-10-02T00:00:00Z",
          authorUsername: null,
          quarantineCycleId: null,
          removalDecisionId: id(5),
          removedAt: "2026-10-02T00:00:00Z",
          purgeAfter: "2026-10-05T00:00:00Z",
        },
        audit: [],
      }),
    );
    expect(parsed.post).toMatchObject({ text: null, status: "removed_pending_purge" });
    expect(parsed.media).toEqual([]);
  });
  it("still rejects genuinely unknown audit actions (closed allowlist)", () => {
    const bad = raw();
    (bad.audit[0] as { action: string }).action = "post_purged_v2";
    expect(() => parseModerationCase(bad)).toThrow();
    (bad.audit[0] as { action: string }).action = "";
    expect(() => parseModerationCase(bad)).toThrow();
  });
  it("never forwards raw audit metadata or unknown fields", () => {
    const extra = raw();
    Object.assign(extra.audit[0], {
      metadata: { post_id: id(2), removal_decision_id: id(5), assets_marked: 3 },
      reporterUserId: id(9),
    });
    Object.assign(extra, { reporterEmail: "reporter@example.test" });
    const json = JSON.stringify(parseModerationCase(extra));
    expect(json).not.toMatch(
      /assets_marked|removal_decision_id|reporter@example|metadata/,
    );
    expect(json).not.toContain(id(9));
  });
  it("a malformed post (missing status/version) is rejected, never rendered as content", () => {
    expect(() =>
      parseModerationCase(raw({ post: { text: "texto filtrado" } })),
    ).toThrow();
    expect(() => parseModerationCase(raw({ post: "texto filtrado" }))).toThrow();
  });
  it("post.text must be a string or null (never an object/number as content)", () => {
    const post = (text: unknown) => ({
      text,
      status: "published",
      version: 1,
      updatedAt: "2026-10-02T00:00:00Z",
      authorUsername: null,
      quarantineCycleId: null,
    });
    expect(() => parseModerationCase(raw({ post: post({ a: 1 }) }))).toThrow();
    expect(() => parseModerationCase(raw({ post: post(5) }))).toThrow();
    expect(parseModerationCase(raw({ post: post(null) })).post?.text).toBeNull();
  });
});
