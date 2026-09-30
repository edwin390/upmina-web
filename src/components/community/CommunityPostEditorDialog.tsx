import { useEffect, useRef } from "react";
import CommunityPostEditorForm from "./CommunityPostEditorForm";
import type { CommunityOwnPost } from "@/lib/community-client";

// Modal ligero para "Nueva publicación"/"Editar publicación" desde el perfil público PROPIO
// (Fase 9J-2B.1, ver ProfilePage.tsx). Nunca reimplementa el formulario: envuelve
// CommunityPostEditorForm.tsx TAL CUAL (la misma implementación que ya usa
// CommunityPostsSection.tsx en /account, inline sin modal) con el chrome mínimo de diálogo —
// fondo, panel, título, botón cerrar, Escape para cerrar. El perfil público NUNCA muestra el
// formulario completo permanentemente debajo del encabezado (el checkpoint es explícito): este
// diálogo se monta/desmonta bajo demanda.

export interface CommunityPostEditorDialogProps {
  /** null = crear una publicación nueva; con valor = editar esa publicación propia. */
  initialPost: CommunityOwnPost | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function CommunityPostEditorDialog({
  initialPost,
  onClose,
  onSaved,
}: CommunityPostEditorDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-bg-base/80 px-4 py-8 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="community-post-editor-heading"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-lg rounded-lg border border-border-subtle bg-bg-surface p-6 focus-visible:outline-none"
      >
        <div className="flex items-center justify-between gap-4">
          <h2
            id="community-post-editor-heading"
            className="font-display text-xl tracking-wide text-text-primary"
          >
            {initialPost ? "Editar publicación" : "Nueva publicación"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border-subtle text-text-secondary transition-colors hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <CommunityPostEditorForm
          initialPost={initialPost}
          onSaved={onSaved}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}
