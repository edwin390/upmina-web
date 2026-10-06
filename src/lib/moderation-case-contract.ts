import type { CommunityFeedMediaItem } from "../types/index.js";

export interface ModerationCaseItem {
  caseId: string;
  caseVersion: number;
  postId: string;
  currentCycleId: string;
  currentCycleNumber: number;
  cycleId: string;
  cycleNumber: number;
  caseStatus: "pending" | "closed";
  cycleStatus: "pending" | "closed";
  closureKind: "legacy" | "decision" | null;
  isCurrentCycle: boolean;
  createdAt: string;
  openedAt: string;
  closedAt: string | null;
  activityAt: string;
  post: {
    text: string | null;
    status: "published" | "hidden" | "hidden_pending_review" | "removed_pending_purge";
    removalDecisionId?: string | null;
    removedAt?: string | null;
    purgeAfter?: string | null;
    version: number;
    updatedAt: string;
    authorUsername: string | null;
    quarantineCycleId: string | null;
  } | null;
  /** Additive forward contract; absent only on pre-R4 read models. */
  decision?: {
    decisionId: string;
    result: "reports_not_valid" | "content_actioned";
    resolutionMessage: string | null;
    createdAt: string;
  } | null;
  totalReports: number;
  qualifyingReporters: number;
  firstReportAt: string | null;
  lastReportAt: string | null;
  reasons: { reason: string; count: number }[];
  reports: {
    reportId: string;
    reason: string;
    detail: string | null;
    status: "open" | "reviewing" | "resolved" | "dismissed" | "actioned";
    version: number;
    createdAt: string;
  }[];
  reportsTruncated: boolean;
  media: CommunityFeedMediaItem[];
  audit: {
    id: string;
    /** Includes the system `post_purged` (physical purge); its raw metadata is never projected. */
    action: string;
    actorKind: "human" | "system";
    createdAt: string;
    states: Record<string, string | null>;
  }[];
}

export interface ModerationCasePage {
  cases: ModerationCaseItem[];
  nextCursor: string | null;
}
