import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import {
  CosplayAdminClientError,
  deleteCosplayPost,
  listCosplayPostsAdmin,
  type CosplayAdminPostSummary,
} from "@/lib/cosplay-admin-client";

// Panel de descubrimiento ADMIN de Cosplay (Fase 9I-3, checkpoint 3, sección 17): la forma más
// pequeña de hacer descubribles los borradores sin crear una página /admin/cosplay aparte. Vive
// DENTRO de /cosplay, gated en PrivilegedOnly por quien lo monta (CosplaySection) — este
// componente asume que ya se decidió mostrarlo, nunca vuelve a comprobar capacidad (el backend
// SIEMPRE la revalida en cada acción, aquí solo se listan/borran publicaciones).
//
// Borrar aquí es el flujo destructivo COMPLETO (sección 15/F del checkpoint 2): confirmación
// explícita → backend → si falta MFA reciente, step-up con returnTo=/cosplay?intent=delete (sin
// portar qué publicación — al volver, este panel se reabre para que el ADMIN vuelva a elegir,
// nunca se reproduce el borrado automáticamente).

export const COSPLAY_ADMIN_LIST_QUERY_KEY = ["cosplay", "admin", "list"] as const;

interface Props {
  onOpenEdit: (postId: string) => void;
  /** true tras volver de un step-up con ?intent=edit|delete: se abre el panel para que el ADMIN
   *  re-seleccione, nunca se identifica automáticamente una publicación concreta. */
  autoOpen: boolean;
}

export default function CosplayAdminPanel({ onOpenEdit, autoOpen }: Props) {
  const t = useTranslations("cosplay.admin");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(autoOpen);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErrorCode, setDeleteErrorCode] = useState<string | null>(null);

  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);

  const query = useQuery({
    queryKey: COSPLAY_ADMIN_LIST_QUERY_KEY,
    queryFn: listCosplayPostsAdmin,
    enabled: open,
    staleTime: 5_000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: COSPLAY_ADMIN_LIST_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ["cosplay", "list"] });
  };

  const confirmDelete = async (post: CosplayAdminPostSummary) => {
    setDeleting(true);
    setDeleteErrorCode(null);
    try {
      await deleteCosplayPost({ postId: post.id, expectedVersion: post.version });
      setPendingDeleteId(null);
      refresh();
    } catch (err) {
      if (err instanceof CosplayAdminClientError) {
        if (err.privilegedFailure === "step_up_required") {
          navigate("/admin/mfa?returnTo=/cosplay?intent=delete");
          return;
        }
        if (err.code === "cosplay_version_conflict") {
          setDeleteErrorCode("cosplay_version_conflict");
          refresh();
          return;
        }
        setDeleteErrorCode(err.code ?? "generic");
        return;
      }
      setDeleteErrorCode("generic");
    } finally {
      setDeleting(false);
    }
  };

  const SECONDARY =
    "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-3 py-1.5 text-sm font-semibold text-text-secondary transition-colors hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";
  const DANGER =
    "inline-flex min-h-11 items-center rounded-md border border-accent-live/60 px-3 py-1.5 text-sm font-semibold text-accent-live transition-colors hover:bg-accent-live/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-live disabled:pointer-events-none disabled:opacity-50";

  return (
    <section
      className="mx-auto mt-8 max-w-6xl rounded-lg border border-border-subtle p-4"
      aria-labelledby="cosplay-admin-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="cosplay-admin-heading" className="font-display text-lg text-text-primary">
          {t("panelHeading")}
        </h2>
        <button type="button" onClick={() => setOpen((v) => !v)} className={SECONDARY}>
          {open ? t("close") : t("panelHeading")}
        </button>
      </div>

      {open && (
        <div className="mt-4">
          {query.isLoading && (
            <p role="status" className="text-sm text-text-secondary">
              {t("loadingPosts")}
            </p>
          )}
          {query.isError && (
            <p role="alert" className="text-sm text-accent-live">
              {t("loadPostsError")}
            </p>
          )}
          {query.data && query.data.length === 0 && (
            <p className="text-sm text-text-secondary">{t("noPosts")}</p>
          )}
          {query.data && query.data.length > 0 && (
            <ul className="mt-2 divide-y divide-border-subtle">
              {query.data.map((post) => (
                <li key={post.id} className="min-w-0 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text-primary">
                        {post.title}
                      </p>
                      <p className="text-xs text-text-muted">
                        {post.status === "published"
                          ? t("statusPublished")
                          : t("statusDraft")}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => onOpenEdit(post.id)}
                        className={SECONDARY}
                      >
                        {t("edit")}
                      </button>
                      {pendingDeleteId !== post.id && (
                        <button
                          type="button"
                          onClick={() => {
                            setPendingDeleteId(post.id);
                            setDeleteErrorCode(null);
                          }}
                          className={DANGER}
                        >
                          {t("delete")}
                        </button>
                      )}
                    </div>
                  </div>

                  {pendingDeleteId === post.id && (
                    <div
                      role="group"
                      aria-label={t("deletePost.confirmHeading")}
                      className="mt-3 rounded-md border border-accent-live/40 p-3"
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
                          onClick={() => void confirmDelete(post)}
                          disabled={deleting}
                          aria-busy={deleting}
                          className={DANGER}
                        >
                          {t("deletePost.confirmAction")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingDeleteId(null)}
                          disabled={deleting}
                          className={SECONDARY}
                        >
                          {t("deletePost.cancel")}
                        </button>
                      </div>
                      {deleteErrorCode && (
                        <p role="alert" className="mt-2 text-sm text-accent-live">
                          {t(`errors.${deleteErrorCode}` as never)}
                        </p>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
