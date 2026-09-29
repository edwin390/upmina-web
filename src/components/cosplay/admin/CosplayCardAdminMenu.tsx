import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslations } from "use-intl";
import {
  CosplayAdminClientError,
  deleteCosplayPost,
  getCosplayPostAdmin,
} from "@/lib/cosplay-admin-client";

// Menú contextual ADMIN por tarjeta (reemplaza el panel "Tus publicaciones" — ver CLAUDE.md,
// ajuste UX posterior a 9I-3): cada tarjeta pública de Cosplay es ahora también la superficie de
// gestión, en vez de duplicar el catálogo en una lista aparte que no escala. Montado SOLO dentro
// de PrivilegedOnly (por CosplayCard/CosplayHero) — este componente nunca vuelve a comprobar
// capacidad, el backend SIEMPRE la revalida en cada acción.
//
// El catálogo público NUNCA exige MFA solo para renderizarse: este menú tampoco la comprueba al
// abrirse (es puramente presentacional). La única llamada de red que puede exigir MFA reciente es
// getCosplayPostAdmin() al pulsar "Eliminar" (se necesita la versión ACTUAL para el borrado
// optimista) — ahí es donde de verdad se cruza la frontera de acción privilegiada, nunca antes.
//
// Borrar es el flujo destructivo COMPLETO: confirmación explícita → backend → si falta MFA
// reciente (en la lectura de versión o en el propio borrado), step-up con
// returnTo=/cosplay?intent=delete (sin portar qué publicación). Al volver, este menú simplemente
// ya no está en pantalla (el step-up navega fuera de /cosplay y de vuelta) — el ADMIN debe abrir
// el menú y confirmar de nuevo, nunca se reproduce el borrado automáticamente.

interface Props {
  postId: string;
  postTitle: string;
  onEdit: (postId: string) => void;
  onDeleted: () => void;
}

export default function CosplayCardAdminMenu({
  postId,
  postTitle,
  onEdit,
  onDeleted,
}: Props) {
  const t = useTranslations("cosplay.admin");
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pendingVersion, setPendingVersion] = useState<number | null>(null);
  const [loadingVersion, setLoadingVersion] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

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
    onEdit(postId);
  };

  const goToStepUp = () => {
    navigate(`/admin/mfa?returnTo=${encodeURIComponent("/cosplay?intent=delete")}`);
  };

  const handleDeleteClick: React.MouseEventHandler = async (event) => {
    stop(event);
    setMenuOpen(false);
    setErrorCode(null);
    setLoadingVersion(true);
    try {
      const detail = await getCosplayPostAdmin(postId);
      setPendingVersion(detail.version);
      setConfirming(true);
    } catch (err) {
      if (err instanceof CosplayAdminClientError) {
        if (err.privilegedFailure === "step_up_required") {
          goToStepUp();
          return;
        }
        setErrorCode(err.code ?? "generic");
        return;
      }
      setErrorCode("generic");
    } finally {
      setLoadingVersion(false);
    }
  };

  const cancelDelete: React.MouseEventHandler = (event) => {
    stop(event);
    setConfirming(false);
    setPendingVersion(null);
  };

  const confirmDelete: React.MouseEventHandler = async (event) => {
    stop(event);
    if (pendingVersion === null) return;
    setDeleting(true);
    setErrorCode(null);
    try {
      await deleteCosplayPost({ postId, expectedVersion: pendingVersion });
      setConfirming(false);
      setPendingVersion(null);
      onDeleted();
    } catch (err) {
      if (err instanceof CosplayAdminClientError) {
        if (err.privilegedFailure === "step_up_required") {
          goToStepUp();
          return;
        }
        if (err.code === "cosplay_version_conflict") {
          setErrorCode("cosplay_version_conflict");
          setConfirming(false);
          return;
        }
        setErrorCode(err.code ?? "generic");
        return;
      }
      setErrorCode("generic");
    } finally {
      setDeleting(false);
    }
  };

  const MENU_ITEM =
    "block w-full rounded px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";
  const DANGER_BUTTON =
    "inline-flex min-h-9 items-center rounded-md border border-accent-live/60 px-3 py-1.5 text-sm font-semibold text-accent-live transition-colors hover:bg-accent-live/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-live disabled:pointer-events-none disabled:opacity-50";
  const SECONDARY_BUTTON =
    "inline-flex min-h-9 items-center rounded-md border border-border-subtle px-3 py-1.5 text-sm font-semibold text-text-secondary transition-colors hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";

  return (
    <div ref={rootRef} className="relative" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        onClick={(event) => {
          stop(event);
          setMenuOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={t("cardMenu.open", { title: postTitle })}
        disabled={loadingVersion}
        aria-busy={loadingVersion}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-lg leading-none text-white transition-colors hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50"
      >
        <span aria-hidden="true">⋯</span>
      </button>

      {menuOpen && (
        <div
          role="menu"
          aria-label={t("cardMenu.open", { title: postTitle })}
          className="absolute right-0 top-full z-20 mt-1 w-32 rounded-md border border-border-subtle bg-bg-surface p-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleEditClick}
            className={MENU_ITEM}
          >
            {t("edit")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleDeleteClick}
            className={MENU_ITEM}
          >
            {t("delete")}
          </button>
        </div>
      )}

      {confirming && (
        <div
          role="group"
          aria-label={t("deletePost.confirmHeading")}
          className="absolute right-0 top-full z-20 mt-1 w-64 rounded-md border border-accent-live/40 bg-bg-surface p-3 shadow-lg"
        >
          <p className="text-sm font-semibold text-text-primary">
            {t("deletePost.confirmHeading")}
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            {t("deletePost.confirmBody")}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={confirmDelete}
              disabled={deleting}
              aria-busy={deleting}
              className={DANGER_BUTTON}
            >
              {t("deletePost.confirmAction")}
            </button>
            <button
              type="button"
              onClick={cancelDelete}
              disabled={deleting}
              className={SECONDARY_BUTTON}
            >
              {t("deletePost.cancel")}
            </button>
          </div>
        </div>
      )}

      {errorCode && !confirming && (
        <p
          role="alert"
          className="absolute right-0 top-full z-20 mt-1 w-56 rounded-md border border-accent-live/40 bg-bg-surface p-2 text-sm text-accent-live shadow-lg"
        >
          {t(`errors.${errorCode}` as never)}
        </p>
      )}
    </div>
  );
}
