import { useEffect, useRef, useState } from "react";
import { useCosplayEditorSession } from "@/hooks/useCosplayEditorSession";
import CosplayInlineMfa from "./CosplayInlineMfa";
import { useTranslations } from "use-intl";
import { useCosplayEditor } from "@/hooks/useCosplayEditor";
import CosplayPhotoCard from "./CosplayPhotoCard";

// Editor ADMIN de Cosplay (Fase 9I-3, checkpoint 3, sección 3): diálogo responsivo en /cosplay
// (nunca /cosplay/new ni /cosplay/:id/edit — el checkpoint 2 ya congeló ese contrato vía
// safe-return-to.ts/RETURN_ROUTES). Mismo patrón nativo que CosplayLightbox: <dialog>.showModal()
// da focus trap y fondo inerte nativos; Escape se intercepta (onCancel) para pasar por el mismo
// aviso de cambios sin guardar que el botón de cerrar, nunca cierra un estado destructivo
// silenciosamente.

const FIELD_CLASS =
  "mt-1 w-full rounded-md border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary";
const LABEL_CLASS = "block text-sm font-medium text-text-secondary";
const PRIMARY_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold text-text-inverse transition hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";
const SECONDARY_BUTTON =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-4 py-2 text-sm font-semibold text-text-secondary transition-colors hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";

interface Props {
  postId: string | null;
  resumeDraft?: boolean;
  onClose: () => void;
  onPostChanged: (status?: "draft" | "published") => void;
  /** Confirmed persistence only; the notice outlives this dialog. */
  onPublishSuccess: (message?: string) => void;
  returnFocusTo?: HTMLElement | null;
}

