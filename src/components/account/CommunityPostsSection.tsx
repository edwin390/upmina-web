import { useCallback, useEffect, useRef, useState } from "react";
import CommunityPostEditorForm from "@/components/community/CommunityPostEditorForm";
import {
  CommunityClientError,
  deleteCommunityPost,
  listOwnCommunityPosts,
  type CommunityOwnPost,
} from "@/lib/community-client";

// Sección de Comunidad dentro de /account (Fase 9J-1C): crear/editar/borrar las PROPIAS
// publicaciones (texto opcional + hasta 10 imágenes). Sin controles de creación en /community (el
// checkpoint es explícito: "Do not put creation controls on /community" — esa ruta sigue sin
// tocarse).
//
// El formulario de crear/editar (Fase 9J-2B.1) vive en CommunityPostEditorForm.tsx — extraído
// para reutilizarse TAL CUAL, sin duplicar lógica de guardado/subida, en el perfil público propio
// (/@username, ver CommunityPostEditorDialog.tsx). Esta sección sigue renderizándolo inline
// (nunca en un modal aquí): mismo comportamiento visual que antes de la extracción.
//
// i18n (misma nota deliberada que ProfileSection.tsx): /account no está montado bajo ningún
// proveedor de i18n — introducir uno solo para este checkpoint sería una expansión de alcance de
// infraestructura no pedida (deuda conocida, 9L futuro). Strings en español, igual que el resto
// del archivo que envuelve esta sección.

function errorMessage(err: unknown): string {
  if (err instanceof CommunityClientError) {
    if (err.status === 401)
      return "Tu sesión ya no es válida. Cierra sesión e inicia de nuevo.";
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

type EditorTarget = { mode: "create" } | { mode: "edit"; post: CommunityOwnPost } | null;

export default function CommunityPostsSection({
  profileStatus,
}: CommunityPostsSectionProps) {
  const [posts, setPosts] = useState<CommunityOwnPost[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [editorTarget, setEditorTarget] = useState<EditorTarget>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

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

      {!editorTarget ? (
        <>
          <button
            type="button"
            onClick={() => setEditorTarget({ mode: "create" })}
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
                      onClick={() => setEditorTarget({ mode: "edit", post })}
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
        <CommunityPostEditorForm
          initialPost={editorTarget.mode === "edit" ? editorTarget.post : null}
          onSaved={() => {
            setEditorTarget(null);
            void loadPosts();
          }}
          onCancel={() => setEditorTarget(null)}
        />
      )}
    </section>
  );
}
