import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { useCosplayList } from "@/hooks/useCosplayList";
import { usePrivilegedEntry } from "@/hooks/usePrivilegedEntry";
import PrivilegedOnly from "@/components/auth/PrivilegedOnly";
import { parsePrivilegedIntent } from "@/lib/privileged-intent";
import CosplayCard from "./CosplayCard";
import CosplayHero from "./CosplayHero";
import CosplayEditorDialog from "./admin/CosplayEditorDialog";
import CosplayDraftChooser from "./admin/CosplayDraftChooser";
import { refreshCosplayContent } from "@/lib/content-freshness";
import { showActionSuccess } from "@/lib/action-notice";

/** Contenido de /cosplay (Fase 9I-1): hero + grid responsive + "Cargar más" (cursor, sin scroll
 *  infinito ni búsqueda/filtros, decisión congelada de 9I). El vacío es un estado de PRODUCTO
 *  cuidado, no un error: Cosplay es un dominio nuevo y Production puede empezar sin
 *  publicaciones. */
type EditorState = { mode: "create" } | { mode: "edit" | "draft"; postId: string } | null;

export default function CosplaySection() {
  const t = useTranslations("cosplay.list");
  const tAdmin = useTranslations("cosplay.admin");
  const { data, isLoading, isError, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useCosplayList();
  const queryClient = useQueryClient();
  const { enter: enterPrivileged, isEntering, enteringTarget } = usePrivilegedEntry();
  const [searchParams, setSearchParams] = useSearchParams();
  const [editorState, setEditorState] = useState<EditorState>(null);
  const [choosingDraft, setChoosingDraft] = useState(false);
  const newPostTriggerRef = useRef<HTMLButtonElement | null>(null);

  const onPublishSuccess = (message = tAdmin("feedback.created")) =>
    showActionSuccess(message);
  const onDeleted = (slug: string) => {
    onPostChanged("published", slug);
    showActionSuccess(tAdmin("feedback.deleted"));
  };

  // Fase 9I-3 (sección 16), ajustado tras reemplazar el panel "Tus publicaciones" por el menú
  // contextual por tarjeta: tras un step-up MFA, /admin/mfa navega de vuelta aquí con
  // ?intent=create|edit|delete (RETURN_ROUTES ya lo permite desde 9G-2). "create" reabre el
  // editor vacío directamente; "edit"/"delete" NUNCA identifican una publicación concreta (ver
  // safe-return-to.ts) — ya no hay un panel aparte que reabrir: el catálogo público (con el menú
  // ADMIN en cada tarjeta) ya está siempre visible, así que el ADMIN solo necesita volver a abrir
  // el menú "⋯" de la tarjeta correspondiente y confirmar de nuevo. Ninguna mutación se reproduce
  // automáticamente. Se consume UNA sola vez (al montar) y se limpia de la URL para que un
  // refresh no lo repita.
  useEffect(() => {
    const intent = parsePrivilegedIntent(searchParams.get("intent"));
    if (intent === null) return;
    if (intent === "create") setChoosingDraft(true);

    const next = new URLSearchParams(searchParams);
    next.delete("intent");
    setSearchParams(next, { replace: true });
    // Solo debe ejecutarse al montar: leer searchParams de nuevo tras limpiarlo no debe reabrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh affected query families and their HTTP requests; draft-only saves stay private.
  const onPostChanged = (
    status: "draft" | "published" = "published",
    deletedSlug?: string,
  ) => {
    void refreshCosplayContent(queryClient, status, deletedSlug);
  };

  // Endurecimiento global de MFA (9G/9I, Caso A): entrar a una superficie de autoría privilegiada
  // revalida MFA reciente con el servidor ANTES de abrir el editor, para no dejar que el ADMIN
  // empiece a editar/subir con MFA ya vencido y lo descubra recién a mitad de camino. Sin MFA
  // reciente, usePrivilegedEntry navega directo a /admin/mfa con el mismo returnTo que ya
  // consume el efecto de arriba — el editor nunca llega a montarse.
  const openCreateEditor = () =>
    void enterPrivileged("/cosplay?intent=create", () => setChoosingDraft(true));
  const openEditEditor = (id: string) =>
    void enterPrivileged("/cosplay?intent=edit", () =>
      setEditorState({ mode: "edit", postId: id }),
    );

  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const [hero, ...rest] = items;

  return (
    <>
      <section className="mx-auto max-w-6xl px-4 py-16">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl tracking-wide">{t("heading")}</h1>
            <p className="mt-1 text-text-secondary">{t("subheading")}</p>
          </div>
          <PrivilegedOnly capability="cosplay_admin">
            <button
              ref={newPostTriggerRef}
              type="button"
              onClick={openCreateEditor}
              disabled={isEntering}
              aria-busy={isEntering}
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold text-text-inverse transition hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
            >
              <span className="grid">
                <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                  {tAdmin("newPost")}
                </span>
                <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                  {tAdmin("opening")}
                </span>
                <span className="col-start-1 row-start-1">
                  {tAdmin(
                    enteringTarget === "/cosplay?intent=create" ? "opening" : "newPost",
                  )}
                </span>
              </span>
            </button>
          </PrivilegedOnly>
        </header>

        {isLoading && (
          <p role="status" className="text-text-muted">
            {t("loading")}
          </p>
        )}

        {isError && (
          <p role="status" className="text-text-muted">
            {t("error")}
          </p>
        )}

        {!isLoading && !isError && items.length === 0 && (
          <div className="rounded-lg border border-border-subtle bg-bg-surface px-6 py-16 text-center">
            <p className="font-display text-lg tracking-wide text-text-primary">
              {t("empty.title")}
            </p>
            <p className="mt-2 text-text-secondary">{t("empty.body")}</p>
          </div>
        )}

        {hero && (
          <>
            <CosplayHero
              post={hero}
              onEdit={openEditEditor}
              onDeleted={() => onDeleted(hero.slug)}
            />
            {rest.length > 0 && (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {rest.map((post) => (
                  <CosplayCard
                    key={post.id}
                    post={post}
                    onEdit={openEditEditor}
                    onDeleted={() => onDeleted(post.slug)}
                  />
                ))}
              </div>
            )}
            {hasNextPage && (
              <div className="mt-8 flex justify-center">
                <button
                  type="button"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                  className="rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors hover:border-accent-primary/70 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:opacity-50"
                >
                  {t("loadMore")}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {editorState && (
        <CosplayEditorDialog
          postId={editorState.mode === "create" ? null : editorState.postId}
          resumeDraft={editorState.mode === "draft"}
          onClose={() => setEditorState(null)}
          onPostChanged={onPostChanged}
          onPublishSuccess={onPublishSuccess}
          returnFocusTo={newPostTriggerRef.current}
        />
      )}
      {choosingDraft && (
        <CosplayDraftChooser
          onClose={() => setChoosingDraft(false)}
          onNew={() => {
            setChoosingDraft(false);
            setEditorState({ mode: "create" });
          }}
          onResume={(postId) => {
            setChoosingDraft(false);
            setEditorState({ mode: "draft", postId });
          }}
        />
      )}
    </>
  );
}
