import { CONTENT_UNAVAILABLE_MESSAGE } from "@/lib/deep-links";

/** Aviso discreto e integrado en la sección (no es un modal ni bloquea nada). */
export default function ContentNotice() {
  return (
    <p
      role="status"
      className="mb-4 rounded-lg border border-border-subtle bg-bg-surface px-3 py-2 text-sm text-text-secondary"
    >
      {CONTENT_UNAVAILABLE_MESSAGE}
    </p>
  );
}
