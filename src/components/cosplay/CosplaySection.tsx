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
import CosplayAdminPanel from "./admin/CosplayAdminPanel";
import CosplayEditorDialog from "./admin/CosplayEditorDialog";

/** Contenido de /cosplay (Fase 9I-1): hero + grid responsive + "Cargar más" (cursor, sin scroll
 *  infinito ni búsqueda/filtros, decisión congelada de 9I). El vacío es un estado de PRODUCTO
 *  cuidado, no un error: Cosplay es un dominio nuevo y Production puede empezar sin
 *  publicaciones. */
type EditorState = { mode: "create" } | { mode: "edit"; postId: string } | null;

export default function CosplaySection() {
  const t = useTranslations("cosplay.list");
  const tAdmin = useTranslations("cosplay.admin");
  // cacheBust > 0 fuerza un cache MISS en la Edge Network de Vercel para el próximo fetch del
  // listado público (ver el comentario de fetchCosplayList en useCosplayList.ts) — SOLO se
  // incrementa tras onPostChanged, nunca en la navegación normal.
  const [cacheBust, setCacheBust] = useState(0);
  const { data, isLoading, isError, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useCosplayList(cacheBust);
  const queryClient = useQueryClient();
  const { enter: enterPrivileged } = usePrivilegedEntry();
  const [searchParams, setSearchParams] = useSearchParams();
  const [editorState, setEditorState] = useState<EditorState>(null);
  const [adminPanelAutoOpen, setAdminPanelAutoOpen] = useState(false);
  const [publishToast, setPublishToast] = useState(false);
  const publishToastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const newPostTriggerRef = useRef<HTMLButtonElement | null>(null);

  // Aviso temporal tras publicar (sección 5 del ajuste UX): se muestra 4s y se limpia si el
  // componente se desmonta antes (nunca deja un timer huérfano actualizando estado).
  useEffect(() => {
    return () => {
      if (publishToastTimerRef.current) clearTimeout(publishToastTimerRef.current);
    };
  }, []);

  const onPublishSuccess = () => {
    if (publishToastTimerRef.current) clearTimeout(publishToastTimerRef.current);
    setPublishToast(true);
    publishToastTimerRef.current = setTimeout(() => setPublishToast(false), 4000);
  };

  // Fase 9I-3 (sección 16): tras un step-up MFA, /admin/mfa navega de vuelta aquí con
  // ?intent=create|edit|delete (RETURN_ROUTES ya lo permite desde 9G-2). "create" reabre el
  // editor vacío directamente; "edit"/"delete" NUNCA identifican una publicación concreta (ver
  // safe-return-to.ts), así que solo abren el panel de descubrimiento para que el ADMIN
  // re-seleccione y confirme de nuevo — ninguna mutación se reproduce automáticamente. Se
  // consume UNA sola vez (al montar) y se limpia de la URL para que un refresh no lo repita.
  useEffect(() => {
    const intent = parsePrivilegedIntent(searchParams.get("intent"));
    if (intent === null) return;
    if (intent === "create") setEditorState({ mode: "create" });
    else setAdminPanelAutoOpen(true);

    const next = new URLSearchParams(searchParams);
    next.delete("intent");
    setSearchParams(next, { replace: true });
    // Solo debe ejecutarse al montar: leer searchParams de nuevo tras limpiarlo no debe reabrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // La causa real de que la publicación nueva no apareciera sin recargar NO era esta invalidación
  // (invalidateQueries + refetch de TanStack Query ya funcionaban correctamente): era que el
  // refetch pedía la MISMA URL que la Edge Network de Vercel tiene cacheada hasta 60s
  // (Cache-Control: s-maxage=60 en cosplay-handlers.ts) — un refetch inmediato recibía la MISMA
  // respuesta vieja de esa caché compartida, no de Postgres. invalidateQueries se conserva (sigue
  // siendo correcto invalidar el estado de React Query), pero lo que de verdad soluciona el
  // problema es incrementar cacheBust: cambia la queryKey y la URL, forzando un MISS de CDN real.
  const onPostChanged = () => {
    setCacheBust((n) => n + 1);
    void queryClient.invalidateQueries({ queryKey: ["cosplay", "list"] });
  };

  // Endurecimiento global de MFA (9G/9I, Caso A): entrar a una superficie de autoría privilegiada
  // revalida MFA reciente con el servidor ANTES de abrir el editor, para no dejar que el ADMIN
  // empiece a editar/subir con MFA ya vencido y lo descubra recién a mitad de camino. Sin MFA
  // reciente, usePrivilegedEntry navega directo a /admin/mfa con el mismo returnTo que ya
  // consume el efecto de arriba — el editor nunca llega a montarse.
  const openCreateEditor = () =>
    void enterPrivileged("/cosplay?intent=create", () =>
      setEditorState({ mode: "create" }),
    );
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
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold text-text-inverse transition hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
            >
              {tAdmin("newPost")}
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
            <CosplayHero post={hero} />
            {rest.length > 0 && (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {rest.map((post) => (
                  <CosplayCard key={post.id} post={post} />
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

        <PrivilegedOnly capability="cosplay_admin">
          <CosplayAdminPanel onOpenEdit={openEditEditor} autoOpen={adminPanelAutoOpen} />
        </PrivilegedOnly>
      </section>

      {editorState && (
        <CosplayEditorDialog
          postId={editorState.mode === "edit" ? editorState.postId : null}
          onClose={() => setEditorState(null)}
          onPostChanged={onPostChanged}
          onPublishSuccess={onPublishSuccess}
          returnFocusTo={newPostTriggerRef.current}
        />
      )}

      {publishToast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
        >
          <p className="rounded-md border border-accent-primary/60 bg-bg-surface px-4 py-2.5 text-sm font-semibold text-text-primary shadow-glow-primary">
            {tAdmin("publishSuccess")}
          </p>
        </div>
      )}
    </>
  );
}