export default function CosplayEditorDialog({
  postId,
  resumeDraft = false,
  onClose,
  onPostChanged,
  onPublishSuccess,
  returnFocusTo,
}: Props) {
  const t = useTranslations("cosplay.admin");
  const session = useCosplayEditorSession();
  const [mfaNotice, setMfaNotice] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [saveAction, setSaveAction] = useState<"draft" | "published">("published");
  const [detachSuccess, setDetachSuccess] = useState(false);
  useEffect(() => {
    if (!detachSuccess) return;
    const timer = setTimeout(() => setDetachSuccess(false), 6000);
    return () => clearTimeout(timer);
  }, [detachSuccess]);

  const editor = useCosplayEditor({
    initialPostId: postId,
    resumeDraft,
    onPostChanged,
    session,
  });

  useEffect(() => {
    if (editor.stepUpIntent) {
      setDeleteConfirm(false);
      setCloseConfirm(false);
      setMfaNotice(false);
    } else dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [editor.stepUpIntent]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      requestAnimationFrame(() => {
        if (!dialog.isConnected) returnFocusTo?.focus?.();
      });
    };
  }, [returnFocusTo]);

  const attemptClose = () => {
    if (session.invalidSession) {
      onClose();
      return;
    }
    if (editor.stepUpIntent) {
      editor.cancelStepUp();
      return;
    }
    if (editor.isDirty) {
      setCloseConfirm(true);
      return;
    }
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-label={editor.postId ? t("editorTitleEdit") : t("editorTitleCreate")}
      onCancel={(event) => {
        event.preventDefault();
        attemptClose();
      }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden bg-bg-surface p-0 text-text-primary backdrop:bg-black/70 sm:inset-8 sm:m-auto sm:h-[min(90dvh,860px)] sm:w-[min(92vw,760px)] sm:rounded-lg sm:border sm:border-border-subtle"
    >
      <div className="flex h-full flex-col">
        <header className="flex shrink-0 items-center justify-between border-b border-border-subtle px-4 py-3">
          <h2 className="font-display text-lg text-text-primary">
            {editor.postId ? t("editorTitleEdit") : t("editorTitleCreate")}
          </h2>
          <button
            type="button"
            onClick={attemptClose}
            aria-label={t("close")}
            className="grid h-9 w-9 place-items-center rounded-full text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {session.invalidSession ? (
            <p role="alert">{t("mfa.sessionInvalid")}</p>
          ) : editor.stepUpIntent ? (
            <CosplayInlineMfa
              isCurrent={session.isCurrent}
              onCancel={editor.cancelStepUp}
              onVerified={() => {
                if (session.isActive()) {
                  editor.clearStepUpIntent();
                  setMfaNotice(true);
                }
              }}
            />
          ) : null}
          <div hidden={session.invalidSession || Boolean(editor.stepUpIntent)}>
            {mfaNotice && (
              <p role="status" className="mb-4">
                {t("mfa.verified")}
              </p>
            )}
            {editor.loadRetryRequired && (
              <button
                type="button"
                onClick={editor.retryInitialLoad}
                className={SECONDARY_BUTTON}
              >
                {t("mfa.retryLoad")}
              </button>
            )}

            {editor.loading && (
              <p role="status" className="text-sm text-text-secondary">
                {t("loadingPosts")}
              </p>
            )}
            {editor.loadError && (
              <p role="alert" className="text-sm text-accent-live">
                {editor.loadError}
              </p>
            )}

            {!editor.loading && !editor.loadError && !editor.loadRetryRequired && (
              <>
                {editor.conflict && !deleteConfirm && (
                  <div
                    role="alert"
                    className="mb-4 rounded-md border border-accent-warning/50 bg-accent-warning/10 p-3"
                  >
                    <p className="text-sm font-semibold text-text-primary">
                      {t("conflict.heading")}
                    </p>
                    <p className="mt-1 text-sm text-text-secondary">
                      {t("conflict.body")}
                    </p>
                    <button
                      type="button"
                      onClick={() => void editor.reloadFromServer()}
                      className={`${SECONDARY_BUTTON} mt-3`}
                    >
                      {t("conflict.reload")}
                    </button>
                  </div>
                )}

                <form
                  onSubmit={(event) => event.preventDefault()}
                  className="flex flex-col gap-4"
                >
                  <label className={LABEL_CLASS}>
                    {t("fields.title")}
                    <input
                      type="text"
                      required
                      data-autofocus
                      value={editor.fields.title}
                      onChange={(event) =>
                        editor.updateField("title", event.target.value)
                      }
                      maxLength={120}
                      className={FIELD_CLASS}
                    />
                  </label>

                  <label className={LABEL_CLASS}>
                    {t("fields.description")}
                    <textarea
                      value={editor.fields.description}
                      onChange={(event) =>
                        editor.updateField("description", event.target.value)
                      }
                      maxLength={2000}
                      rows={3}
                      className={FIELD_CLASS}
                    />
                  </label>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <label className={LABEL_CLASS}>
                      {t("fields.characterName")}
                      <input
                        type="text"
                        value={editor.fields.characterName}
                        onChange={(event) =>
                          editor.updateField("characterName", event.target.value)
                        }
                        maxLength={120}
                        className={FIELD_CLASS}
                      />
                    </label>
                    <label className={LABEL_CLASS}>
                      {t("fields.series")}
                      <input
                        type="text"
                        value={editor.fields.series}
                        onChange={(event) =>
                          editor.updateField("series", event.target.value)
                        }
                        maxLength={120}
                        className={FIELD_CLASS}
                      />
                    </label>
                  </div>

                  <section
                    aria-label={t("photos.heading")}
                    className="border-t border-border-subtle pt-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-semibold text-text-primary">
                        {t("photos.heading")}
                      </h3>
                      <p aria-live="polite" className="text-xs text-text-muted">
                        {editor.remainingCapacity > 0
                          ? t("photos.remaining", { count: editor.remainingCapacity })
                          : t("photos.limitReached")}
                      </p>
                    </div>

                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif"
                      multiple
                      className="sr-only"
                      onChange={(event) => {
                        if (event.target.files && event.target.files.length > 0) {
                          editor.addFiles(event.target.files);
                        }
                        event.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={editor.remainingCapacity <= 0}
                      className={`${SECONDARY_BUTTON} mt-2`}
                    >
                      {t("photos.addPhotos")}
                    </button>

                    <ul className="mt-3 space-y-3" aria-live="polite">
                      {editor.photos.map((photo, index) => (
                        <CosplayPhotoCard
                          key={photo.key}
                          photo={photo}
                          index={index}
                          total={editor.photos.length}
                          onMoveUp={() => editor.movePhoto(photo.key, -1)}
                          onMoveDown={() => editor.movePhoto(photo.key, 1)}
                          onSetCover={() => editor.setCover(photo.key)}
                          onRemove={() => {
                            setDetachSuccess(false);
                            if (photo.existingImageId)
                              editor.requestRemoveExisting(photo.key);
                            else editor.removeNewPhoto(photo.key);
                          }}
                          onRetry={() =>
                            photo.localId && editor.retryUpload(photo.localId)
                          }
                          pendingDetach={editor.pendingDetachKey === photo.key}
                          onConfirmDetach={() =>
                            void (async () => {
                              setDetachSuccess(false);
                              if (await editor.confirmRemoveExisting())
                                setDetachSuccess(true);
                            })()
                          }
                          onCancelDetach={editor.cancelRemoveExisting}
                          detaching={editor.detaching}
                          detachFailed={editor.detachErrorKey === photo.key}
                        />
                      ))}
                    </ul>
                  </section>

                  {detachSuccess && (
                    <p role="status" className="text-sm text-accent-secondary">
                      {t("feedback.photoRemoved")}
                    </p>
                  )}

                  {editor.saveErrorCode && (
                    <p role="alert" className="text-sm text-accent-live">
                      {t(
                        saveAction === "draft"
                          ? "feedback.draftFailed"
                          : editor.postId
                            ? "feedback.updateFailed"
                            : "feedback.publishFailed",
                      )}
                      {". "}
                      {t(`errors.${editor.saveErrorCode}` as never)}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2 border-t border-border-subtle pt-4">
                    <button
                      type="button"
                      onClick={() =>
                        void (async () => {
                          setSaveAction("draft");
                          const result = await editor.save("draft");
                          if (result) {
                            onPublishSuccess(t("feedback.draftSaved"));
                            onClose();
                          }
                        })()
                      }
                      disabled={!editor.canSave || editor.saving !== null}
                      aria-busy={editor.saving === "draft"}
                      className={SECONDARY_BUTTON}
                    >
                      {editor.saving === "draft"
                        ? t("actions.saving")
                        : t("actions.saveDraft")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void (async () => {
                          setSaveAction("published");
                          // Publicar exige confirmación REAL del backend antes de cerrar: si save()
                          // no devuelve resultado (fallo, conflicto de versión o step-up pendiente),
                          // el editor se queda abierto con todo lo introducido y el error existente
                          // ya visible (editor.saveErrorCode / editor.conflict / stepUpIntent).
                          const result = await editor.save("published");
                          if (result) {
                            onPublishSuccess(
                              t(editor.postId ? "feedback.updated" : "feedback.created"),
                            );
                            onClose();
                          }
                        })();
                      }}
                      disabled={!editor.canSave || editor.saving !== null}
                      aria-busy={editor.saving === "published"}
                      className={PRIMARY_BUTTON}
                    >
                      {editor.saving === "published"
                        ? t("actions.publishing")
                        : t("actions.publish")}
                    </button>
                    {editor.postId && editor.status === "draft" && (
                      <button
                        type="button"
                        onClick={() => setDeleteConfirm(true)}
                        disabled={editor.saving !== null || editor.deleting}
                        className={SECONDARY_BUTTON}
                      >
                        {t("feedback.deleteDraft")}
                      </button>
                    )}
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      </div>

      {deleteConfirm && !editor.stepUpIntent && !session.invalidSession && (
        <div className="absolute inset-0 grid place-items-center bg-black/60 p-4">
          <div
            role="alertdialog"
            aria-label={t("feedback.deleteDraft")}
            className="w-full max-w-sm rounded-lg border border-border-subtle bg-bg-surface p-4"
          >
            <p>{t("deletePost.confirmBody")}</p>
            {editor.deleteErrorCode && (
              <p role="alert">{t("feedback.draftDeleteFailed")}</p>
            )}
            {editor.conflict && <p role="alert">{t("conflict.body")}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={editor.deleting}
                className={SECONDARY_BUTTON}
                onClick={() =>
                  void (async () => {
                    if (await editor.confirmDelete()) {
                      onPublishSuccess(t("feedback.draftDeleted"));
                      onClose();
                    }
                  })()
                }
              >
                {t("deletePost.confirmAction")}
              </button>
              <button
                type="button"
                disabled={editor.deleting}
                className={SECONDARY_BUTTON}
                onClick={() => setDeleteConfirm(false)}
              >
                {t("deletePost.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {closeConfirm && !editor.stepUpIntent && !session.invalidSession && (
        <div className="absolute inset-0 grid place-items-center bg-black/60 p-4">
          <div
            role="alertdialog"
            aria-label={t("dirty.heading")}
            className="w-full max-w-sm rounded-lg border border-border-subtle bg-bg-surface p-4"
          >
            <p className="text-sm font-semibold text-text-primary">
              {t("dirty.heading")}
            </p>
            <p className="mt-1 text-sm text-text-secondary">{t("dirty.body")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setCloseConfirm(false);
                  onClose();
                }}
                className={SECONDARY_BUTTON}
              >
                {t("dirty.discard")}
              </button>
              <button
                type="button"
                onClick={() => setCloseConfirm(false)}
                className={PRIMARY_BUTTON}
              >
                {t("dirty.keepEditing")}
              </button>
            </div>
          </div>
        </div>
      )}
    </dialog>
  );
}
