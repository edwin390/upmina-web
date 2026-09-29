import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useMediaUpload } from "@/hooks/useMediaUpload";
import {
  CommunityClientError,
  deleteCommunityPost,
  listOwnCommunityPosts,
  saveCommunityPost,
  type CommunityOwnPost,
} from "@/lib/community-client";

// Mismos límites que community-post-fields.ts/la migración (COMMUNITY_POST_TEXT_MAX,
// COMMUNITY_POST_MAX_MEDIA) — duplicados aquí como constantes LOCALES en vez de importar ese
// módulo server-side (que reexporta internamente profile-fields.js con extensión .js, pensado
// para el backend, no para el bundle del navegador). Mismo patrón que ya usa ProfileSection.tsx
// (DISPLAY_NAME_MAX/BIO_MAX propios en vez de importar los de profile-fields.ts): el servidor
// sigue siendo la autoridad final, esto es solo UX.
const COMMUNITY_POST_TEXT_MAX = 2000;
const COMMUNITY_POST_MAX_MEDIA = 10;

// Sección de Comunidad dentro de /account (Fase 9J-1C): crear/editar/borrar las PROPIAS
// publicaciones (texto opcional + hasta 10 imágenes). Sin controles de creación en /community (el
// checkpoint es explícito: "Do not put creation controls on /community" — esa ruta sigue sin
// tocarse). Reutiliza useMediaUpload({domain:"community"}) TAL CUAL (ya genérico desde 9I-2B, sin
// ningún cambio) para la cola de subida de imágenes — la misma cola que usa el editor ADMIN de
// Cosplay, solo con domain distinto.
//
// i18n (misma nota deliberada que ProfileSection.tsx): /account no está montado bajo ningún
// proveedor de i18n — introducir uno solo para este checkpoint sería una expansión de alcance de
// infraestructura no pedida (deuda conocida, 9L futuro). Strings en español, igual que el resto
// del archivo que envuelve esta sección.
//
// "Smallest usable experience" (checkpoint): sin vista previa de arrastrar-soltar sofisticada, sin
// selector de vídeo, sin edición de metadata por imagen (alt/caption/portada — eso es exclusivo
// del editor ADMIN de Cosplay). Reordenar es subir/bajar, no drag-and-drop.

type LocalMedia = { assetId: string; url: string | null; ready: boolean; key: string };

interface FormState {
  postId: string | null;
  expectedVersion: number | null;
  text: string;
  /** Media YA guardada (al editar) que el usuario no ha quitado. */
  existingMedia: LocalMedia[];
}

const EMPTY_FORM: FormState = {
  postId: null,
  expectedVersion: null,
  text: "",
  existingMedia: [],
};

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

export interface CommunityPostsSectionProps {
  profileStatus: "loading" | "error" | "absent" | "present";
}

