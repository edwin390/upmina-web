// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MODERATION_AUDIT_ACTIONS } from "./moderation-case-contract";
import { parseModerationCase } from "./moderation-case-parser";

// R5-F: el parser acepta el nivel de strike en la auditoría y la bandera «no se pudo consultar el
// estado de strike», ambos estrictos y opcionales (compatibles con la lectura SQL anterior).

const id = (k: number, n = 1) =>
  `${String(k).repeat(8)}-1111-4111-8111-${String(n).padStart(12, "0")}`;
const states = {
  fromPostStatus: null,
  toPostStatus: null,
  fromReportStatus: null,
  toReportStatus: null,
};
const auditItem = (over: Record<string, unknown> = {}) => ({
  id: id(6),
  action: "strike_applied",
  actorKind: "human",
  createdAt: "2026-10-05T00:00:00Z",
  states,
  strikeLevel: 2,
  ...over,
});
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
    resolutionMessage: "Mensaje",
    createdAt: "2026-10-02T00:00:00Z",
  },
  reports: [],
  media: [],
  audit: [auditItem()],
  ...over,
});

describe("auditoría: nivel de strike", () => {
  it.each([1, 2, 3])("acepta el nivel %i", (level) => {
    expect(
      parseModerationCase(raw({ audit: [auditItem({ strikeLevel: level })] })).audit[0]
        .strikeLevel,
    ).toBe(level);
  });
  it("ausente o null (lectura SQL anterior) → null", () => {
    const noKey = auditItem({ action: "post_purged", actorKind: "system" });
    delete (noKey as Record<string, unknown>).strikeLevel;
    expect(parseModerationCase(raw({ audit: [noKey] })).audit[0].strikeLevel).toBeNull();
    expect(
      parseModerationCase(raw({ audit: [auditItem({ strikeLevel: null })] })).audit[0]
        .strikeLevel,
    ).toBeNull();
  });
  it.each([0, 4, "2", 1.5, true, {}])("rechaza el nivel %j", (strikeLevel) => {
    expect(() =>
      parseModerationCase(raw({ audit: [auditItem({ strikeLevel })] })),
    ).toThrow();
  });
  it("sigue sin reenviar metadatos ni campos desconocidos del evento", () => {
    const parsed = parseModerationCase(
      raw({
        audit: [
          auditItem({ metadata: { reason: "secreto" }, actorUserId: id(9), reason: "x" }),
        ],
      }),
    );
    expect(Object.keys(parsed.audit[0]).sort()).toEqual(
      ["action", "actorKind", "createdAt", "id", "states", "strikeLevel"].sort(),
    );
  });
  it("la lista cerrada de acciones es exactamente la del contrato (incluye strikes)", () => {
    for (const action of MODERATION_AUDIT_ACTIONS)
      expect(() =>
        parseModerationCase(
          raw({
            audit: [
              auditItem({
                action,
                actorKind:
                  action === "post_quarantined" || action === "post_purged"
                    ? "system"
                    : "human",
                strikeLevel: action.startsWith("strike_") ? 1 : null,
              }),
            ],
          }),
        ),
      ).not.toThrow();
    expect(() =>
      parseModerationCase(raw({ audit: [auditItem({ action: "strike_expired" })] })),
    ).toThrow();
  });
});

describe("strikeUnavailable", () => {
  it("true se conserva; ausente no aparece", () => {
    expect(parseModerationCase(raw({ strikeUnavailable: true })).strikeUnavailable).toBe(
      true,
    );
    expect("strikeUnavailable" in parseModerationCase(raw())).toBe(false);
  });
  it.each([false, "true", 1, null, { message: "SELECT secret" }])(
    "rechaza %j (solo el booleano true es válido y nunca lleva texto)",
    (value) => {
      expect(() => parseModerationCase(raw({ strikeUnavailable: value }))).toThrow();
    },
  );
});
