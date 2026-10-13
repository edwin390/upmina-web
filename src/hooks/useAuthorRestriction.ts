import { useCallback, useEffect, useState } from "react";
import type { AuthorRestrictionView } from "@/lib/author-restriction";
import { fetchAuthorRestriction } from "@/lib/community-client";
import { useAuth } from "@/lib/auth-context";

// R5-F: estado de la restricción de publicación de la sesión actual, consultado al ABRIR un editor.
// Sin caché ni almacenamiento: cada montaje pregunta al servidor (reloj de servidor), así que una
// sanción revocada o expirada deja de bloquear sin cerrar sesión. Mientras carga o si falla, el
// llamador NO debe mostrar el formulario. Una respuesta que llega tarde (otro intento, otra sesión
// u otro montaje) se descarta con una marca de cancelación por ejecución del efecto.

export type AuthorRestrictionState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "clear" }
  | { status: "restricted"; restriction: AuthorRestrictionView };

export function useAuthorRestriction(): AuthorRestrictionState & { retry: () => void } {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [state, setState] = useState<AuthorRestrictionState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // `cancelled` pertenece a ESTA ejecución del efecto: reintento, cambio de usuario o desmontaje
    // la invalidan, así que una respuesta tardía nunca modifica el estado actual.
    let cancelled = false;
    setState({ status: "loading" });
    fetchAuthorRestriction().then(
      (restriction) => {
        if (cancelled) return;
        setState(
          restriction ? { status: "restricted", restriction } : { status: "clear" },
        );
      },
      () => {
        if (cancelled) return;
        setState({ status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, userId]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}
