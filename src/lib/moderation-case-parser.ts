import type {
  ModerationCaseItem,
  ModerationCasePage,
} from "./moderation-case-contract.js";
import type { CommunityFeedMediaItem } from "../types/index.js";
import type { RawFeedMediaRow } from "./community-feed-domain.js";

/** Keep the original timestamp, including PostgreSQL microseconds, for cursors. */
export function timestamp(v: unknown): string {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(
      v,
    ) ||
    !Number.isFinite(Date.parse(v))
  )
    throw new Error("Invalid timestamp");
  const [year, month, day] = v.slice(0, 10).split("-").map(Number);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate()
  )
    throw new Error("Invalid calendar date");
  return v;
}
const nullableTimestamp = (v: unknown) => (v === null ? null : timestamp(v));
const postStates = [
  "published",
  "hidden",
  "hidden_pending_review",
  "removed_pending_purge",
] as const;
const reportStates = ["open", "reviewing", "resolved", "dismissed", "actioned"] as const;
const nullableChoice = <T extends string>(v: unknown, values: readonly T[]) =>
  v === null ? null : choice(v, values);
const dimension = (v: unknown) => positive(v);
const duration = (v: unknown): number | null => {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
    throw new Error("Invalid duration");
  return v;
};
function parseMedia(value: unknown): CommunityFeedMediaItem {
  const m = record(value);
  const url = str(m.url);
  if (!/^https?:\/\//i.test(url)) throw new Error("Invalid media URL");
  const parsed = new URL(url);
  if (parsed.username || parsed.password) throw new Error("Invalid media URL");
  return {
    id: parseModerationId(m.id),
    position: count(m.position),
    kind: choice(m.kind, ["image", "video"]),
    url,
    width: dimension(m.width),
    height: dimension(m.height),
    durationSeconds: duration(m.durationSeconds),
  };
}
/** Validate DB shape before the existing ready-asset mapper; do not change its filtering. */
export function parseRawModerationMedia(value: unknown): RawFeedMediaRow {
  const m = record(value);
  const a = m.media_assets === null ? null : record(m.media_assets);
  if (
    a?.status === "ready" &&
    (a.storage_key === null ||
      a.storage_key === "" ||
      a.width === null ||
      a.height === null)
  )
    throw new Error("Invalid ready media");
  return {
    id: parseModerationId(m.id),
    position: count(m.position),
    media_assets:
      a === null
        ? null
        : {
            status: choice(a.status, [
              "reserved",
              "uploaded",
              "verifying",
              "processing",
              "ready",
              "failed",
              "deleting",
            ]),
            kind: choice(a.kind, ["image", "video"]),
            storage_key: nullable(a.storage_key),
            width: a.width === null ? null : dimension(a.width),
            height: a.height === null ? null : dimension(a.height),
            duration_seconds: duration(a.duration_seconds),
          },
  };
}

export function parseModerationCasePage(value: unknown): ModerationCasePage {
  const p = record(value);
  const cursor = p.nextCursor === null ? null : str(p.nextCursor);
  if (cursor !== null) {
    if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error("Invalid cursor");
    const decoded = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const parts = decoded.split("|");
    if (parts.length !== 2) throw new Error("Invalid cursor");
    timestamp(parts[0]);
    parseModerationId(parts[1]);
  }
  return { cases: array(p.cases, 20).map(parseModerationCase), nextCursor: cursor };
}
export function parseModerationCaseDetail(value: unknown): ModerationCaseItem {
  return parseModerationCase(record(value).item);
}
export const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Invalid projection");
  return v as Record<string, unknown>;
};
const str = (v: unknown): string => {
  if (typeof v !== "string") throw new Error("Invalid string");
  return v;
};
const nullable = (v: unknown): string | null => (v === null ? null : str(v));
const count = (v: unknown): number => {
  if (!Number.isSafeInteger(v) || Number(v) < 0) throw new Error("Invalid count");
  return Number(v);
};
const positive = (v: unknown): number => {
  const n = count(v);
  if (!n) throw new Error("Invalid version");
  return n;
};
const choice = <const T extends string>(v: unknown, values: readonly T[]): T => {
  if (!values.includes(v as T)) throw new Error("Invalid state");
  return v as T;
};
const array = (v: unknown, max: number): unknown[] => {
  if (!Array.isArray(v) || v.length > max) throw new Error("Invalid bound");
  return v;
};
const bool = (v: unknown): boolean => {
  if (typeof v !== "boolean") throw new Error("Invalid flag");
  return v;
};
export const parseModerationId = (v: unknown): string => {
  if (!uuid(v)) throw new Error("Invalid identity");
  return v;
};
const reasons = ["spam", "harassment", "hate_speech", "sexual_content", "other"] as const;

