import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useTranslations } from "use-intl";
import { useMediaUpload } from "@/hooks/useMediaUpload";
import { showActionSuccess } from "@/lib/action-notice";
import { restrictionOutcome, type RestrictionOutcome } from "@/lib/author-restriction";
import CommunityRestrictionNotice from "./CommunityRestrictionNotice";
import AccountIncompleteNotice from "./AccountIncompleteNotice";
import {
  accountIncompleteReason,
  type AccountIncompleteReason,
} from "@/lib/account-incomplete";
import {
  CommunityClientError,
  saveCommunityPost,
  type CommunityOwnPost,
} from "@/lib/community-client";

// Formulario de crear/editar una publicación PROPIA de Comunidad (Fase 9J-1C, extraído a su
// propio componente en 9J-2B.1): TODA la lógica de guardado (useMediaUpload, saveCommunityPost,
// validación de texto/media) vivía antes inline en CommunityPostsSection.tsx. Se extrajo para
// que el mismo formulario — la MISMA implementación, nunca una segunda — se reutilice en dos
// sitios con "chrome" distinto:
//   - CommunityPostsSection.tsx (/account): inline, sin modal, exactamente como antes.
//   - CommunityPostEditorDialog.tsx (perfil público propio, /@username): el mismo formulario
//     envuelto en un modal ligero.
// El JSX/las clases/los ids de este archivo son IDÉNTICOS a los que tenía
// CommunityPostsSection.tsx antes de la extracción — un cambio puramente estructural, sin
// ningún cambio de comportamiento ni de aspecto visual.

const COMMUNITY_POST_TEXT_MAX = 2000;
const COMMUNITY_POST_MAX_MEDIA = 10;
const COMMUNITY_POST_MAX_VIDEOS = 1;
/** Mismo mime/formato aceptado que el servidor (media-domain.ts VIDEO_MIME_TYPES) — el picker es
 *  UNO SOLO ("Añadir fotos o videos"), nunca dos controles separados (Fase 9J-3, sección 2). */
const MEDIA_PICKER_ACCEPT = "image/*,video/mp4,video/quicktime,video/webm";
/** Mismo techo que media-domain.ts MAX_VIDEO_SOURCE_BYTES — duplicado a propósito (constante
 *  literal, no import cruzado navegador↔servidor) para el rechazo temprano en el picker. */
const MAX_VIDEO_BYTES_CLIENT = 100 * 1024 * 1024;

type LocalMedia = {
  assetId: string;
  url: string | null;
  ready: boolean;
  key: string;
  kind: "image" | "video";
};

interface FormState {
  postId: string | null;
  expectedVersion: number | null;
  text: string;
  /** Media YA guardada (al editar) que el usuario no ha quitado. */
  existingMedia: LocalMedia[];
  removedMediaIds: string[];
}

