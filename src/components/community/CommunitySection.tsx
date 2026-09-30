import { useState } from "react";
import { useCommunityFeed, type CommunityFeedMode } from "@/hooks/useCommunityFeed";
import { useCommunityLikedByMe } from "@/hooks/useCommunityLikedByMe";
import CommunityFeedCard from "./CommunityFeedCard";

// /community (Fase 9J-2A, con "Populares" activada en 9J-2C): feed público REAL de Comunidad —
// reemplaza el cascarón temporal de 9J-1C UX follow-up (que solo mostraba las etiquetas congeladas
// "Recientes"/"Populares" sin ninguna fuente de datos).
//
// Solo lectura de PUBLICACIONES: sin formulario ni botón de creación (eso vive exclusivamente en
// el perfil propio, /@username — ver ProfilePage.tsx). Dar like SÍ es posible desde aquí
// (CommunityFeedCard → CommunityLikeButton, Fase 9J-2C).
//
// "Recientes" (created_at desc) y "Populares" (últimos 7 días, like_count desc, created_at desc,
// id desc — ver useCommunityFeed.ts y community-feed-handlers.ts) son ahora dos pestañas
// igualmente funcionales; ninguna fabrica datos: Populares muestra publicaciones elegibles con 0
// likes en vez de un tab vacío, nunca un "engagement score" inventado.
const TAB_LABEL: Record<CommunityFeedMode, string> = {
  recent: "Recientes",
  popular: "Populares",
};

function ModeTab({
  mode,
  active,
  onSelect,
}: {
  mode: CommunityFeedMode;
  active: boolean;
  onSelect: (mode: CommunityFeedMode) => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={() => onSelect(mode)}
      className={
        active
          ? "rounded-md bg-accent-primary px-3 py-1.5 text-sm font-semibold text-text-inverse"
          : "rounded-md bg-bg-elevated px-3 py-1.5 text-sm text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
      }
    >
      {TAB_LABEL[mode]}
    </button>
  );
}

export default function CommunitySection() {
  const [mode, setMode] = useState<CommunityFeedMode>("recent");
  const {
    data,
    isLoading,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
  } = useCommunityFeed(mode);

  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const { likedByMe } = useCommunityLikedByMe(items.map((post) => post.id));

  return (
    <section className="mx-auto max-w-3xl px-4 py-16">
      <header className="mb-8">
        <h1 className="font-display text-3xl tracking-wide text-text-primary">
          Comunidad
        </h1>
        <div className="mt-4 flex gap-2">
          <ModeTab mode="recent" active={mode === "recent"} onSelect={setMode} />
          <ModeTab mode="popular" active={mode === "popular"} onSelect={setMode} />
        </div>
      </header>

      {isLoading ? (
        <ul aria-hidden="true" className="flex flex-col gap-4">
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="h-32 animate-pulse rounded-lg border border-border-subtle bg-bg-surface"
            />
          ))}
        </ul>
      ) : null}
      {isLoading ? (
        <p role="status" className="sr-only">
          Cargando publicaciones…
        </p>
      ) : null}

      {isError ? (
        <div
          role="alert"
          className="rounded-lg border border-border-subtle bg-bg-surface px-6 py-10 text-center"
        >
          <p className="text-text-secondary">No se pudieron cargar las publicaciones.</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="mt-4 inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold text-text-inverse transition hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
          >
            Reintentar
          </button>
        </div>
      ) : null}

      {!isLoading && !isError && items.length === 0 ? (
        <div className="rounded-lg border border-border-subtle bg-bg-surface px-6 py-16 text-center">
          <p className="font-display text-lg tracking-wide text-text-primary">
            Todavía no hay publicaciones
          </p>
          <p className="mt-2 text-text-secondary">
            Cuando la comunidad empiece a publicar, sus publicaciones aparecerán aquí.
          </p>
        </div>
      ) : null}

      {!isLoading && !isError && items.length > 0 ? (
        <>
          <ul className="flex flex-col gap-4">
            {items.map((post) => (
              <CommunityFeedCard
                key={post.id}
                post={post}
                likedByMe={likedByMe?.has(post.id) ?? false}
              />
            ))}
          </ul>

          {hasNextPage ? (
            <div className="mt-8 flex justify-center">
              <button
                type="button"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
                className="rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors hover:border-accent-primary/70 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:opacity-50"
              >
                {isFetchingNextPage ? "Cargando…" : "Cargar más"}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
