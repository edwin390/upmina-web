import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { showActionSuccess } from "@/lib/action-notice";
import {
  CommunityClientError,
  deleteCommunityPost,
  type CommunityOwnPost,
} from "@/lib/community-client";

// Menú contextual "⋯" por tarjeta de la galería del DUEÑO en su propio /@username (Fase
// 9J-2B.1) — mismo patrón que CosplayCardAdminMenu.tsx: un botón "⋯" con un menú desplegable
// (Editar/Eliminar), montado solo para el dueño real (ver ProfilePage.tsx — la derivación de
// ownership nunca ocurre aquí). A diferencia de Cosplay, borrar Comunidad NUNCA exige MFA/step-up
// (gestionar contenido propio no es una operación privilegiada, ver community-post-handlers.ts):
// no hay flujo de "step up" que iniciar, solo confirmación explícita → deleteCommunityPost →
// re-verificación de PROPIEDAD server-side bajo lock (nunca confiada del cliente).

interface Props {
  post: CommunityOwnPost;
  onEdit: (post: CommunityOwnPost) => void;
  onDeleted: () => void;
  allowEdit?: boolean;
}

const MENU_ITEM =
  "block w-full rounded px-2 py-2 text-left sm:px-3 text-sm text-text-primary hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";
const DANGER_BUTTON =
  "inline-flex min-h-9 items-center rounded-md border border-accent-live/60 px-3 py-1.5 text-sm font-semibold text-accent-live transition-colors hover:bg-accent-live/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-live disabled:pointer-events-none disabled:opacity-50";
const SECONDARY_BUTTON =
  "inline-flex min-h-9 items-center rounded-md border border-border-subtle px-3 py-1.5 text-sm font-semibold text-text-secondary transition-colors hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";

export default function CommunityPostTileMenu({
  post,
  onEdit,
  onDeleted,
  allowEdit = true,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    if (!confirming) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>("[data-cancel]")?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [confirming]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  const stop = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleEditClick: React.MouseEventHandler = (event) => {
    stop(event);
    setMenuOpen(false);
    onEdit(post);
  };

  const handleDeleteClick: React.MouseEventHandler = (event) => {
    stop(event);
    setMenuOpen(false);
    setErrorText(null);
    setConfirming(true);
  };

  const cancelDelete: React.MouseEventHandler = (event) => {
    stop(event);
    setConfirming(false);
  };

  const confirmDelete: React.MouseEventHandler = async (event) => {
    stop(event);
    setDeleting(true);
    setErrorText(null);
    try {
      await deleteCommunityPost({ postId: post.id, expectedVersion: post.version });
      setConfirming(false);
      showActionSuccess("Publicación eliminada correctamente");
      onDeleted();
    } catch (err) {
      if (err instanceof CommunityClientError) {
        if (err.code === "community_version_conflict") {
          setErrorText(
            "No se pudo eliminar la publicación. Esta publicación cambió mientras tanto. Vuelve a intentarlo.",
          );
          setConfirming(false);
          return;
        }
        setErrorText("No se pudo eliminar la publicación");
        return;
      }
      setErrorText("No se pudo eliminar la publicación");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className="relative flex justify-end"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={(event) => {
          stop(event);
          setMenuOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Gestionar esta publicación"
        className="flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-base leading-none text-white shadow-sm ring-1 ring-inset ring-white/10 transition-colors hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
      >
        <span aria-hidden="true">⋯</span>
      </button>

      {menuOpen && (
        <div
          role="menu"
          aria-label="Gestionar esta publicación"
          className="absolute right-0 top-full z-20 mt-1 w-32 max-w-full rounded-md border border-border-subtle bg-bg-surface p-1 shadow-lg"
        >
          {allowEdit && post.status === "published" && (
            <button
              type="button"
              role="menuitem"
              onClick={handleEditClick}
              className={MENU_ITEM}
            >
              Editar
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={handleDeleteClick}
            className={MENU_ITEM}
          >
            Eliminar
          </button>
        </div>
      )}

      {confirming &&
        createPortal(
          <dialog
            ref={dialogRef}
            aria-labelledby={headingId}
            onCancel={(event) => {
              event.preventDefault();
              if (!deleting) setConfirming(false);
            }}
            className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-sm overflow-y-auto rounded-md border border-accent-live/40 bg-bg-surface p-6 shadow-lg backdrop:bg-bg-base/80"
          >
            <p id={headingId} className="text-sm font-semibold text-text-primary">
              ¿Borrar esta publicación?
            </p>
            <p className="mt-1 text-sm text-text-secondary">
              Esta acción no se puede deshacer.
            </p>
            {errorText && (
              <p role="alert" className="mt-3 text-sm text-accent-live">
                {errorText}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={(e) => void confirmDelete(e)}
                disabled={deleting}
                aria-busy={deleting}
                className={DANGER_BUTTON}
              >
                Eliminar
              </button>
              <button
                type="button"
                data-cancel
                onClick={cancelDelete}
                disabled={deleting}
                className={SECONDARY_BUTTON}
              >
                Cancelar
              </button>
            </div>
          </dialog>,
          document.body,
        )}

      {errorText && !confirming && (
        <p
          role="alert"
          className="absolute right-0 top-full z-20 mt-1 w-56 rounded-md border border-accent-live/40 bg-bg-surface p-2 text-sm text-accent-live shadow-lg"
        >
          {errorText}
        </p>
      )}
    </div>
  );
}
