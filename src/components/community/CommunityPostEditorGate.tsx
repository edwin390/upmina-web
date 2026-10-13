import CommunityPostEditorForm from "./CommunityPostEditorForm";
import CommunityRestrictionNotice from "./CommunityRestrictionNotice";
import { useAuthorRestriction } from "@/hooks/useAuthorRestriction";
import type { CommunityOwnPost } from "@/lib/community-client";

// R5-F: compuerta ÚNICA de apertura de los editores de Community (crear y editar). Antes de montar
// el formulario consulta la restricción de publicación vigente (GET autenticado, sin caché):
//  - cargando o error → NO se monta el formulario (ni el selector de archivos ni subidas);
//  - restringida → aviso `CommunityRestrictionNotice` en lugar del formulario;
//  - sin restricción confirmada por el servidor → el formulario de siempre.
// El servidor sigue siendo la autoridad (los escritores de la BD y la reserva de media rechazan
// igualmente); esto solo evita que alguien descubra la sanción después de preparar un borrador.
// El borrado de publicaciones propias no pasa por aquí y sigue disponible.

interface Props {
  initialPost: CommunityOwnPost | null;
  onSaved: () => void;
  onCancel: () => void;
}

export default function CommunityPostEditorGate(props: Props) {
  const state = useAuthorRestriction();

  if (state.status === "loading") {
    return (
      <p role="status" className="mt-4 text-sm text-text-secondary">
        Comprobando el estado de tu cuenta…
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <div role="alert" className="mt-4 space-y-3 text-sm text-text-secondary">
        <p>
          No pudimos comprobar el estado de tu cuenta, así que no abrimos el editor.
          Inténtalo de nuevo.
        </p>
        <button
          type="button"
          onClick={state.retry}
          className="inline-flex min-h-11 items-center justify-center rounded-md border border-border-subtle px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:border-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
        >
          Reintentar
        </button>
      </div>
    );
  }

  if (state.status === "restricted") {
    return (
      <div>
        <CommunityRestrictionNotice restriction={state.restriction} />
        <button
          type="button"
          onClick={props.onCancel}
          className="mt-4 inline-flex min-h-11 items-center justify-center rounded-md border border-border-subtle px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:border-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
        >
          Cerrar
        </button>
      </div>
    );
  }

  return <CommunityPostEditorForm {...props} />;
}
