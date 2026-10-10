// R5-D: contrato (puro, sin dependencias de runtime) de la API privilegiada de strikes y del bloque
// de estado de strike del detalle de caso. La AUTORIDAD es la BD (R5-B): este módulo solo valida
// la forma de las peticiones y proyecta respuestas seguras. Nunca incluye identidad de moderador,
// de reportantes, ids de caso/ciclo/post ni metadata de auditoría.

export const STRIKE_REASON_MAX_CODE_POINTS = 1000;

/** Mismo conjunto que btrim() de la BD para resolution_message / reason (U&'\0009…\FEFF'). */
const TRIM_SET =
  "[\\u0009\\u000A\\u000B\\u000C\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]";
const TRIM = new RegExp(`^${TRIM_SET}+|${TRIM_SET}+$`, "g");
const BLANK = new RegExp(`^${TRIM_SET}*$`);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isStrikeUuid = (v: unknown): v is string =>
  typeof v === "string" && UUID.test(v);

export type StrikeLevel = 1 | 2 | 3;
export const isStrikeLevel = (v: unknown): v is StrikeLevel =>
  v === 1 || v === 2 || v === 3;

export type StrikeReasonResult =
  { ok: true; value: string } | { ok: false; code: "reason_required" | "validation" };

/** Recorta con la misma semántica Unicode de la BD y exige 1..1000 puntos de código. */
export function normalizeStrikeReason(value: unknown): StrikeReasonResult {
  if (typeof value !== "string") return { ok: false, code: "validation" };
  if (BLANK.test(value)) return { ok: false, code: "reason_required" };
  const trimmed = value.replace(TRIM, "");
  if ([...trimmed].length > STRIKE_REASON_MAX_CODE_POINTS)
    return { ok: false, code: "validation" };
  return { ok: true, value: trimmed };
}

function plainObject(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}
const onlyKeys = (o: Record<string, unknown>, allowed: string[]) =>
  Object.keys(o).every((k) => allowed.includes(k));

export interface StrikeApplyInput {
  decisionId: string;
  reason: string;
  expectedLevel: StrikeLevel | null;
}
export type StrikeInputResult<T> =
  { ok: true; value: T } | { ok: false; code: "reason_required" | "validation" };

/** Cuerpo mínimo; cualquier campo desconocido (userId, level, endsAt, caseId…) se rechaza. */
export function parseStrikeApplyInput(
  body: unknown,
): StrikeInputResult<StrikeApplyInput> {
  const o = plainObject(body);
  if (!o || !onlyKeys(o, ["decisionId", "reason", "expectedLevel"]))
    return { ok: false, code: "validation" };
  if (!isStrikeUuid(o.decisionId)) return { ok: false, code: "validation" };
  const reason = normalizeStrikeReason(o.reason);
  if ("code" in reason) return { ok: false, code: reason.code };
  let expectedLevel: StrikeLevel | null = null;
  if (o.expectedLevel !== undefined && o.expectedLevel !== null) {
    if (!isStrikeLevel(o.expectedLevel)) return { ok: false, code: "validation" };
    expectedLevel = o.expectedLevel;
  }
  return {
    ok: true,
    value: { decisionId: o.decisionId, reason: reason.value, expectedLevel },
  };
}

