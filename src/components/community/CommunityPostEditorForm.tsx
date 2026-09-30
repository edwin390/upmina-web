import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useMediaUpload } from "@/hooks/useMediaUpload";
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

type LocalMedia = { assetId: string; url: string | null; ready: boolean; key: string };

interface FormState {
  postId: string | null;
  expectedVersion: number | null;
  text: string;
  /** Media YA guardada (al editar) que el usuario no ha quitado. */
  existingMedia: LocalMedia[];
}

function initialFormState(initialPost: CommunityOwnPost | null): FormState {
  if (!initialPost) {
    return { postId: null, expectedVersion: null, text: "", existingMedia: [] };
  }
  return {
    postId: initialPost.id,
    expectedVersion: initialPost.version,
    text: initialPost.text ?? "",
    existingMedia: initialPost.media.map((m) => ({
      assetId: m.assetId,
      url: m.url,
      ready: m.assetStatus === "ready",
      key: m.id,
    })),
  };
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

function errorMessage(err: unknown): string {
  if (err instanceof CommunityClientError) {
    if (err.status === 401)
      return "Tu sesión ya no es válida. Cierra sesión e inicia de nuevo.";
    if (err.code === "profile_required")
      return "Configura tu @username antes de publicar en Comunidad.";
    if (err.code === "empty_post")
      return "Una publicación necesita texto o al menos una imagen.";
    if (err.code === "community_version_conflict")
      return "Esta publicación cambió mientras editabas. Vuelve a intentarlo.";
    if (err.code === "too_many_media")
      return `Máximo ${COMMUNITY_POST_MAX_MEDIA} imágenes.`;
    if (err.code === "invalid_text")
      return `Máximo ${COMMUNITY_POST_TEXT_MAX} caracteres.`;
    return err.message || "No se pudo completar la operación.";
  }
  return "No se pudo completar la operación. Inténtalo de nuevo.";
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
  const [form, setForm] = useState<FormState>(() => initialFormState(initialPost));
  const [saveError, setSaveError] = useState<string | null>(null);
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
  const readyNewMedia: LocalMedia[] = upload.items
    .filter((item) => item.status === "ready" && item.assetId)
    .map((item) => ({
      assetId: item.assetId as string,
      url: item.variants?.[item.variants.length - 1]?.url ?? null,
      ready: true,
      key: item.localId,
    }));
  const totalMediaCount =
    form.existingMedia.length + upload.items.filter((i) => i.status !== "failed").length;

  function cancelForm() {
    for (const item of upload.items) upload.remove(item.localId);
    onCancel();
  }

  function removeExistingMedia(assetId: string) {
    setForm((prev) => ({
      ...prev,
      existingMedia: prev.existingMedia.filter((m) => m.assetId !== assetId),
    }));
  }

  function onFilesSelected(e: ChangeEvent<HTMLInputElement>) {
    if (!e.target.files || e.target.files.length === 0) return;
    upload.addFiles(e.target.files);
    e.target.value = "";
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaveError(null);

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
      });
      if (!isMountedRef.current) return;
      for (const item of upload.items) upload.remove(item.localId);
      onSaved();
    } catch (err) {
      if (isMountedRef.current) setSaveError(errorMessage(err));
    } finally {
      if (isMountedRef.current) setIsSaving(false);
    }
  }

  const textCount = codePoints(form.text);
  const canSave =
    !isSaving &&
    textCount <= COMMUNITY_POST_TEXT_MAX &&
    (textCount > 0 || form.existingMedia.length > 0 || readyNewMedia.length > 0) &&
    !upload.items.some((i) => i.status !== "ready" && i.status !== "failed");

  return (
    <form onSubmit={(e) => void handleSave(e)} noValidate className="mt-4">
      <label htmlFor="account-community-text" className="sr-only">
        Texto de la publicación
      </label>
      <textarea
        id="account-community-text"
        value={form.text}
        onChange={(e) => setForm((prev) => ({ ...prev, text: e.target.value }))}
        maxLength={COMMUNITY_POST_TEXT_MAX + 200}
        rows={4}
        disabled={isSaving}
        className="w-full rounded-md border border-border-subtle bg-bg-surface p-3 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
        placeholder="¿Qué quieres compartir?"
      />
      <p className="mt-1 text-xs text-text-secondary">
        {textCount}/{COMMUNITY_POST_TEXT_MAX}
      </p>

      <div className="mt-6">
        <span
          id="account-community-media-label"
          className="block text-sm text-text-secondary"
        >
          Multimedia (máximo {COMMUNITY_POST_MAX_MEDIA})
        </span>
        {/* Input REAL, accesible por teclado (sr-only, nunca display:none/hidden — sigue en el
            orden de tabulación). El control VISIBLE es el <button> de abajo (mismo patrón que
            CosplayEditorDialog.tsx: ref + .click() programático), nunca el texto por defecto del
            navegador ("Seleccionar archivo / Sin archivos seleccionados"). Copy "Añadir fotos o
            videos" describe el control MIXTO final congelado (una sola colección de
            imágenes+vídeo); accept sigue en image/* a propósito — el vídeo real todavía no tiene
            pipeline de procesado (checkpoint dedicado futuro), así que el helper de abajo aclara
            la limitación actual sin fingir que ya funciona. */}
        <input
          ref={fileInputRef}
          id="account-community-media"
          type="file"
          accept="image/*"
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
          Añadir fotos o videos
        </button>
        <p
          id="account-community-media-helper"
          className="mt-2 text-xs text-text-secondary"
        >
          Por ahora puedes subir fotos. Los videos estarán disponibles pronto.
        </p>
      </div>

      {form.existingMedia.length > 0 || upload.items.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {form.existingMedia.map((m) => (
            <li key={m.key} className="relative">
              {m.url ? (
                <img src={m.url} alt="" className="h-20 w-20 rounded object-cover" />
              ) : (
                <div className="flex h-20 w-20 items-center justify-center rounded border border-border-subtle text-xs text-text-secondary">
                  Procesando…
                </div>
              )}
              <button
                type="button"
                onClick={() => removeExistingMedia(m.assetId)}
                disabled={isSaving}
                aria-label="Quitar imagen"
                className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-border-subtle bg-bg-surface text-xs text-text-primary"
              >
                ×
              </button>
            </li>
          ))}
          {upload.items.map((item) => (
            <li key={item.localId} className="relative">
              {item.status === "ready" && item.variants ? (
                <img
                  src={item.variants[item.variants.length - 1]?.url}
                  alt=""
                  className="h-20 w-20 rounded object-cover"
                />
              ) : (
                <div className="flex h-20 w-20 flex-col items-center justify-center rounded border border-border-subtle p-1 text-center text-[10px] text-text-secondary">
                  {item.status === "failed"
                    ? (item.errorMessage ?? "Error")
                    : item.status}
                </div>
              )}
              <button
                type="button"
                onClick={() => upload.remove(item.localId)}
                disabled={isSaving}
                aria-label="Quitar imagen"
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

      <div className="mt-4 flex flex-wrap gap-3">
        <button type="submit" disabled={!canSave} className={PRIMARY_BUTTON_CLASS}>
          {isSaving ? "Guardando…" : "Guardar"}
        </button>
        <button
          type="button"
          onClick={cancelForm}
          disabled={isSaving}
          className={SECONDARY_BUTTON_CLASS}
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}