export default function CommunityPostsSection({
  profileStatus,
}: CommunityPostsSectionProps) {
  const [posts, setPosts] = useState<CommunityOwnPost[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const upload = useMediaUpload({ domain: "community" });

  const loadPosts = useCallback(async () => {
    setListError(null);
    try {
      const { items } = await listOwnCommunityPosts();
      if (isMountedRef.current) setPosts(Array.isArray(items) ? items : []);
    } catch (err) {
      if (isMountedRef.current) setListError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (profileStatus !== "present") return;
    void loadPosts();
  }, [profileStatus, loadPosts]);

  if (profileStatus === "absent") {
    return (
      <section
        aria-labelledby="account-community-heading"
        className="mt-6 border-t border-border-subtle pt-6"
      >
        <h2
          id="account-community-heading"
          className="font-display text-xl tracking-wide text-text-primary"
        >
          Comunidad
        </h2>
        <p className="mt-3 text-sm text-text-secondary">
          Configura tu @username arriba antes de publicar en Comunidad.
        </p>
      </section>
    );
  }

  if (profileStatus !== "present") return null;

  const existingAssetIds = new Set((form?.existingMedia ?? []).map((m) => m.assetId));
  const readyNewMedia: LocalMedia[] = upload.items
    .filter((item) => item.status === "ready" && item.assetId)
    .map((item) => ({
      assetId: item.assetId as string,
      url: item.variants?.[item.variants.length - 1]?.url ?? null,
      ready: true,
      key: item.localId,
    }));
  const totalMediaCount =
    (form?.existingMedia.length ?? 0) +
    upload.items.filter((i) => i.status !== "failed").length;

  function startCreate() {
    setForm({ ...EMPTY_FORM });
    setSaveError(null);
  }

  function startEdit(post: CommunityOwnPost) {
    setForm({
      postId: post.id,
      expectedVersion: post.version,
      text: post.text ?? "",
      existingMedia: post.media.map((m) => ({
        assetId: m.assetId,
        url: m.url,
        ready: m.assetStatus === "ready",
        key: m.id,
      })),
    });
    setSaveError(null);
  }

  function cancelForm() {
    for (const item of upload.items) upload.remove(item.localId);
    setForm(null);
    setSaveError(null);
  }

  function removeExistingMedia(assetId: string) {
    setForm((prev) =>
      prev
        ? {
            ...prev,
            existingMedia: prev.existingMedia.filter((m) => m.assetId !== assetId),
          }
        : prev,
    );
  }

  function onFilesSelected(e: ChangeEvent<HTMLInputElement>) {
    if (!e.target.files || e.target.files.length === 0) return;
    upload.addFiles(e.target.files);
    e.target.value = "";
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
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
      setForm(null);
      await loadPosts();
    } catch (err) {
      if (isMountedRef.current) setSaveError(errorMessage(err));
    } finally {
      if (isMountedRef.current) setIsSaving(false);
    }
  }

  async function confirmDelete(post: CommunityOwnPost) {
    setDeleteError(null);
    try {
      await deleteCommunityPost({ postId: post.id, expectedVersion: post.version });
      if (!isMountedRef.current) return;
      setPendingDeleteId(null);
      await loadPosts();
    } catch (err) {
      if (isMountedRef.current) setDeleteError(errorMessage(err));
    }
  }

  const textCount = codePoints(form?.text ?? "");
  const canSave =
    !isSaving &&
    !!form &&
    textCount <= COMMUNITY_POST_TEXT_MAX &&
    (textCount > 0 || form.existingMedia.length > 0 || readyNewMedia.length > 0) &&
    !upload.items.some((i) => i.status !== "ready" && i.status !== "failed");

  return (
    <section
      aria-labelledby="account-community-heading"
      className="mt-6 border-t border-border-subtle pt-6"
    >
      <h2
        id="account-community-heading"
        className="font-display text-xl tracking-wide text-text-primary"
      >
        Comunidad
      </h2>

      {listError ? (
        // Sin role="alert"/"status" a propósito: un fallo al listar es secundario (no interrumpe
        // ninguna acción que el usuario acabe de pedir, a diferencia de saveError/deleteError más
        // abajo, que SÍ son alert — feedback directo de una acción explícita) y esta página ya
        // tiene su propio role="status" (la línea "Sesión activa como…" de AccountPage.tsx) — un
        // segundo role="status" competiría por esa única región en vez de añadir una nueva.
        <p className="mt-3 text-sm text-accent-live">{listError}</p>
      ) : null}

      {!form ? (
        <>
          <button
            type="button"
            onClick={startCreate}
            className={`${PRIMARY_BUTTON_CLASS} mt-4`}
          >
            Nueva publicación
          </button>

          {posts === null ? (
            <p className="mt-3 text-sm text-text-secondary" aria-live="polite">
              Cargando tus publicaciones…
            </p>
          ) : posts.length === 0 ? (
            <p className="mt-3 text-sm text-text-secondary">
              Todavía no tienes publicaciones.
            </p>
          ) : (
            <ul className="mt-4 flex flex-col gap-4">
              {posts.map((post) => (
                <li key={post.id} className="rounded-md border border-border-subtle p-4">
                  {post.text ? (
                    <p className="whitespace-pre-line break-words text-sm text-text-primary">
                      {post.text}
                    </p>
                  ) : null}
                  {post.media.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {post.media.map((m) =>
                        m.url ? (
                          <img
                            key={m.id}
                            src={m.url}
                            alt=""
                            className="h-20 w-20 rounded object-cover"
                          />
                        ) : (
                          <div
                            key={m.id}
                            className="flex h-20 w-20 items-center justify-center rounded border border-border-subtle text-xs text-text-secondary"
                          >
                            Procesando…
                          </div>
                        ),
                      )}
                    </div>
                  ) : null}

                  <div className="mt-3 flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => startEdit(post)}
                      className={SECONDARY_BUTTON_CLASS}
                    >
                      Editar
                    </button>
                    {pendingDeleteId === post.id ? (
                      <>
                        <span className="self-center text-sm text-text-secondary">
                          ¿Borrar esta publicación?
                        </span>
                        <button
                          type="button"
                          onClick={() => void confirmDelete(post)}
                          className={SECONDARY_BUTTON_CLASS}
                        >
                          Confirmar borrado
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingDeleteId(null)}
                          className={SECONDARY_BUTTON_CLASS}
                        >
                          Cancelar
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setPendingDeleteId(post.id)}
                        className={SECONDARY_BUTTON_CLASS}
                      >
                        Borrar
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {deleteError ? (
            <p role="alert" className="mt-3 text-sm text-accent-live">
              {deleteError}
            </p>
          ) : null}
        </>
      ) : (
        <form onSubmit={(e) => void handleSave(e)} noValidate className="mt-4">
          <label htmlFor="account-community-text" className="sr-only">
            Texto de la publicación
          </label>
          <textarea
            id="account-community-text"
            value={form.text}
            onChange={(e) =>
              setForm((prev) => (prev ? { ...prev, text: e.target.value } : prev))
            }
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
            {/* Input REAL, accesible por teclado (sr-only, nunca display:none/hidden — sigue en
                el orden de tabulación). El control VISIBLE es el <button> de abajo (mismo patrón
                que CosplayEditorDialog.tsx: ref + .click() programático), nunca el texto por
                defecto del navegador ("Seleccionar archivo / Sin archivos seleccionados"). Copy
                "Añadir fotos o videos" describe el control MIXTO final congelado (una sola
                colección de imágenes+vídeo); accept sigue en image/* a propósito — el vídeo real
                todavía no tiene pipeline de procesado (checkpoint dedicado futuro), así que el
                helper de abajo aclara la limitación actual sin fingir que ya funciona. */}
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
      )}
    </section>
  );
}
