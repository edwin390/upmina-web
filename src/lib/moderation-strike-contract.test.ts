// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  normalizeStrikeReason,
  parseModerationStrikeState,
  parseStrikeApplyResponse,
  parseStrikeRevokeResponse,
  parseStrikeApplyInput,
  parseStrikeRevokeInput,
  projectStrikeApplyResult,
  projectStrikeRevokeResult,
  projectStrikeStateRead,
} from "./moderation-strike-contract";
import { parseModerationCase } from "./moderation-case-parser";

const id = (n: number) => `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = "2026-10-06T10:00:00+00:00";
const T1 = "2026-10-20T10:00:00+00:00";

describe("strike input validation (strict, minimal, product-consistent Unicode)", () => {
  it("apply: accepts only {decisionId, reason, expectedLevel?}", () => {
    expect(parseStrikeApplyInput({ decisionId: id(1), reason: "  motivo  " })).toEqual({
      ok: true,
      value: { decisionId: id(1), reason: "motivo", expectedLevel: null },
    });
    expect(
      parseStrikeApplyInput({ decisionId: id(1), reason: "m", expectedLevel: 2 }),
    ).toMatchObject({
      ok: true,
      value: { expectedLevel: 2 },
    });
    expect(
      parseStrikeApplyInput({ decisionId: id(1), reason: "m", expectedLevel: null }),
    ).toMatchObject({ ok: true });
  });
  it.each([
    "userId",
    "caseId",
    "cycleId",
    "postId",
    "level",
    "startsAt",
    "endsAt",
    "permanent",
    "actorUserId",
    "actor",
  ])("apply rejects the caller-supplied field %s", (field) => {
    expect(
      parseStrikeApplyInput({ decisionId: id(1), reason: "m", [field]: id(2) }),
    ).toEqual({ ok: false, code: "validation" });
  });
  it.each([undefined, null, "x", 5, [], [{}]])(
    "apply rejects a non-object body %j",
    (body) => {
      expect(parseStrikeApplyInput(body)).toEqual({ ok: false, code: "validation" });
    },
  );
  it.each(["not-a-uuid", "", 5, null, undefined, id(1).toUpperCase().slice(1)])(
    "apply rejects decisionId %j",
    (decisionId) => {
      expect(parseStrikeApplyInput({ decisionId, reason: "m" })).toEqual({
        ok: false,
        code: "validation",
      });
    },
  );
  it.each(["2", 0, 4, 1.5, -1, true, NaN, {}])(
    "apply rejects expectedLevel %j",
    (expectedLevel) => {
      expect(
        parseStrikeApplyInput({ decisionId: id(1), reason: "m", expectedLevel }),
      ).toEqual({ ok: false, code: "validation" });
    },
  );
  it.each([
    [undefined, "validation"],
    [null, "validation"],
    [5, "validation"],
    ["", "reason_required"],
    ["   ", "reason_required"],
    ["\u00a0\u2003\t\n\ufeff", "reason_required"],
  ])("reason %j is rejected as %s", (reason, code) => {
    expect(normalizeStrikeReason(reason)).toEqual({ ok: false, code });
  });
  it("reason length counts Unicode code points (not bytes or UTF-16 units)", () => {
    expect(normalizeStrikeReason("😀".repeat(1000))).toMatchObject({ ok: true });
    expect(normalizeStrikeReason("😀".repeat(1001))).toEqual({
      ok: false,
      code: "validation",
    });
    expect(normalizeStrikeReason("a".repeat(1000))).toMatchObject({ ok: true });
    expect(normalizeStrikeReason("a".repeat(1001))).toEqual({
      ok: false,
      code: "validation",
    });
    // trimming happens BEFORE the length check, with the same set as the DB
    expect(normalizeStrikeReason(`\u00a0${"a".repeat(1000)}\u2003`)).toMatchObject({
      ok: true,
      value: "a".repeat(1000),
    });
  });
  it("revoke: accepts only {strikeId, reason}", () => {
    expect(parseStrikeRevokeInput({ strikeId: id(3), reason: " error " })).toEqual({
      ok: true,
      value: { strikeId: id(3), reason: "error" },
    });
    for (const extra of [
      "userId",
      "decisionId",
      "level",
      "endsAt",
      "revokerId",
      "actorUserId",
    ])
      expect(
        parseStrikeRevokeInput({ strikeId: id(3), reason: "m", [extra]: id(1) }),
      ).toEqual({ ok: false, code: "validation" });
    expect(parseStrikeRevokeInput({ strikeId: "x", reason: "m" })).toEqual({
      ok: false,
      code: "validation",
    });
    expect(parseStrikeRevokeInput({ strikeId: id(3), reason: " " })).toEqual({
      ok: false,
      code: "reason_required",
    });
  });
});

describe("mutation response projection", () => {
  it("apply: only product-safe fields; shape violations throw", () => {
    const raw = {
      strikeId: id(5),
      decisionId: id(6),
      caseId: id(7),
      level: 2,
      permanent: false,
      startsAt: T0,
      endsAt: T1,
    };
    const out = projectStrikeApplyResult(raw, "motivo");
    expect(out).toEqual({
      strike: {
        id: id(5),
        decisionId: id(6),
        level: 2,
        reason: "motivo",
        permanent: false,
        startsAt: T0,
        endsAt: T1,
        revoked: false,
        sanctionInEffect: true,
      },
    });
    expect(JSON.stringify(out)).not.toContain(id(7)); // case id never forwarded
    expect(() => projectStrikeApplyResult({ ...raw, level: 4 }, "m")).toThrow();
    expect(() => projectStrikeApplyResult({ ...raw, permanent: true }, "m")).toThrow(); // level 2 cannot be permanent
    expect(() =>
      projectStrikeApplyResult({ ...raw, level: 3, permanent: true }, "m"),
    ).toThrow(); // permanent needs null end
    expect(() => projectStrikeApplyResult({ ...raw, startsAt: "ayer" }, "m")).toThrow();
    expect(() => projectStrikeApplyResult(null, "m")).toThrow();
    expect(
      projectStrikeApplyResult({ ...raw, level: 3, permanent: true, endsAt: null }, "m")
        .strike.endsAt,
    ).toBeNull();
  });
  it("revoke: only id, level, revoked, revokedAt", () => {
    expect(
      projectStrikeRevokeResult({ strikeId: id(5), level: 1, revokedAt: T1, extra: "x" }),
    ).toEqual({
      strike: { id: id(5), level: 1, revoked: true, revokedAt: T1 },
    });
    expect(() =>
      projectStrikeRevokeResult({ strikeId: id(5), level: 9, revokedAt: T1 }),
    ).toThrow();
    expect(() =>
      projectStrikeRevokeResult({ strikeId: "x", level: 1, revokedAt: T1 }),
    ).toThrow();
  });
});

describe("strike state block (R5-B read → safe projection)", () => {
  const eligible = {
    hasDecision: true,
    decisionId: id(6),
    eligible: true,
    ineligibleReason: null,
    nextLevel: 2,
    strike: null,
    canRevoke: false,
    serverNow: T0,
  };
  const strike = (over: Record<string, unknown> = {}) => ({
    strikeId: id(5),
    level: 1,
    reason: "motivo",
    permanent: false,
    startsAt: T0,
    endsAt: T1,
    createdAt: T0,
    status: "active",
    sanctionInEffect: true,
    revokedAt: null,
    revocationReason: null,
    ...over,
  });
  const withStrike = (s: unknown, canRevoke = true) => ({
    hasDecision: true,
    decisionId: id(6),
    eligible: false,
    ineligibleReason: "strike_already_issued",
    nextLevel: null,
    strike: s,
    canRevoke,
    serverNow: T0,
  });
  it("eligible Procede without a strike", () => {
    expect(projectStrikeStateRead(eligible)).toEqual({
      eligible: true,
      ineligibleReason: null,
      predictedLevel: 2,
      decisionId: id(6),
      existing: null,
    });
  });
  it("open case / No procede: not eligible, nothing to apply", () => {
    expect(
      projectStrikeStateRead({
        hasDecision: false,
        eligible: false,
        ineligibleReason: "decision_not_content_actioned",
        nextLevel: null,
        strike: null,
        canRevoke: false,
        serverNow: T0,
      }),
    ).toEqual({
      eligible: false,
      ineligibleReason: "decision_not_content_actioned",
      predictedLevel: null,
      decisionId: null,
      existing: null,
    });
  });
  it("active, expired, permanent and revoked strikes", () => {
    const active = projectStrikeStateRead(withStrike(strike()));
    expect(active.existing).toMatchObject({
      id: id(5),
      level: 1,
      revoked: false,
      sanctionInEffect: true,
      canRevoke: true,
      endsAt: T1,
    });
    const expired = projectStrikeStateRead(
      withStrike(strike({ sanctionInEffect: false })),
    );
    expect(expired.existing).toMatchObject({ revoked: false, sanctionInEffect: false });
    const permanent = projectStrikeStateRead(
      withStrike(strike({ level: 3, permanent: true, endsAt: null })),
    );
    expect(permanent.existing).toMatchObject({ level: 3, permanent: true, endsAt: null });
    const revoked = projectStrikeStateRead(
      withStrike(
        strike({
          status: "revoked",
          sanctionInEffect: false,
          revokedAt: T1,
          revocationReason: "error",
        }),
        false,
      ),
    );
    expect(revoked.existing).toMatchObject({
      revoked: true,
      revokedAt: T1,
      revocationReason: "error",
      canRevoke: false,
    });
  });
  it("drops everything not in the allow-list (no serverNow, appliedBy, createdAt, ids of other entities)", () => {
    const out = projectStrikeStateRead({
      ...withStrike(strike({ appliedBy: id(99), revokedBy: id(98), caseId: id(97) })),
      reporterIds: [id(96)],
      caseId: id(95),
    });
    const dump = JSON.stringify(out);
    for (const leak of [
      id(99),
      id(98),
      id(97),
      id(96),
      id(95),
      "serverNow",
      "createdAt",
      "appliedBy",
      "reporter",
    ])
      expect(dump).not.toContain(leak);
  });
  it.each([
    ["eligible without a predicted level", { ...eligible, nextLevel: null }],
    ["ineligible without a reason", { ...eligible, eligible: false }],
    ["unknown reason", { ...eligible, eligible: false, ineligibleReason: "weird" }],
    ["eligible AND an existing strike", { ...eligible, strike: strike() }],
    ["level out of range", withStrike(strike({ level: 5 }))],
    ["permanent on a level-1 strike", withStrike(strike({ permanent: true }))],
    ["permanent with an end date", withStrike(strike({ level: 3, permanent: true }))],
    [
      "revoked without a date",
      withStrike(strike({ status: "revoked", sanctionInEffect: false })),
    ],
    ["revoked yet in effect", withStrike(strike({ status: "revoked", revokedAt: T1 }))],
    ["empty reason", withStrike(strike({ reason: "" }))],
    ["bad timestamp", withStrike(strike({ startsAt: "ayer" }))],
    ["non-object", "oops"],
    ["null", null],
  ])("malformed state (%s) is rejected", (_n, payload) => {
    expect(() => projectStrikeStateRead(payload)).toThrow();
  });
  it("parseModerationStrikeState is strict on already-projected input", () => {
    const ok = projectStrikeStateRead(eligible);
    expect(parseModerationStrikeState(ok)).toEqual(ok);
    expect(() => parseModerationStrikeState({ ...ok, eligible: "yes" })).toThrow();
  });
});

describe("case contract/parser carry the optional strike block", () => {
  const states = {
    fromPostStatus: null,
    toPostStatus: null,
    fromReportStatus: null,
    toReportStatus: null,
  };
  const base = (over: Record<string, unknown> = {}) => ({
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
    createdAt: T0,
    openedAt: T0,
    closedAt: T0,
    activityAt: T0,
    firstReportAt: T0,
    lastReportAt: T0,
    totalReports: 3,
    qualifyingReporters: 0,
    reasons: [{ reason: "spam", count: 3 }],
    reportsTruncated: false,
    post: null,
    reports: [],
    media: [],
    decision: {
      decisionId: id(6),
      result: "content_actioned",
      resolutionMessage: "mensaje",
      createdAt: T0,
    },
    audit: [
      { id: id(8), action: "post_purged", actorKind: "system", createdAt: T0, states },
    ],
    ...over,
  });
  it("existing cases WITHOUT strike data keep parsing unchanged", () => {
    const parsed = parseModerationCase(base());
    expect(parsed.strike).toBeUndefined();
    expect(parsed.post).toBeNull();
  });
  it("a purged case (post null) carries decision, history and the strike state", () => {
    const strike = projectStrikeStateRead({
      hasDecision: true,
      decisionId: id(6),
      eligible: true,
      ineligibleReason: null,
      nextLevel: 1,
      strike: null,
      canRevoke: false,
      serverNow: T0,
    });
    const parsed = parseModerationCase(base({ strike }));
    expect(parsed.post).toBeNull();
    expect(parsed.decision?.resolutionMessage).toBe("mensaje");
    expect(parsed.strike).toMatchObject({
      eligible: true,
      predictedLevel: 1,
      decisionId: id(6),
    });
  });
  it("a malformed strike block makes the parser reject the item (strict when present)", () => {
    expect(() => parseModerationCase(base({ strike: { eligible: "maybe" } }))).toThrow();
  });
});

describe("client response parsers accept exactly what the backend projects (round trip)", () => {
  it("apply: projectStrikeApplyResult → parseStrikeApplyResponse", () => {
    const raw = {
      strikeId: id(5),
      decisionId: id(6),
      level: 3,
      permanent: true,
      startsAt: T0,
      endsAt: null,
    };
    const wire = JSON.parse(JSON.stringify(projectStrikeApplyResult(raw, "motivo")));
    expect(parseStrikeApplyResponse(wire)).toEqual(wire);
  });
  it("revoke: projectStrikeRevokeResult → parseStrikeRevokeResponse", () => {
    const wire = JSON.parse(
      JSON.stringify(
        projectStrikeRevokeResult({ strikeId: id(5), level: 2, revokedAt: T1 }),
      ),
    );
    expect(parseStrikeRevokeResponse(wire)).toEqual(wire);
  });
  it.each([
    ["not an object", null],
    ["no strike", {}],
    [
      "revoked apply",
      {
        strike: {
          id: id(5),
          decisionId: id(6),
          level: 1,
          reason: "r",
          permanent: false,
          startsAt: T0,
          endsAt: T1,
          revoked: true,
          sanctionInEffect: true,
        },
      },
    ],
    [
      "bad level",
      {
        strike: {
          id: id(5),
          decisionId: id(6),
          level: 7,
          reason: "r",
          permanent: false,
          startsAt: T0,
          endsAt: T1,
          revoked: false,
          sanctionInEffect: true,
        },
      },
    ],
  ])("apply parser rejects %s", (_n, wire) => {
    expect(() => parseStrikeApplyResponse(wire)).toThrow();
  });
  it("revoke parser rejects a non-revoked or malformed payload", () => {
    expect(() =>
      parseStrikeRevokeResponse({
        strike: { id: id(5), level: 1, revoked: false, revokedAt: T1 },
      }),
    ).toThrow();
    expect(() =>
      parseStrikeRevokeResponse({
        strike: { id: "x", level: 1, revoked: true, revokedAt: T1 },
      }),
    ).toThrow();
  });
});
