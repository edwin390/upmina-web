// R5-E: representación ÚNICA (frontend) de la restricción de publicación por strike. Todos los
// puntos de escritura de Community (guardado, reserva de media, reorden, desadjuntar) la comparten:
// el backend responde 403 `author_restricted` con { level, permanent, endsAt, reason } (autoritativo,
// leído de la BD) o 409 `author_restriction_changed` (carrera: la restricción cambió). Este módulo
// solo parsea de forma estricta y redacta el texto de producto; nunca decide si alguien está
// restringido (eso es de la BD) y nunca expone moderador, caso, decisión ni reportantes.

export const AUTHOR_RESTRICTED = "author_restricted";
export const AUTHOR_RESTRICTION_CHANGED = "author_restriction_changed";

export interface AuthorRestrictionView {
  level: 1 | 2 | 3;
  permanent: boolean;
  endsAt: string | null;
  reason: string;
}

/** Proyección estricta del campo `restriction` de la respuesta; cualquier forma inesperada → null. */
export function parseAuthorRestriction(raw: unknown): AuthorRestrictionView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const level = r.level;
  if (level !== 1 && level !== 2 && level !== 3) return null;
  if (typeof r.permanent !== "boolean" || r.permanent !== (level === 3)) return null;
  if (typeof r.reason !== "string" || r.reason.length === 0) return null;
  if (r.permanent) {
    if (r.endsAt !== null) return null;
  } else if (typeof r.endsAt !== "string" || !Number.isFinite(Date.parse(r.endsAt))) {
    return null;
  }
  return {
    level,
    permanent: r.permanent,
    endsAt: r.permanent ? null : (r.endsAt as string),
    reason: r.reason,
  };
}

export type RestrictionOutcome =
  { kind: "restricted"; restriction: AuthorRestrictionView | null } | { kind: "changed" };

/** Clasifica cualquier error de cliente (Community/Media) que traiga `code` y `restriction`. */
export function restrictionOutcome(err: unknown): RestrictionOutcome | null {
  if (!err || typeof err !== "object") return null;
  const { code, restriction } = err as { code?: unknown; restriction?: unknown };
  if (code === AUTHOR_RESTRICTED)
    return {
      kind: "restricted",
      restriction: parseAuthorRestriction(restriction),
    };
  if (code === AUTHOR_RESTRICTION_CHANGED) return { kind: "changed" };
  return null;
}

export function formatRestrictionDate(iso: string): string {
  return new Intl.DateTimeFormat("es", { dateStyle: "long", timeStyle: "short" }).format(
    new Date(iso),
  );
}

export interface RestrictionCopy {
  title: string;
  headline: string;
  /** Hasta cuándo (o permanente). null si el backend no pudo dar detalle. */
  duration: string | null;
  reason: string | null;
  deleteHint: string;
}

export const RESTRICTION_TITLE = "Publicación restringida";
export const RESTRICTION_DELETE_HINT =
  "Puedes seguir eliminando tus propias publicaciones.";
export const RESTRICTION_CHANGED_MESSAGE =
  "El estado de tu restricción cambió. Vuelve a intentarlo.";

export function restrictionCopy(r: AuthorRestrictionView | null): RestrictionCopy {
  if (!r) {
    return {
      title: RESTRICTION_TITLE,
      headline: "Tu cuenta tiene una restricción activa en Community.",
      duration: "No puedes crear ni editar publicaciones de Community por ahora.",
      reason: null,
      deleteHint: RESTRICTION_DELETE_HINT,
    };
  }
  return {
    title: RESTRICTION_TITLE,
    headline: `Tu cuenta tiene un Strike ${r.level} activo en Community.`,
    duration:
      r.permanent || !r.endsAt
        ? "No puedes crear ni editar publicaciones de Community de forma permanente."
        : `No puedes crear ni editar publicaciones de Community hasta ${formatRestrictionDate(r.endsAt)}.`,
    reason: r.reason,
    deleteHint: RESTRICTION_DELETE_HINT,
  };
}
