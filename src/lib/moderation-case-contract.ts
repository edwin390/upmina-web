import type { CommunityFeedMediaItem } from "../types/index.js";
import type { ModerationStrikeState } from "./moderation-strike-contract.js";

/** Acciones REALES que registra `moderation_audit_log` y que el detalle de caso puede devolver
 *  (CHECK de la tabla, migraciones 20261010 y 20261020). Lista cerrada: el parser rechaza otras. */
export const MODERATION_AUDIT_ACTIONS = [
  "report_status_changed",
  "post_hidden",
  "post_restored",
  "post_quarantined",
  "case_rejected",
  "content_actioned",
  "strike_applied",
  "strike_revoked",
  "post_purged",
] as const;
export type ModerationAuditAction = (typeof MODERATION_AUDIT_ACTIONS)[number];

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
  closureKind: "legacy" | "decision" | "author_deleted" | null;
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
  /** R5-D: solo en el DETALLE de caso (nunca en listas); ausente si la BD aún no tiene strikes. */
  strike?: ModerationStrikeState;
  /** R5-F: true cuando la lectura del estado de strike FALLÓ (distinto de «sin strike» y de «la BD
   *  aún no tiene strikes», casos en los que simplemente no hay bloque). Nunca lleva el motivo. */
  strikeUnavailable?: true;
  audit: {
    id: string;
    /** Includes the system `post_purged` (physical purge); its raw metadata is never projected. */
    action: ModerationAuditAction;
    actorKind: "human" | "system";
    createdAt: string;
    states: Record<string, string | null>;
    /** R5-F: nivel (1–3) SOLO en los eventos strike_applied / strike_revoked; null en el resto. */
    strikeLevel: 1 | 2 | 3 | null;
  }[];
}

export interface ModerationCasePage {
  cases: ModerationCaseItem[];
  nextCursor: string | null;
}