/** Explicit allowlist projection: never forward arbitrary RPC/report/audit fields. */
export function parseModerationCase(value: unknown): ModerationCaseItem {
  const r = record(value);
  const p = r.post === null ? null : record(r.post);
  const result: ModerationCaseItem = {
    caseId: parseModerationId(r.caseId),
    caseVersion: positive(r.caseVersion),
    postId: parseModerationId(r.postId),
    cycleId: parseModerationId(r.cycleId),
    cycleNumber: positive(r.cycleNumber),
    currentCycleId: parseModerationId(r.currentCycleId),
    currentCycleNumber: positive(r.currentCycleNumber),
    caseStatus: choice(r.caseStatus, ["pending", "closed"]),
    cycleStatus: choice(r.cycleStatus, ["pending", "closed"]),
    closureKind:
      r.closureKind === null ? null : choice(r.closureKind, ["legacy", "decision"]),
    isCurrentCycle: bool(r.isCurrentCycle),
    createdAt: timestamp(r.createdAt),
    openedAt: timestamp(r.openedAt),
    closedAt: nullableTimestamp(r.closedAt),
    activityAt: timestamp(r.activityAt),
    firstReportAt: nullableTimestamp(r.firstReportAt),
    lastReportAt: nullableTimestamp(r.lastReportAt),
    post: p
      ? {
          text: nullable(p.text),
          status: choice(p.status, [
            "published",
            "hidden",
            "hidden_pending_review",
            "removed_pending_purge",
          ]),
          version: positive(p.version),
          updatedAt: timestamp(p.updatedAt),
          authorUsername: nullable(p.authorUsername),
          quarantineCycleId:
            p.quarantineCycleId === null ? null : parseModerationId(p.quarantineCycleId),
        }
      : null,
    totalReports: count(r.totalReports),
    qualifyingReporters: count(r.qualifyingReporters),
    reasons: array(r.reasons, 5).map((v) => {
      const x = record(v);
      return { reason: choice(x.reason, reasons), count: positive(x.count) };
    }),
    reports: array(r.reports, 50).map((v) => {
      const x = record(v);
      return {
        reportId: parseModerationId(x.reportId),
        reason: choice(x.reason, reasons),
        detail: nullable(x.detail),
        status: choice(x.status, [
          "open",
          "reviewing",
          "resolved",
          "dismissed",
          "actioned",
        ]),
        version: positive(x.version),
        createdAt: timestamp(x.createdAt),
      };
    }),
    reportsTruncated: bool(r.reportsTruncated),
    media: array(r.media, 10).map(parseMedia),
    audit: array(r.audit, 20).map((v) => {
      const x = record(v);
      const s = record(x.states);
      return {
        id: parseModerationId(x.id),
        action: choice(x.action, [
          "report_status_changed",
          "post_hidden",
          "post_restored",
          "post_quarantined",
          "case_rejected",
          "content_actioned",
          "strike_applied",
          "strike_revoked",
        ]),
        actorKind: choice(x.actorKind, ["human", "system"]),
        createdAt: timestamp(x.createdAt),
        states: {
          fromPostStatus: nullableChoice(s.fromPostStatus, postStates),
          toPostStatus: nullableChoice(s.toPostStatus, postStates),
          fromReportStatus: nullableChoice(s.fromReportStatus, reportStates),
          toReportStatus: nullableChoice(s.toReportStatus, reportStates),
        },
      };
    }),
  };
  // Optional only for compatibility with the still-installed pre-R4 RPC.
  // If provided, every nested field is required; removed content always requires attribution.
  if (r.decision !== undefined) {
    const d = r.decision === null ? null : record(r.decision);
    result.decision = d
      ? {
          decisionId: parseModerationId(d.decisionId),
          result: choice(d.result, ["reports_not_valid", "content_actioned"]),
          resolutionMessage: nullable(d.resolutionMessage),
          createdAt: timestamp(d.createdAt),
        }
      : null;
    if (
      result.decision &&
      ((result.decision.result === "content_actioned" &&
        (!result.decision.resolutionMessage ||
          result.decision.resolutionMessage !==
            result.decision.resolutionMessage.trim() ||
          [...result.decision.resolutionMessage].length > 1000)) ||
        (result.decision.result === "reports_not_valid" &&
          result.decision.resolutionMessage !== null))
    )
      throw new Error("Invalid resolution");
    if (d && (result.cycleStatus !== "closed" || result.closureKind !== "decision"))
      throw new Error("Invalid decision context");
  }
  if (
    p &&
    (p.removalDecisionId !== undefined ||
      p.removedAt !== undefined ||
      p.purgeAfter !== undefined ||
      p.status === "removed_pending_purge")
  ) {
    result.post!.removalDecisionId =
      p.removalDecisionId === null ? null : parseModerationId(p.removalDecisionId);
    result.post!.removedAt = nullableTimestamp(p.removedAt);
    result.post!.purgeAfter = nullableTimestamp(p.purgeAfter);
    if (p.status === "removed_pending_purge") {
      if (
        !result.post!.removalDecisionId ||
        !result.post!.removedAt ||
        !result.post!.purgeAfter ||
        result.post!.quarantineCycleId !== null ||
        Date.parse(result.post!.purgeAfter) - Date.parse(result.post!.removedAt) !==
          72 * 60 * 60 * 1000
      )
        throw new Error("Invalid removal");
    } else if (
      result.post!.removalDecisionId !== null ||
      result.post!.removedAt !== null ||
      result.post!.purgeAfter !== null
    )
      throw new Error("Invalid removal");
  }
  if (result.qualifyingReporters > result.totalReports)
    throw new Error("Invalid summary");
  return result;
}
