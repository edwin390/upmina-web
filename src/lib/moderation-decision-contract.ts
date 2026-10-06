import { parseModerationId, timestamp } from "./moderation-case-parser.js";
import type { ModerationCaseItem } from "./moderation-case-contract.js";

export type GroupedDecision = "reports_not_valid" | "content_actioned";
export interface GroupedDecisionInput {
  caseId: string;
  cycleId: string;
  expectedCaseVersion: number;
  expectedPostVersion: number | null;
  originalPostState: "published" | "hidden_pending_review" | "hidden" | null;
  decision: GroupedDecision;
  resolutionMessage?: string | null;
}
export interface GroupedDecisionResult {
  decisionId: string;
  caseId: string;
  cycleId: string;
  postId: string;
  decision: GroupedDecision;
  caseVersion: number;
  postStatus: "published" | "hidden" | "removed_pending_purge" | null;
  postVersion: number | null;
  visibilityChanged: boolean;
  createdAt: string;
}
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Invalid contract");
  return v as Record<string, unknown>;
};
const positive = (v: unknown): number => {
  if (!Number.isInteger(v) || Number(v) < 1 || Number(v) > 2147483647)
    throw new Error("Invalid version");
  return Number(v);
};
export function parseGroupedDecision(v: unknown): GroupedDecision {
  if (v !== "reports_not_valid" && v !== "content_actioned")
    throw new Error("Invalid decision");
  return v;
}
export function parseGroupedDecisionInput(value: unknown): GroupedDecisionInput {
  const v = object(value);
  const decision = parseGroupedDecision(v.decision);
  if (
    ![null, "published", "hidden_pending_review", "hidden"].includes(
      v.originalPostState as string | null,
    )
  )
    throw new Error("Invalid original post state");
  const originalPostState =
    v.originalPostState as GroupedDecisionInput["originalPostState"];
  const expectedCaseVersion = positive(v.expectedCaseVersion);
  const expectedPostVersion =
    v.expectedPostVersion === null ? null : positive(v.expectedPostVersion);
  const incrementsPost =
    decision === "content_actioned" || originalPostState === "hidden_pending_review";
  if (
    expectedCaseVersion === 2147483647 ||
    (originalPostState === null) !== (expectedPostVersion === null) ||
    (originalPostState === null && decision === "content_actioned") ||
    (incrementsPost && expectedPostVersion === 2147483647)
  )
    throw new Error("Invalid transition context");
  if (
    v.resolutionMessage !== undefined &&
    v.resolutionMessage !== null &&
    typeof v.resolutionMessage !== "string"
  )
    throw new Error("Invalid message");
  const message =
    typeof v.resolutionMessage === "string" ? v.resolutionMessage.trim() : null;
  if (decision === "content_actioned" && !message)
    throw new Error("resolution_message_required");
  if (
    (message && [...message].length > 1000) ||
    (decision === "reports_not_valid" && message)
  )
    throw new Error("Invalid message");
  return {
    caseId: parseModerationId(v.caseId),
    cycleId: parseModerationId(v.cycleId),
    expectedCaseVersion,
    expectedPostVersion,
    originalPostState,
    decision,
    resolutionMessage: message || null,
  };
}
/** Snapshot the exact already-validated R3 item used for this action; never a mutation response. */
export function groupedDecisionInputFromCase(
  item: Pick<ModerationCaseItem, "caseId" | "cycleId" | "caseVersion" | "post">,
  decision: GroupedDecision,
  resolutionMessage: string | null = null,
): GroupedDecisionInput {
  const snapshot = object(item);
  if (!Object.prototype.hasOwnProperty.call(snapshot, "post"))
    throw new Error("Missing post snapshot");
  const post = snapshot.post === null ? null : object(snapshot.post);
  if (
    post !== null &&
    (!Object.prototype.hasOwnProperty.call(post, "status") ||
      !Object.prototype.hasOwnProperty.call(post, "version") ||
      !["published", "hidden_pending_review", "hidden"].includes(post.status as string))
  )
    throw new Error("Invalid post snapshot");
  return parseGroupedDecisionInput({
    caseId: item.caseId,
    cycleId: item.cycleId,
    expectedCaseVersion: item.caseVersion,
    originalPostState: post === null ? null : post.status,
    expectedPostVersion: post === null ? null : positive(post.version),
    decision,
    resolutionMessage,
  });
}
export function parseGroupedDecisionResult(
  value: unknown,
  expected: GroupedDecisionInput,
): GroupedDecisionResult {
  const input = parseGroupedDecisionInput(expected);
  // Mirrors SQL v_changed: a moderation transition/invalidation signal, including hidden -> removed.
  const visibilityChanged =
    input.originalPostState !== null &&
    (input.decision === "content_actioned" ||
      input.originalPostState === "hidden_pending_review");
  const postStatus =
    input.originalPostState === null
      ? null
      : input.decision === "content_actioned"
        ? "removed_pending_purge"
        : input.originalPostState === "hidden_pending_review"
          ? "published"
          : input.originalPostState;
  const expectedResultVersion =
    input.expectedPostVersion === null
      ? null
      : input.expectedPostVersion + (visibilityChanged ? 1 : 0);
  const v = object(value);
  const decision = parseGroupedDecision(v.decision);
  if (
    ![null, "published", "hidden", "removed_pending_purge"].includes(
      v.postStatus as string | null,
    ) ||
    typeof v.visibilityChanged !== "boolean"
  )
    throw new Error("Invalid result");
  const postVersion = v.postVersion === null ? null : positive(v.postVersion);
  if (
    (v.postStatus === null) !== (postVersion === null) ||
    (decision === "content_actioned" &&
      (v.postStatus !== "removed_pending_purge" || !v.visibilityChanged)) ||
    (decision === "reports_not_valid" && v.postStatus === "removed_pending_purge") ||
    (v.visibilityChanged && v.postStatus === null) ||
    (decision === "reports_not_valid" &&
      v.visibilityChanged &&
      v.postStatus !== "published")
  )
    throw new Error("Invalid result state");
  const result: GroupedDecisionResult = {
    decisionId: parseModerationId(v.decisionId),
    caseId: parseModerationId(v.caseId),
    cycleId: parseModerationId(v.cycleId),
    postId: parseModerationId(v.postId),
    decision,
    caseVersion: positive(v.caseVersion),
    postStatus: v.postStatus as GroupedDecisionResult["postStatus"],
    postVersion,
    visibilityChanged: v.visibilityChanged,
    createdAt: timestamp(v.createdAt),
  };
  if (
    result.caseId !== input.caseId ||
    result.cycleId !== input.cycleId ||
    result.decision !== input.decision ||
    result.caseVersion !== input.expectedCaseVersion + 1 ||
    result.postStatus !== postStatus ||
    result.visibilityChanged !== visibilityChanged ||
    result.postVersion !== expectedResultVersion
  )
    throw new Error("Invalid result context");
  return result;
}
