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

export function formatRestrictionDate(iso: string, locale = "es"): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeStyle: "short",
  }).format(new Date(iso));
}

export interface RestrictionCopy {
  title: string;
  headline: string;
  /** Hasta cuándo (o permanente). null si el backend no pudo dar detalle. */
  duration: string | null;
  /** R5-F: advertencia sobre la siguiente sanción (solo Strike 1 y 2; Strike 3 es la máxima). */
  warning: string | null;
  reason: string | null;
  deleteHint: string;
}

/** Textos de producto del aviso. El español es el valor por defecto; la UI pasa los textos del idioma activo. */
export interface RestrictionStrings {
  title: string;
  deleteHint: string;
  noDetailHeadline: string;
  noDetailDuration: string;
  permanentDuration: string;
  levelHeadline: (level: number) => string;
  until: (date: string) => string;
  firstHeadline: string;
  firstWarning: string;
  secondHeadline: string;
  secondWarning: string;
}

export const RESTRICTION_TITLE = "Publicación restringida";
export const RESTRICTION_DELETE_HINT =
  "Puedes seguir eliminando tus propias publicaciones.";
export const RESTRICTION_CHANGED_MESSAGE =
  "El estado de tu restricción cambió. Vuelve a intentarlo.";

// Reglas reales (SQL de R5-B, sin cambios): el nivel es min(strikes NO revocados + 1, 3); Strike 1 =
// 14 días, Strike 2 = un mes calendario, Strike 3 = permanente. Una sanción que expira NO quita el
// strike de la escalada; solo la revocación lo hace. Los avisos se redactan con esa semántica y solo
// se generan a partir de una restricción VIGENTE leída del servidor: si expira o se revoca, el
// servidor deja de devolverla y no queda ningún aviso que afirme que continúa activa.
export const ES_RESTRICTION_STRINGS: RestrictionStrings = {
  title: RESTRICTION_TITLE,
  deleteHint: RESTRICTION_DELETE_HINT,
  noDetailHeadline: "Tu cuenta tiene una restricción activa en Community.",
  noDetailDuration: "No puedes crear ni editar publicaciones de Community por ahora.",
  permanentDuration:
    "No puedes crear ni editar publicaciones de Community de forma permanente.",
  levelHeadline: (level) => `Tu cuenta tiene un Strike ${level} activo en Community.`,
  until: (date) => `No puedes crear ni editar publicaciones hasta ${date}.`,
  firstHeadline:
    "Has recibido tu primer strike por incumplir las normas de la comunidad.",
  firstWarning:
    "Advertencia: los strikes siguen contando aunque termine su restricción temporal, salvo que sean revocados. Un segundo strike supondrá una restricción de un mes y un tercero, la pérdida permanente del permiso para publicar.",
  secondHeadline: "Has recibido tu segundo strike.",
  secondWarning:
    "Última advertencia: si recibes un tercer strike, perderás permanentemente el permiso para crear y editar publicaciones en la comunidad. Los strikes anteriores siguen contando incluso después de cumplir su restricción, salvo que sean revocados.",
};

export function restrictionCopy(
  r: AuthorRestrictionView | null,
  s: RestrictionStrings = ES_RESTRICTION_STRINGS,
  locale = "es",
): RestrictionCopy {
  if (!r) {
    return {
      title: s.title,
      headline: s.noDetailHeadline,
      duration: s.noDetailDuration,
      warning: null,
      reason: null,
      deleteHint: s.deleteHint,
    };
  }
  if (r.permanent || !r.endsAt) {
    return {
      title: s.title,
      headline: s.levelHeadline(r.level),
      duration: s.permanentDuration,
      warning: null,
      reason: r.reason,
      deleteHint: s.deleteHint,
    };
  }
  const until = s.until(formatRestrictionDate(r.endsAt, locale));
  if (r.level === 1) {
    return {
      title: s.title,
      headline: s.firstHeadline,
      duration: until,
      warning: s.firstWarning,
      reason: r.reason,
      deleteHint: s.deleteHint,
    };
  }
  if (r.level === 2) {
    return {
      title: s.title,
      headline: s.secondHeadline,
      duration: until,
      warning: s.secondWarning,
      reason: r.reason,
      deleteHint: s.deleteHint,
    };
  }
  // Un nivel 3 siempre es permanente (parseAuthorRestriction lo exige); defensa para formas imposibles.
  return {
    title: s.title,
    headline: s.levelHeadline(r.level),
    duration: until,
    warning: null,
    reason: r.reason,
    deleteHint: s.deleteHint,
  };
}
