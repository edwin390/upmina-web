import { describe, expect, it } from "vitest";
import {
  type AuthorRestrictionView,
  parseAuthorRestriction,
  restrictionCopy,
  restrictionOutcome,
  RESTRICTION_DELETE_HINT,
} from "./author-restriction";

const ENDS = "2026-10-20T10:00:00+00:00";
const base: AuthorRestrictionView = {
  level: 1,
  permanent: false,
  endsAt: ENDS,
  reason: "Motivo completo",
};

describe("author restriction model (single central representation)", () => {
  it("parses only the approved fields", () => {
    expect(
      parseAuthorRestriction({
        ...base,
        appliedBy: "x",
        caseId: "y",
        decisionId: "z",
        serverNow: "now",
      }),
    ).toEqual(base);
    expect(
      parseAuthorRestriction({ level: 3, permanent: true, endsAt: null, reason: "r" }),
    ).toEqual({ level: 3, permanent: true, endsAt: null, reason: "r" });
  });
  it.each([
    ["null", null],
    ["string", "restricted"],
    ["array", []],
    ["level 4", { ...base, level: 4 }],
    ["level as string", { ...base, level: "1" }],
    ["level 3 not permanent", { level: 3, permanent: false, endsAt: ENDS, reason: "r" }],
    ["permanent with a date", { level: 3, permanent: true, endsAt: ENDS, reason: "r" }],
    ["temporary without a date", { ...base, endsAt: null }],
    ["temporary with a bad date", { ...base, endsAt: "ayer" }],
    ["empty reason", { ...base, reason: "" }],
    ["missing reason", { level: 1, permanent: false, endsAt: ENDS }],
  ])("rejects a malformed restriction (%s)", (_n, raw) => {
    expect(parseAuthorRestriction(raw)).toBeNull();
  });
  it("classifies author_restricted / author_restriction_changed errors from any client", () => {
    expect(restrictionOutcome({ code: "author_restricted", restriction: base })).toEqual({
      kind: "restricted",
      restriction: base,
    });
    expect(restrictionOutcome({ code: "author_restricted" })).toEqual({
      kind: "restricted",
      restriction: null,
    });
    expect(
      restrictionOutcome({ code: "author_restricted", restriction: { level: 9 } }),
    ).toEqual({ kind: "restricted", restriction: null });
    expect(restrictionOutcome({ code: "author_restriction_changed" })).toEqual({
      kind: "changed",
    });
    for (const other of [
      null,
      "x",
      {},
      { code: "community_version_conflict" },
      new Error("boom"),
    ])
      expect(restrictionOutcome(other)).toBeNull();
  });
  it("copy: Strike 1 / 2 are temporary with the exact deadline, Strike 3 is permanent", () => {
    const one = restrictionCopy(base);
    expect(one.headline).toBe("Tu cuenta tiene un Strike 1 activo en Community.");
    expect(one.duration).toMatch(
      /^No puedes crear ni editar publicaciones de Community hasta .*2026/,
    );
    const two = restrictionCopy({ ...base, level: 2 });
    expect(two.headline).toBe("Tu cuenta tiene un Strike 2 activo en Community.");
    const three = restrictionCopy({
      level: 3,
      permanent: true,
      endsAt: null,
      reason: "r",
    });
    expect(three.headline).toBe("Tu cuenta tiene un Strike 3 activo en Community.");
    expect(three.duration).toBe(
      "No puedes crear ni editar publicaciones de Community de forma permanente.",
    );
    for (const c of [one, two, three]) {
      expect(c.title).toBe("Publicación restringida");
      expect(c.deleteHint).toBe(RESTRICTION_DELETE_HINT);
    }
  });
  it("copy: the FULL reason is shown and nothing internal ever appears", () => {
    const long = "😀".repeat(1000);
    const c = restrictionCopy({ ...base, reason: long });
    expect(c.reason).toBe(long);
    const dump = JSON.stringify(restrictionCopy(base));
    expect(dump).not.toMatch(/moderador|reporte|caso|decisi/i);
  });
  it("copy without detail is neutral (backend could not explain)", () => {
    const c = restrictionCopy(null);
    expect(c.reason).toBeNull();
    expect(c.headline).toContain("restricción activa");
  });
});
