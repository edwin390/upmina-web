import {
  restrictionCopy,
  RESTRICTION_CHANGED_MESSAGE,
  type AuthorRestrictionView,
} from "@/lib/author-restriction";

// R5-E: aviso ÚNICO de restricción de publicación (strike). Lo usan el editor de Community y
// cualquier otra superficie que reciba `author_restricted`; no hay copias del texto por componente.
// Nunca muestra moderador, reportantes ni ids: solo nivel, plazo, motivo completo y el recordatorio
// de que el borrado propio sigue disponible.

interface Props {
  /** null = el backend respondió `author_restricted` pero no pudo dar detalle. */
  restriction: AuthorRestrictionView | null;
  /** 409 author_restriction_changed: mensaje neutro, sin detalle caduco. */
  changed?: boolean;
}

export default function CommunityRestrictionNotice({
  restriction,
  changed = false,
}: Props) {
  if (changed) {
    return (
      <p
        role="alert"
        data-testid="restriction-changed"
        className="mt-4 rounded-md border border-border-subtle p-3 text-sm text-text-secondary"
      >
        {RESTRICTION_CHANGED_MESSAGE}
      </p>
    );
  }
  const copy = restrictionCopy(restriction);
  return (
    <section
      role="alert"
      aria-labelledby="community-restriction-title"
      data-testid="restriction-notice"
      className="mt-4 min-w-0 space-y-2 rounded-md border border-accent-live/60 p-4 text-sm text-text-secondary"
    >
      <h3
        id="community-restriction-title"
        className="text-base font-semibold text-text-primary"
      >
        {copy.title}
      </h3>
      <p>{copy.headline}</p>
      {copy.duration && <p>{copy.duration}</p>}
      {copy.reason && (
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          <strong className="font-semibold text-text-primary">Motivo:</strong>{" "}
          {copy.reason}
        </p>
      )}
      <p>{copy.deleteHint}</p>
    </section>
  );
}