function initialFormState(initialPost: CommunityOwnPost | null): FormState {
  if (!initialPost) {
    return {
      postId: null,
      expectedVersion: null,
      text: "",
      existingMedia: [],
      removedMediaIds: [],
    };
  }
  return {
    postId: initialPost.id,
    expectedVersion: initialPost.version,
    text: initialPost.text ?? "",
    removedMediaIds: [],
    existingMedia: initialPost.media.map((m) => ({
      assetId: m.assetId,
      url: m.url,
      ready: m.assetStatus === "ready",
      key: m.id,
      kind: m.kind,
    })),
  };
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

type FormT = ReturnType<typeof useTranslations<"community.form">>;

function uploadErrorText(code: string | null, message: string | null, t: FormT): string {
  const path = `uploadErrors.${code}`;
  if (code && t.has(path as never)) return (t as unknown as (k: string) => string)(path);
  return message ?? t("itemError");
}

function errorMessage(err: unknown, t: FormT): string {
  if (err instanceof CommunityClientError) {
    if (err.status === 401) return t("errors.session");
    if (err.code === "empty_post") return t("errors.empty");
    if (err.code === "media_required") return t("errors.mediaRequired");
    if (err.code === "community_version_conflict") return t("errors.conflict");
    if (err.code === "too_many_media")
      return t("errors.tooManyMedia", { max: COMMUNITY_POST_MAX_MEDIA });
    if (err.code === "too_many_videos")
      return t("errors.tooManyVideos", { videos: COMMUNITY_POST_MAX_VIDEOS });
    if (err.code === "invalid_text")
      return t("errors.invalidText", { max: COMMUNITY_POST_TEXT_MAX });
    // Un archivo ya subido caducó (limpieza de subidas sin publicar) o fue descartado: el texto y el
    // resto de archivos siguen en el formulario; solo hay que quitar el afectado y subirlo de nuevo.
    if (err.code === "invalid_asset" || err.code === "asset_not_ready")
      return t("errors.invalidAsset");
    return err.message || t("errors.operation");
  }
  return t("errors.operationRetry");
}

const PRIMARY_BUTTON_CLASS =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50";

const SECONDARY_BUTTON_CLASS =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary";

export interface CommunityPostEditorFormProps {
  /** null = crear una publicación nueva; con valor = editar esa publicación propia. */
  initialPost: CommunityOwnPost | null;
  /** Llamado tras un guardado exitoso (el llamador decide qué hacer: recargar lista, cerrar…). */
  onSaved: () => void;
  /** Cancelar sin guardar (limpia la cola de subida antes de avisar al llamador). */
  onCancel: () => void;
}

export default function CommunityPostEditorForm({
  initialPost,
  onSaved,
  onCancel,
}: CommunityPostEditorFormProps) {
  const t = useTranslations("community.form");
  const [form, setForm] = useState<FormState>(() => initialFormState(initialPost));
  const [saveError, setSaveError] = useState<string | null>(null);
  // R5-E: rechazo autoritativo por strike (guardado) — se conserva el borrador, nunca se reintenta.
  const [restrictionNotice, setRestrictionNotice] = useState<RestrictionOutcome | null>(
    null,
  );
  // AUTH-2: cuenta incompleta (email sin verificar / username pendiente). No es una sanción; el
  // borrador queda intacto y no hay reintento automático.
  const [incompleteNotice, setIncompleteNotice] =
    useState<AccountIncompleteReason | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const upload = useMediaUpload({ domain: "community" });

  const existingAssetIds = new Set(form.existingMedia.map((m) => m.assetId));
  const readyNewMedia: (LocalMedia & { durationSeconds: number | null })[] = upload.items
    .filter((item) => item.status === "ready" && item.assetId)
    .map((item) => ({
      assetId: item.assetId as string,
      url:
        item.kind === "video"
          ? (item.video?.url ?? null)
          : (item.variants?.[item.variants.length - 1]?.url ?? null),
      ready: true,
      key: item.localId,
      kind: item.kind,
      durationSeconds: item.video?.durationSeconds ?? null,
    }));
  const activeNewItems = upload.items.filter((i) => i.status !== "failed");
  const totalMediaCount = form.existingMedia.length + activeNewItems.length;
  const totalVideoCount =
    form.existingMedia.filter((m) => m.kind === "video").length +
    activeNewItems.filter((i) => i.kind === "video").length;

  function cancelForm() {
    for (const item of upload.items) upload.remove(item.localId);
    onCancel();
  }

  function removeExistingMedia(mediaId: string) {
    setForm((prev) => ({
      ...prev,
      existingMedia: prev.existingMedia.filter((m) => m.key !== mediaId),
      removedMediaIds: prev.removedMediaIds.includes(mediaId)
        ? prev.removedMediaIds
        : [...prev.removedMediaIds, mediaId],
    }));
  }

  /** Valida la selección COMPLETA antes de encolar nada (sección 13 del checkpoint: "reject/
   *  communicate ... cleanly" — nunca añade parcialmente y descarta el resto en silencio). El
   *  servidor (community_post_save, too_many_videos/too_many_media) sigue siendo la autoridad
   *  real; esto es solo UX para no hacer subir un archivo que el guardado rechazaría igual. */
  function onFilesSelected(e: ChangeEvent<HTMLInputElement>) {
    if (!e.target.files || e.target.files.length === 0) return;
    const files = Array.from(e.target.files);
    e.target.value = "";

    const incomingVideoCount = files.filter((f) => f.type.startsWith("video/")).length;

    if (totalMediaCount + files.length > COMMUNITY_POST_MAX_MEDIA) {
      setPickerError(t("pickerMax", { max: COMMUNITY_POST_MAX_MEDIA }));
      return;
    }
    if (totalVideoCount + incomingVideoCount > COMMUNITY_POST_MAX_VIDEOS) {
      setPickerError(t("pickerMaxVideos", { videos: COMMUNITY_POST_MAX_VIDEOS }));
      return;
    }
    // Rechazo temprano en el navegador (sección 7 del checkpoint: "the browser should also reject
    // obvious invalid selections early for UX") — el servidor (media-domain.ts
    // MAX_VIDEO_SOURCE_BYTES) sigue siendo quien realmente lo hace cumplir.
    const oversizedVideo = files.find(
      (f) => f.type.startsWith("video/") && f.size > MAX_VIDEO_BYTES_CLIENT,
    );
    if (oversizedVideo) {
      setPickerError(t("pickerSize"));
      return;
    }

    setPickerError(null);
    upload.addFiles(files);
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaveError(null);
    setRestrictionNotice(null);
    setIncompleteNotice(null);

    const media = [
      ...form.existingMedia.filter((m) => existingAssetIds.has(m.assetId)),
      ...readyNewMedia,
    ].map((m, index) => ({ assetId: m.assetId, position: index }));

    setIsSaving(true);
    try {
      await saveCommunityPost({
        postId: form.postId,
        expectedVersion: form.expectedVersion,
        text: form.text.trim().length === 0 ? null : form.text,
        media,
        removedMediaIds: form.removedMediaIds,
      });
      if (!isMountedRef.current) return;
      for (const item of upload.items) {
        if (readyNewMedia.some((media) => media.key === item.localId)) {
          upload.release(item.localId);
        } else {
          upload.remove(item.localId);
        }
      }
      showActionSuccess(form.postId === null ? t("created") : t("updated"));
      onSaved();
    } catch (err) {
      const incomplete = accountIncompleteReason(err);
      const outcome = incomplete ? null : restrictionOutcome(err);
      if (incomplete) {
        if (isMountedRef.current) setIncompleteNotice(incomplete);
      } else if (outcome) {
        // The editor stays open with the draft untouched; no automatic retry after expiry/revocation.
        if (isMountedRef.current) setRestrictionNotice(outcome);
      } else if (isMountedRef.current)
        setSaveError(
          `${form.postId === null ? t("createFailed") : t("updateFailed")}. ${errorMessage(err, t)}`,
        );
    } finally {
      if (isMountedRef.current) setIsSaving(false);
    }
  }

  // R5-E: the media RESERVE precheck rejected an upload (non-authoritative; the DB still decides).
  const incompleteUpload = upload.items.find(
    (i) => i.status === "failed" && i.errorCode === "account_incomplete",
  );
  const restrictedUpload = upload.items.find(
    (i) => i.status === "failed" && i.errorCode === "author_restricted",
  );
  const textCount = codePoints(form.text);
  // MEDIA-1: una publicación NUEVA exige al menos un archivo listo; una existente con archivos no puede quedarse sin
  // ninguno. Solo una publicación histórica de solo texto (sin archivos desde el principio) se edita solo con texto.
  const hasMedia = form.existingMedia.length > 0 || readyNewMedia.length > 0;
  const isLegacyTextOnly =
    form.postId !== null && form.existingMedia.length === 0 && form.removedMediaIds.length === 0;
  const canSave =
    !isSaving &&
    textCount <= COMMUNITY_POST_TEXT_MAX &&
    (hasMedia || (isLegacyTextOnly && textCount > 0)) &&
    !upload.items.some((i) => i.status !== "ready" && i.status !== "failed");
  const showMediaRequiredHint = !hasMedia && !isLegacyTextOnly && !isSaving;

  return (
    <form onSubmit={(e) => void handleSave(e)} noValidate className="mt-4">
      <label htmlFor="account-community-text" className="sr-only">
        {t("textLabel")}
      </label>
      <textarea
        id="account-community-text"
        value={form.text}
        onChange={(e) => setForm((prev) => ({ ...prev, text: e.target.value }))}
        maxLength={COMMUNITY_POST_TEXT_MAX + 200}
        rows={4}
        disabled={isSaving}
        className="w-full rounded-md border border-border-subtle bg-bg-surface p-3 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
        placeholder={t("placeholder")}
      />
      <p className="mt-1 text-xs text-text-secondary">
        {textCount}/{COMMUNITY_POST_TEXT_MAX}
      </p>

      <div className="mt-6">
        <span
          id="account-community-media-label"
          className="block text-sm text-text-secondary"
        >
          {t("mediaLabel", {
            max: COMMUNITY_POST_MAX_MEDIA,
            videos: COMMUNITY_POST_MAX_VIDEOS,
          })}
        </span>
        {/* Input REAL, accesible por teclado (sr-only, nunca display:none/hidden — sigue en el
            orden de tabulación). El control VISIBLE es el <button> de abajo (mismo patrón que
            CosplayEditorDialog.tsx: ref + .click() programático), nunca el texto por defecto del
            navegador ("Seleccionar archivo / Sin archivos seleccionados"). UN SOLO picker mixto
            (Fase 9J-3, sección 2 del checkpoint): accept admite imagen Y los 3 contenedores de
            vídeo soportados server-side (media-domain.ts VIDEO_MIME_TYPES) — nunca dos controles
            separados "Añadir imágenes"/"Añadir video". */}
        <input
          ref={fileInputRef}
          id="account-community-media"
          type="file"
          accept={MEDIA_PICKER_ACCEPT}
          multiple
          disabled={isSaving || totalMediaCount >= COMMUNITY_POST_MAX_MEDIA}
          onChange={onFilesSelected}
          aria-describedby="account-community-media-label account-community-media-helper"
          className="sr-only"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isSaving || totalMediaCount >= COMMUNITY_POST_MAX_MEDIA}
          className={`${SECONDARY_BUTTON_CLASS} mt-3 disabled:pointer-events-none disabled:opacity-50`}
        >
          {t("addMedia")}
        </button>
        <p
          id="account-community-media-helper"
          className="mt-2 text-xs text-text-secondary"
        >
          {t("helper", { videos: COMMUNITY_POST_MAX_VIDEOS })}
        </p>
        {pickerError ? (
          <p role="alert" className="mt-2 text-xs text-accent-live">
            {pickerError}
          </p>
        ) : null}
      </div>

      {form.existingMedia.length > 0 || upload.items.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {form.existingMedia.map((m) => (
            <li key={m.key} className="relative">
              {m.url ? (
                m.kind === "video" ? (
                  <video
                    src={m.url}
                    muted
                    playsInline
                    preload="metadata"
                    aria-label={t("attachedVideo")}
                    className="h-20 w-20 rounded bg-black object-cover"
                  />
                ) : (
                  <img src={m.url} alt="" className="h-20 w-20 rounded object-cover" />
                )
              ) : (
                <div className="flex h-20 w-20 items-center justify-center rounded border border-border-subtle text-xs text-text-secondary">
                  {t("processing")}
                </div>
              )}
              <button
                type="button"
                onClick={() => removeExistingMedia(m.key)}
                disabled={isSaving}
                aria-label={m.kind === "video" ? t("removeVideo") : t("removeImage")}
                className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-border-subtle bg-bg-surface text-xs text-text-primary"
              >
                ×
              </button>
            </li>
          ))}
          {upload.items.map((item) => (
            <li key={item.localId} className="relative">
              {item.status === "ready" && item.kind === "video" && item.video ? (
                <video
                  src={item.video.url}
                  muted
                  playsInline
                  preload="metadata"
                  aria-label={t("attachedVideo")}
                  className="h-20 w-20 rounded bg-black object-cover"
                />
              ) : item.status === "ready" && item.variants ? (
                <img
                  src={item.variants[item.variants.length - 1]?.url}
                  alt=""
                  className="h-20 w-20 rounded object-cover"
                />
              ) : (
                <div className="flex h-20 w-20 flex-col items-center justify-center rounded border border-border-subtle p-1 text-center text-[10px] text-text-secondary">
                  {item.status === "failed"
                    ? uploadErrorText(item.errorCode, item.errorMessage, t)
                    : `${item.kind === "video" ? t("itemVideo") : t("itemImage")}: ${item.status}`}
                </div>
              )}
              <button
                type="button"
                onClick={() => upload.remove(item.localId)}
                disabled={isSaving}
                aria-label={item.kind === "video" ? t("removeVideo") : t("removeImage")}
                className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-border-subtle bg-bg-surface text-xs text-text-primary"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {saveError ? (
        <p role="alert" className="mt-3 text-sm text-accent-live">
          {saveError}
        </p>
      ) : null}
      {incompleteNotice || incompleteUpload ? (
        <AccountIncompleteNotice
          reason={
            incompleteNotice ?? incompleteUpload?.accountReason ?? "email_unverified"
          }
          keepsDraft
        />
      ) : null}
      {restrictionNotice ? (
        <CommunityRestrictionNotice
          restriction={
            restrictionNotice.kind === "restricted" ? restrictionNotice.restriction : null
          }
          changed={restrictionNotice.kind === "changed"}
        />
      ) : restrictedUpload ? (
        <CommunityRestrictionNotice restriction={restrictedUpload.restriction ?? null} />
      ) : null}

      {showMediaRequiredHint && (
        <p id="community-media-required" className="mt-3 text-sm text-text-muted">
          {t("mediaRequired")}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={!canSave}
          aria-describedby={showMediaRequiredHint ? "community-media-required" : undefined} className={PRIMARY_BUTTON_CLASS}>
          {isSaving ? t("publishing") : t("publish")}
        </button>
        <button
          type="button"
          onClick={cancelForm}
          disabled={isSaving}
          className={SECONDARY_BUTTON_CLASS}
        >
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}
