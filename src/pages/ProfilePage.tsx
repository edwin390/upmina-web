import { Link, Navigate, useParams } from "react-router-dom";
import { useCommunityProfile } from "@/hooks/useCommunityProfile";
import type { CommunityFeedPost } from "@/types";

// /@username (Fase 9J-2B): perfil PÚBLICO de Comunidad — identidad/contenido de solo lectura,
// inspirado en la jerarquía de información de un perfil de creador estilo TikTok (nunca un clon
// pixel a pixel: sin sus iconos/branding/medidas exactas). Reemplaza el ProfilePage.tsx legado
// (consultaba una tabla `edits` inexistente y un campo profiles.role que ya no existe en el
// esquema — nunca llegó a montarse en App.tsx, código muerto desde antes de este checkpoint).
//
// /account sigue siendo la superficie PRIVADA de gestión (crear/editar/borrar tus publicaciones,
// CommunityPostsSection.tsx); esta página es exclusivamente de LECTURA pública — sin botón
// editar/borrar, sin controles ADMIN/MODERATOR, nunca mezclados aquí.
//
// Likes NO existen todavía (9J-2C futuro): nunca se fabrica ni se muestra "0 likes". Avatar real
// tampoco (checkpoint futuro): el placeholder estilizado es deliberado, no un estado de carga.

function pluralizePosts(count: number): string {
  return count === 1 ? "1 publicación" : `${count} publicaciones`;
}

function ProfileAvatarPlaceholder({ username }: { username: string }) {
  const initial = username.charAt(0).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-bg-elevated font-display text-4xl text-text-secondary"
    >
      {initial}
    </span>
  );
}

function MultiMediaBadge({ count }: { count: number }) {
  if (count <= 1) return null;
  return (
    <span
      aria-hidden="true"
      className="absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white"
    >
      +{count}
    </span>
  );
}

function postTileLabel(post: CommunityFeedPost): string {
  const when = new Date(post.createdAt);
  const dateLabel = Number.isNaN(when.getTime())
    ? ""
    : new Intl.DateTimeFormat("es", { dateStyle: "medium" }).format(when);
  if (post.media.length > 0) {
    const mediaLabel =
      post.media.length === 1 ? "1 imagen" : `${post.media.length} imágenes`;
    return `Publicación con ${mediaLabel}${dateLabel ? `, ${dateLabel}` : ""}`;
  }
  const preview = (post.text ?? "").trim();
  return `Publicación de texto${dateLabel ? ` del ${dateLabel}` : ""}: ${preview}`;
}

/** Cada tarilla es un <button> enfocable con una etiqueta accesible con sentido — enfocable por
 *  teclado y lista para una futura vista de detalle (ruta o modal, checkpoint aparte). Este
 *  checkpoint explícitamente NO construye esa vista: el botón no navega todavía a ningún sitio. */
function PostTile({ post }: { post: CommunityFeedPost }) {
  const cover = post.media[0] ?? null;
  return (
    <li>
      <button
        type="button"
        aria-label={postTileLabel(post)}
        className="group relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-md border border-border-subtle bg-bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
      >
        {cover ? (
          <>
            <img
              src={cover.url}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition-transform group-hover:scale-105"
            />
            <MultiMediaBadge count={post.media.length} />
          </>
        ) : (
          <p className="line-clamp-6 break-words px-3 text-center text-xs text-text-secondary">
            {post.text}
          </p>
        )}
      </button>
    </li>
  );
}

export default function ProfilePage() {
  // La ruta real es "/:usernameParam" (ver el comentario en App.tsx sobre por qué "/@:username"
  // no es válido en React Router v6): usernameParam es SIEMPRE el segmento completo tal como
  // llegó ("@edwin1", "cualquier-otra-cosa"...). Solo un valor que empiece por "@" es un intento
  // de visitar un perfil; cualquier otra cosa (una ruta normal mal escrita, /foo, /bar) se
  // redirige exactamente como el catch-all "*" del sitio — nunca se interpreta como un username.
  const { usernameParam } = useParams<{ usernameParam: string }>();
  const username = usernameParam?.startsWith("@") ? usernameParam.slice(1) : null;

  const {
    data,
    isLoading,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
  } = useCommunityProfile(username ?? "");

  if (username === null) return <Navigate to="/" replace />;

  const firstPage = data?.pages[0] ?? null;
  const notFound = !isLoading && !isError && firstPage === null;
  const profile = firstPage?.profile ?? null;
  const posts = data?.pages.flatMap((page) => page?.posts.items ?? []) ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      {isLoading ? (
        <p role="status" className="text-text-secondary" aria-live="polite">
          Cargando perfil…
        </p>
      ) : null}

      {isError ? (
        <div
          role="alert"
          className="rounded-lg border border-border-subtle bg-bg-surface px-6 py-10 text-center"
        >
          <p className="text-text-secondary">No se pudo cargar este perfil.</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="mt-4 inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold text-text-inverse transition hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
          >
            Reintentar
          </button>
        </div>
      ) : null}

      {notFound ? (
        <div className="rounded-lg border border-border-subtle bg-bg-surface px-6 py-16 text-center">
          <p className="font-display text-lg tracking-wide text-text-primary">
            Este perfil no existe
          </p>
          <p className="mt-2 text-text-secondary">
            No encontramos ninguna cuenta con ese @username.
          </p>
          <Link
            to="/community"
            className="mt-4 inline-flex min-h-11 items-center justify-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors hover:border-accent-primary/70 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
          >
            Volver a Comunidad
          </Link>
        </div>
      ) : null}

      {profile ? (
        <>
          <header className="flex flex-col items-center gap-3 py-6 text-center">
            <ProfileAvatarPlaceholder username={profile.username} />
            {profile.displayName ? (
              <p className="font-display text-2xl tracking-wide text-text-primary">
                {profile.displayName}
              </p>
            ) : null}
            <p className="text-sm text-text-secondary">@{profile.username}</p>
            {profile.bio ? (
              <p className="max-w-md whitespace-pre-line break-words text-sm text-text-secondary">
                {profile.bio}
              </p>
            ) : null}
            <p className="text-sm font-semibold text-text-primary">
              {pluralizePosts(profile.postCount)}
            </p>
          </header>

          <div className="mt-6 border-t border-border-subtle pt-6">
            {posts.length === 0 ? (
              <div className="rounded-lg border border-border-subtle bg-bg-surface px-6 py-16 text-center">
                <p className="font-display text-lg tracking-wide text-text-primary">
                  Todavía no hay publicaciones
                </p>
                <p className="mt-2 text-text-secondary">
                  Cuando @{profile.username} publique, sus publicaciones aparecerán aquí.
                </p>
              </div>
            ) : (
              <>
                <ul className="grid grid-cols-3 gap-1 sm:gap-2">
                  {posts.map((post) => (
                    <PostTile key={post.id} post={post} />
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
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
