// COPY-1 fase 2A: contrato (tipos y parsers estrictos) de las lecturas y la revisión de reclamaciones de copyright.
// Módulo puro, sin imports: lo usan el servidor (valida lo que devuelve la RPC antes de responder) y el cliente.

export const CLAIM_STATUSES = [
  "received",
  "in_review",
  "needs_info",
  "dismissed",
  "withdrawn",
  // Fase 2B: retirada (publicación oculta), apelación pendiente y cierres por restauración o eliminación definitiva.
  "removed",
  "appeal_pending",
  "restored",
  "purged",
  // DEL-2: cierre técnico cuando la cuenta autora se elimina (no es una resolución de la reclamación).
  "author_deleted",
] as const;
export type CopyrightClaimStatus = (typeof CLAIM_STATUSES)[number];

export const CLAIM_EVENT_KINDS = [
  "received",
  "review_started",
  "info_requested",
  "review_resumed",
  "note",
  "dismissed",
  "withdrawn",
  "removed",
  "notified",
  "notification_failed",
  "token_reissued",
  "appeal_submitted",
  "appeal_accepted",
  "appeal_rejected",
  "restored",
  "purged",
  // Strikes manuales (solo tras `purged`) y el estado de su aviso al autor.
  "strike_applied",
  "strike_notified",
  "strike_notification_failed",
  "author_deleted",
] as const;
export type CopyrightEventKind = (typeof CLAIM_EVENT_KINDS)[number];

export const REVIEW_ACTIONS = [
  "start_review",
  "request_info",
  "resume_review",
  "dismiss",
  "withdraw",
  "add_note",
] as const;
export type CopyrightReviewAction = (typeof REVIEW_ACTIONS)[number];
/** Acciones que exigen una nota de la persona que revisa. */
export const NOTE_REQUIRED_ACTIONS: readonly CopyrightReviewAction[] = [
  "request_info",
  "dismiss",
  "withdraw",
  "add_note",
];

/** Acciones de revisión disponibles en cada estado (el servidor y la RPC repiten la comprobación). */
export const ACTIONS_BY_STATUS: Record<CopyrightClaimStatus, CopyrightReviewAction[]> = {
  received: ["start_review", "dismiss", "withdraw", "add_note"],
  in_review: ["request_info", "dismiss", "withdraw", "add_note"],
  needs_info: ["resume_review", "dismiss", "withdraw", "add_note"],
  dismissed: [],
  withdrawn: [],
  author_deleted: [],
  // Una reclamación retirada solo admite notas; retirar, resolver la apelación y eliminar tienen sus propias acciones.
  removed: ["add_note"],
  appeal_pending: ["add_note"],
  restored: [],
  purged: [],
};

/** Estados que siguen en la cola de casos ACTIVOS (el resto va al historial de Copyright). */
export const OPEN_CLAIM_STATUSES: readonly CopyrightClaimStatus[] = [
  "received",
  "in_review",
  "needs_info",
  "removed",
  "appeal_pending",
];

export const NOTICE_KINDS = [
  "removal",
  "appeal_accepted",
  "appeal_rejected",
  "strike",
] as const;
export type CopyrightNoticeKind = (typeof NOTICE_KINDS)[number];
export const NOTICE_ERROR_CLASSES = [
  "not_configured",
  "rejected",
  "rate_limited",
  "provider_unavailable",
  "timeout",
  "invalid_response",
  "no_recipient",
] as const;
export type CopyrightNoticeErrorClass = (typeof NOTICE_ERROR_CLASSES)[number];
export const PURGE_BLOCKERS = [
  "appeal_pending",
  "not_removed",
  "notification_pending",
  "window_open",
  "resolution_notice_pending",
] as const;
export type CopyrightPurgeBlocker = (typeof PURGE_BLOCKERS)[number];
export const APPEAL_REASONS = [
  "own_work",
  "authorized",
  "not_infringing",
  "legal_exception",
  "mistake",
  "other",
] as const;
export type CopyrightAppealReason = (typeof APPEAL_REASONS)[number];