export interface StrikeRevokeInput {
  strikeId: string;
  reason: string;
}
export function parseStrikeRevokeInput(
  body: unknown,
): StrikeInputResult<StrikeRevokeInput> {
  const o = plainObject(body);
  if (!o || !onlyKeys(o, ["strikeId", "reason"]))
    return { ok: false, code: "validation" };
  if (!isStrikeUuid(o.strikeId)) return { ok: false, code: "validation" };
  const reason = normalizeStrikeReason(o.reason);
  if ("code" in reason) return { ok: false, code: reason.code };
  return { ok: true, value: { strikeId: o.strikeId, reason: reason.value } };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Respuestas de las mutaciones (proyección explícita)

export interface StrikeApplyResponse {
  strike: {
    id: string;
    decisionId: string;
    level: StrikeLevel;
    reason: string;
    permanent: boolean;
    startsAt: string;
    endsAt: string | null;
    revoked: false;
    sanctionInEffect: true;
  };
}
export interface StrikeRevokeResponse {
  strike: { id: string; level: StrikeLevel; revoked: true; revokedAt: string };
}

const isIso = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(v) &&
  Number.isFinite(Date.parse(v));
const rec = (v: unknown): Record<string, unknown> => {
  const o = plainObject(v);
  if (!o) throw new Error("Invalid strike payload");
  return o;
};

/** Proyecta el resultado de community_strike_apply; lanza si la forma no es la esperada. */
export function projectStrikeApplyResult(
  data: unknown,
  reason: string,
): StrikeApplyResponse {
  const r = rec(data);
  if (
    !isStrikeUuid(r.strikeId) ||
    !isStrikeUuid(r.decisionId) ||
    !isStrikeLevel(r.level) ||
    typeof r.permanent !== "boolean" ||
    r.permanent !== (r.level === 3) ||
    !isIso(r.startsAt) ||
    (r.endsAt !== null && !isIso(r.endsAt)) ||
    r.permanent !== (r.endsAt === null)
  )
    throw new Error("Invalid strike payload");
  return {
    strike: {
      id: r.strikeId,
      decisionId: r.decisionId,
      level: r.level,
      reason,
      permanent: r.permanent,
      startsAt: r.startsAt,
      endsAt: r.endsAt as string | null,
      revoked: false,
      sanctionInEffect: true,
    },
  };
}

export function projectStrikeRevokeResult(data: unknown): StrikeRevokeResponse {
  const r = rec(data);
  if (!isStrikeUuid(r.strikeId) || !isStrikeLevel(r.level) || !isIso(r.revokedAt))
    throw new Error("Invalid strike payload");
  return {
    strike: { id: r.strikeId, level: r.level, revoked: true, revokedAt: r.revokedAt },
  };
}

/**
 * Cliente: valida la respuesta HTTP de apply (ya proyectada por el backend con
 * projectStrikeApplyResult). Estricto: cualquier otra forma lanza.
 */
export function parseStrikeApplyResponse(value: unknown): StrikeApplyResponse {
  const s = rec(rec(value).strike);
  if (
    !isStrikeUuid(s.id) ||
    !isStrikeUuid(s.decisionId) ||
    !isStrikeLevel(s.level) ||
    typeof s.reason !== "string" ||
    s.reason.length === 0 ||
    typeof s.permanent !== "boolean" ||
    s.permanent !== (s.level === 3) ||
    !isIso(s.startsAt) ||
    (s.endsAt !== null && !isIso(s.endsAt)) ||
    s.permanent !== (s.endsAt === null) ||
    s.revoked !== false ||
    s.sanctionInEffect !== true
  )
    throw new Error("Invalid strike payload");
  return {
    strike: {
      id: s.id,
      decisionId: s.decisionId,
      level: s.level,
      reason: s.reason,
      permanent: s.permanent,
      startsAt: s.startsAt,
      endsAt: s.endsAt as string | null,
      revoked: false,
      sanctionInEffect: true,
    },
  };
}
export function parseStrikeRevokeResponse(value: unknown): StrikeRevokeResponse {
  const s = rec(rec(value).strike);
  if (
    !isStrikeUuid(s.id) ||
    !isStrikeLevel(s.level) ||
    s.revoked !== true ||
    !isIso(s.revokedAt)
  )
    throw new Error("Invalid strike payload");
  return { strike: { id: s.id, level: s.level, revoked: true, revokedAt: s.revokedAt } };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Estado de strike del detalle de caso (community_strike_state_read → bloque seguro)

export const STRIKE_INELIGIBLE_REASONS = [
  "decision_not_content_actioned",
  "case_not_closed",
  "author_unavailable",
  "self_strike_forbidden",
  "strike_already_issued",
] as const;
export type StrikeIneligibleReason = (typeof STRIKE_INELIGIBLE_REASONS)[number];

export interface ModerationStrikeState {
  /** ¿Se puede aplicar ahora? Informativo: la BD lo revalida bajo locks al aplicar. */
  eligible: boolean;
  ineligibleReason: StrikeIneligibleReason | null;
  /** Nivel que aplicaría el servidor ahora mismo (predicción, NO autoridad). */
  predictedLevel: StrikeLevel | null;
  /** Decisión Procede a la que se aplicaría (necesaria para la acción de la UI). */
  decisionId: string | null;
  existing: {
    id: string;
    level: StrikeLevel;
    reason: string;
    permanent: boolean;
    startsAt: string;
    endsAt: string | null;
    revoked: boolean;
    sanctionInEffect: boolean;
    revokedAt: string | null;
    revocationReason: string | null;
    canRevoke: boolean;
  } | null;
}

const nullableIso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (!isIso(v)) throw new Error("Invalid strike state");
  return v;
};

/** Valida y proyecta el bloque. Lanza ante cualquier forma inesperada (el llamador decide degradar). */
export function parseModerationStrikeState(value: unknown): ModerationStrikeState {
  const r = rec(value);
  if (typeof r.eligible !== "boolean") throw new Error("Invalid strike state");
  const reason = r.ineligibleReason ?? null;
  if (
    reason !== null &&
    !(STRIKE_INELIGIBLE_REASONS as readonly unknown[]).includes(reason)
  )
    throw new Error("Invalid strike state");
  if (r.eligible && reason !== null) throw new Error("Invalid strike state");
  if (!r.eligible && reason === null) throw new Error("Invalid strike state");
  const predicted = r.predictedLevel ?? null;
  if (predicted !== null && !isStrikeLevel(predicted))
    throw new Error("Invalid strike state");
  if (r.eligible && predicted === null) throw new Error("Invalid strike state");
  const rawDecisionId = r.decisionId ?? null;
  let decisionId: string | null = null;
  if (rawDecisionId !== null) {
    if (!isStrikeUuid(rawDecisionId)) throw new Error("Invalid strike state");
    decisionId = rawDecisionId;
  }
  let existing: ModerationStrikeState["existing"] = null;
  if (r.existing !== null && r.existing !== undefined) {
    const e = rec(r.existing);
    if (
      !isStrikeUuid(e.id) ||
      !isStrikeLevel(e.level) ||
      typeof e.reason !== "string" ||
      e.reason.length === 0 ||
      typeof e.permanent !== "boolean" ||
      e.permanent !== (e.level === 3) ||
      typeof e.revoked !== "boolean" ||
      typeof e.sanctionInEffect !== "boolean" ||
      typeof e.canRevoke !== "boolean" ||
      (e.revoked && e.sanctionInEffect) ||
      (e.revoked && e.canRevoke) ||
      (e.revocationReason !== null &&
        e.revocationReason !== undefined &&
        typeof e.revocationReason !== "string")
    )
      throw new Error("Invalid strike state");
    const endsAt = nullableIso(e.endsAt);
    if (e.permanent !== (endsAt === null)) throw new Error("Invalid strike state");
    const startsAt = nullableIso(e.startsAt);
    if (startsAt === null) throw new Error("Invalid strike state");
    const revokedAt = nullableIso(e.revokedAt);
    if (e.revoked !== (revokedAt !== null)) throw new Error("Invalid strike state");
    existing = {
      id: e.id,
      level: e.level,
      reason: e.reason,
      permanent: e.permanent,
      startsAt,
      endsAt,
      revoked: e.revoked,
      sanctionInEffect: e.sanctionInEffect,
      revokedAt,
      revocationReason: (e.revocationReason as string | null | undefined) ?? null,
      canRevoke: e.canRevoke,
    };
  }
  if (existing && r.eligible) throw new Error("Invalid strike state");
  return {
    eligible: r.eligible,
    ineligibleReason: reason as StrikeIneligibleReason | null,
    predictedLevel: predicted as StrikeLevel | null,
    decisionId,
    existing,
  };
}

/**
 * Traduce la salida CRUDA de community_strike_state_read (R5-B) al bloque seguro. Descarta todo lo
 * que no esté en la lista explícita (serverNow, createdAt, hasDecision…).
 */
export function projectStrikeStateRead(data: unknown): ModerationStrikeState {
  const r = rec(data);
  const s = r.strike === null || r.strike === undefined ? null : rec(r.strike);
  return parseModerationStrikeState({
    eligible: r.eligible,
    ineligibleReason: r.ineligibleReason ?? null,
    predictedLevel: r.nextLevel ?? null,
    decisionId: r.decisionId ?? null,
    existing: s
      ? {
          id: s.strikeId,
          level: s.level,
          reason: s.reason,
          permanent: s.permanent,
          startsAt: s.startsAt,
          endsAt: s.endsAt ?? null,
          revoked: s.status === "revoked",
          sanctionInEffect: s.sanctionInEffect,
          revokedAt: s.revokedAt ?? null,
          revocationReason: s.revocationReason ?? null,
          canRevoke: r.canRevoke === true,
        }
      : null,
  });
}