export const CLAIM_SCOPES = ["open", "closed"] as const;
export type CopyrightClaimScope = (typeof CLAIM_SCOPES)[number];

export interface CopyrightClaimSummary {
  id: string;
  reference: string;
  status: CopyrightClaimStatus;
  version: number;
  claimantName: string;
  relationship: "owner" | "authorized_representative";
  postFound: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CopyrightClaimEvent {
  kind: CopyrightEventKind;
  actorKind: "claimant" | "human" | "system";
  fromStatus: CopyrightClaimStatus | null;
  toStatus: CopyrightClaimStatus | null;
  note: string | null;
  createdAt: string;
}

export interface CopyrightCurrentPost {
  status: string;
  text: string | null;
  version: number;
  mediaCount: number;
}

export interface CopyrightRemovalInfo {
  removedAt: string;
  reason: string;
  windowMinutes: 60 | 1440;
  notifiedAt: string | null;
  appealDeadline: string | null;
  notifyAttempts: number;
  notifyLastError: CopyrightNoticeErrorClass | null;
  resolutionNoticePending: boolean;
  resolutionNotifiedAt: string | null;
  restoredAt: string | null;
  purgedAt: string | null;
  /** Archivos marcados para el GC de R2 que aún no se han borrado (null mientras no haya eliminación). */
  purgeAssetsPending: number | null;
  /** Condiciones que impiden hoy la eliminación definitiva (vacío = permitida). La RPC las repite. */
  purgeBlockers: CopyrightPurgeBlocker[];
}

export interface CopyrightAppealInfo {
  status: "pending" | "accepted" | "rejected";
  reason: CopyrightAppealReason;
  explanation: string;
  evidenceText: string | null;
  evidenceUrls: string[];
  contactName: string;
  contactEmail: string;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export interface CopyrightClaimDetail extends CopyrightClaimSummary {
  claimantEmail: string;
  organization: string | null;
  workDescription: string;
  infringementDescription: string;
  evidenceUrls: string[];
  claimedPostUrl: string;
  postId: string | null;
  postTextSnapshot: string | null;
  postMediaCount: number | null;
  /** Estado ACTUAL de la publicación (si todavía existe); en la fase 2A solo se muestra, nunca se modifica. */
  currentPostStatus: string | null;
  /** Publicación tal como está AHORA (texto, versión y medios); null si ya no existe. */
  currentPost: CopyrightCurrentPost | null;
  statementVersion: string;
  signature: string;
  removal: CopyrightRemovalInfo | null;
  appeal: CopyrightAppealInfo | null;
  events: CopyrightClaimEvent[];
}

export interface CopyrightClaimPage {
  claims: CopyrightClaimSummary[];
  nextCursor: string | null;
}

export interface CopyrightReviewResult {
  id: string;
  reference: string;
  status: CopyrightClaimStatus;
  version: number;
  updatedAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE_RE = /^CPY-\d{4}-\d{6}$/;
const fail = (): never => {
  throw new Error("Invalid copyright projection");
};

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const str = (v: unknown, max: number): string =>
  typeof v === "string" && v.length <= max ? v : fail();
const nullableStr = (v: unknown, max: number): string | null =>
  v === null || v === undefined ? null : str(v, max);
export const isClaimUuid = (v: unknown): v is string =>
  typeof v === "string" && UUID_RE.test(v);
const uuid = (v: unknown): string => (isClaimUuid(v) ? v : fail());
const nullableUuid = (v: unknown): string | null =>
  v === null || v === undefined ? null : uuid(v);
const int = (v: unknown, min = 0): number =>
  typeof v === "number" && Number.isInteger(v) && v >= min ? v : fail();
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : fail());
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fail();
const timestamp = (v: unknown): string => {
  const text = str(v, 40);
  return Number.isFinite(Date.parse(text)) ? text : fail();
};

export function parseClaimSummary(value: unknown): CopyrightClaimSummary {
  const r = record(value);
  const reference = str(r.reference, 20);
  if (!REFERENCE_RE.test(reference)) fail();
  return {
    id: uuid(r.id),
    reference,
    status: oneOf(r.status, CLAIM_STATUSES),
    version: int(r.version, 1),
    claimantName: str(r.claimantName, 120),
    relationship: oneOf(r.relationship, ["owner", "authorized_representative"] as const),
    postFound: bool(r.postFound),
    createdAt: timestamp(r.createdAt),
    updatedAt: timestamp(r.updatedAt),
  };
}

function parseEvent(value: unknown): CopyrightClaimEvent {
  const r = record(value);
  return {
    kind: oneOf(r.kind, CLAIM_EVENT_KINDS),
    actorKind: oneOf(r.actorKind, ["claimant", "human", "system"] as const),
    fromStatus: r.fromStatus == null ? null : oneOf(r.fromStatus, CLAIM_STATUSES),
    toStatus: r.toStatus == null ? null : oneOf(r.toStatus, CLAIM_STATUSES),
    note: nullableStr(r.note, 1000),
    createdAt: timestamp(r.createdAt),
  };
}

function parseCurrentPost(value: unknown): CopyrightCurrentPost | null {
  if (value === null || value === undefined) return null;
  const r = record(value);
  return {
    status: str(r.status, 40),
    text: nullableStr(r.text, 2000),
    version: int(r.version, 1),
    mediaCount: int(r.mediaCount),
  };
}

function parseRemoval(value: unknown): CopyrightRemovalInfo | null {
  if (value === null || value === undefined) return null;
  const r = record(value);
  const blockers =
    Array.isArray(r.purgeBlockers) && r.purgeBlockers.length <= 5
      ? r.purgeBlockers
      : fail();
  const win = r.windowMinutes;
  if (win !== 60 && win !== 1440) fail();
  return {
    removedAt: timestamp(r.removedAt),
    reason: str(r.reason, 1000),
    windowMinutes: win as 60 | 1440,
    notifiedAt: r.notifiedAt == null ? null : timestamp(r.notifiedAt),
    appealDeadline: r.appealDeadline == null ? null : timestamp(r.appealDeadline),
    notifyAttempts: int(r.notifyAttempts),
    notifyLastError:
      r.notifyLastError == null ? null : oneOf(r.notifyLastError, NOTICE_ERROR_CLASSES),
    resolutionNoticePending: bool(r.resolutionNoticePending),
    resolutionNotifiedAt:
      r.resolutionNotifiedAt == null ? null : timestamp(r.resolutionNotifiedAt),
    restoredAt: r.restoredAt == null ? null : timestamp(r.restoredAt),
    purgedAt: r.purgedAt == null ? null : timestamp(r.purgedAt),
    purgeAssetsPending: r.purgeAssetsPending == null ? null : int(r.purgeAssetsPending),
    purgeBlockers: blockers.map((b) => oneOf(b, PURGE_BLOCKERS)),
  };
}

function parseAppeal(value: unknown): CopyrightAppealInfo | null {
  if (value === null || value === undefined) return null;
  const r = record(value);
  const urls =
    Array.isArray(r.evidenceUrls) && r.evidenceUrls.length <= 5 ? r.evidenceUrls : fail();
  return {
    status: oneOf(r.status, ["pending", "accepted", "rejected"] as const),
    reason: oneOf(r.reason, APPEAL_REASONS),
    explanation: str(r.explanation, 2000),
    evidenceText: nullableStr(r.evidenceText, 2000),
    evidenceUrls: urls.map((u) => str(u, 500)),
    contactName: str(r.contactName, 120),
    contactEmail: str(r.contactEmail, 254),
    createdAt: timestamp(r.createdAt),
    resolvedAt: r.resolvedAt == null ? null : timestamp(r.resolvedAt),
    resolutionNote: nullableStr(r.resolutionNote, 1000),
  };
}

export function parseClaimDetail(value: unknown): CopyrightClaimDetail {
  const r = record(value);
  const urls =
    Array.isArray(r.evidenceUrls) && r.evidenceUrls.length <= 5 ? r.evidenceUrls : fail();
  const events = Array.isArray(r.events) && r.events.length <= 200 ? r.events : fail();
  const summary = parseClaimSummary(r);
  return {
    ...summary,
    claimantEmail: str(r.claimantEmail, 254),
    organization: nullableStr(r.organization, 120),
    workDescription: str(r.workDescription, 2000),
    infringementDescription: str(r.infringementDescription, 2000),
    evidenceUrls: urls.map((u) => str(u, 500)),
    claimedPostUrl: str(r.claimedPostUrl, 500),
    postId: nullableUuid(r.postId),
    postTextSnapshot: nullableStr(r.postTextSnapshot, 2000),
    postMediaCount: r.postMediaCount == null ? null : int(r.postMediaCount),
    currentPostStatus: nullableStr(r.currentPostStatus, 40),
    currentPost: parseCurrentPost(r.currentPost),
    statementVersion: str(r.statementVersion, 20),
    signature: str(r.signature, 120),
    removal: parseRemoval(r.removal),
    appeal: parseAppeal(r.appeal),
    events: events.map(parseEvent),
  };
}

export function parseReviewResult(value: unknown): CopyrightReviewResult {
  const r = record(value);
  const reference = str(r.reference, 20);
  if (!REFERENCE_RE.test(reference)) fail();
  return {
    id: uuid(r.id),
    reference,
    status: oneOf(r.status, CLAIM_STATUSES),
    version: int(r.version, 1),
    updatedAt: timestamp(r.updatedAt),
  };
}

/** Resultado de una acción de la fase 2B (retirada, resolución, eliminación, reintento de aviso). */
export interface CopyrightActionResult extends CopyrightReviewResult {
  /** Aviso al autor: «sent» (confirmado), «failed» (registrado, reintentable), «none» (la acción no envía aviso). */
  notice: "sent" | "failed" | "none";
  noticeError: CopyrightNoticeErrorClass | null;
  /** Solo eliminación: archivos marcados para el GC y conservados, y si la publicación se eliminó. */
  assetsMarked: number | null;
  assetsRetained: number | null;
  postDeleted: boolean | null;
}

export function parseActionResult(value: unknown): CopyrightActionResult {
  const r = record(value);
  return {
    ...parseReviewResult(r),
    notice: oneOf(r.notice, ["sent", "failed", "none"] as const),
    noticeError:
      r.noticeError == null ? null : oneOf(r.noticeError, NOTICE_ERROR_CLASSES),
    assetsMarked: r.assetsMarked == null ? null : int(r.assetsMarked),
    assetsRetained: r.assetsRetained == null ? null : int(r.assetsRetained),
    postDeleted: r.postDeleted == null ? null : bool(r.postDeleted),
  };
}

// Cursor opaco de la cola: { createdAt, id } en base64url. El servidor solo lo reenvía a la RPC tras validarlo.
export function encodeClaimCursor(next: { createdAt: string; id: string }): string {
  return btoa(JSON.stringify({ c: next.createdAt, i: next.id }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeClaimCursor(raw: string): { createdAt: string; id: string } | null {
  if (raw.length === 0 || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const parsed = JSON.parse(
      atob(
        raw
          .replace(/-/g, "+")
          .replace(/_/g, "/")
          .padEnd(Math.ceil(raw.length / 4) * 4, "="),
      ),
    ) as { c?: unknown; i?: unknown };
    if (typeof parsed.c !== "string" || !Number.isFinite(Date.parse(parsed.c)))
      return null;
    if (!isClaimUuid(parsed.i)) return null;
    return { createdAt: parsed.c, id: parsed.i.toLowerCase() };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Strikes manuales de Copyright (solo tras `purged`). El nivel y la duración los calcula la BD con las reglas de Community.
export const STRIKE_BLOCKERS = [
  "claim_not_purged",
  "author_unavailable",
  "self_strike_forbidden",
  "strike_already_issued",
] as const;
export type CopyrightStrikeBlocker = (typeof STRIKE_BLOCKERS)[number];
export type CopyrightStrikeLevel = 1 | 2 | 3;
export const STRIKE_REASON_MAX = 1000;
const STRIKE_NOTICE_STATUSES = ["sent", "pending", "failed"] as const;

export interface CopyrightStrikeInfo {
  id: string;
  level: CopyrightStrikeLevel;
  permanent: boolean;
  startsAt: string;
  endsAt: string | null;
  reason: string;
  revokedAt: string | null;
}
export interface CopyrightStrikeState {
  eligible: boolean;
  blocker: CopyrightStrikeBlocker | null;
  nextLevel: CopyrightStrikeLevel | null;
  strike: CopyrightStrikeInfo | null;
  notice: {
    status: (typeof STRIKE_NOTICE_STATUSES)[number];
    attempts: number;
    error: CopyrightNoticeErrorClass | null;
  } | null;
}

const strikeLevel = (v: unknown): CopyrightStrikeLevel =>
  v === 1 || v === 2 || v === 3 ? v : fail();

export function parseStrikeState(value: unknown): CopyrightStrikeState {
  const r = record(value);
  const eligible = bool(r.eligible);
  const blocker = r.blocker == null ? null : oneOf(r.blocker, STRIKE_BLOCKERS);
  if (eligible !== (blocker === null)) fail();
  const strike = r.strike == null ? null : record(r.strike);
  const notice = r.notice == null ? null : record(r.notice);
  return {
    eligible,
    blocker,
    nextLevel: r.nextLevel == null ? null : strikeLevel(r.nextLevel),
    strike: strike && {
      id: uuid(strike.id),
      level: strikeLevel(strike.level),
      permanent: bool(strike.permanent),
      startsAt: timestamp(strike.startsAt),
      endsAt: strike.endsAt == null ? null : timestamp(strike.endsAt),
      reason: str(strike.reason, STRIKE_REASON_MAX),
      revokedAt: strike.revokedAt == null ? null : timestamp(strike.revokedAt),
    },
    notice: notice && {
      status: oneOf(notice.status, STRIKE_NOTICE_STATUSES),
      attempts: int(notice.attempts),
      error: notice.error == null ? null : oneOf(notice.error, NOTICE_ERROR_CLASSES),
    },
  };
}

/** Resultado de aplicar un strike manual: el strike y el estado del aviso al autor. */
export interface CopyrightStrikeApplyResult {
  strikeId: string;
  claimId: string;
  reference: string;
  level: CopyrightStrikeLevel;
  permanent: boolean;
  endsAt: string | null;
  notice: "sent" | "failed";
  noticeError: CopyrightNoticeErrorClass | null;
}

export function parseStrikeApplyResult(value: unknown): CopyrightStrikeApplyResult {
  const r = record(value);
  const reference = str(r.reference, 20);
  if (!REFERENCE_RE.test(reference)) fail();
  return {
    strikeId: uuid(r.strikeId),
    claimId: uuid(r.claimId),
    reference,
    level: strikeLevel(r.level),
    permanent: bool(r.permanent),
    endsAt: r.endsAt == null ? null : timestamp(r.endsAt),
    notice: oneOf(r.notice, ["sent", "failed"] as const),
    noticeError:
      r.noticeError == null ? null : oneOf(r.noticeError, NOTICE_ERROR_CLASSES),
  };
}
