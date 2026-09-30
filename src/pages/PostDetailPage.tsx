import { Link, useParams } from "react-router-dom";
import { useCommunityPostDetail } from "@/hooks/useCommunityPostDetail";
import { useCommunityLikedByMe } from "@/hooks/useCommunityLikedByMe";
import CommunityLikeButton from "@/components/community/CommunityLikeButton";
import type { CommunityFeedPost } from "@/types";

// /community/post/:postId (Fase 9J-2B.1, con like real en 9J-2C, con vídeo real en 9J-3): detalle
// público de UNA publicación de Comunidad — destino "compartible" de las tarjetas del feed y de la
// galería de perfil, que antes eran inertes. Solo lectura salvo el like: sin comentarios, sin
// reacciones múltiples, sin botón de reporte. La identidad del autor enlaza a /@username (nunca al
// revés: el enlace de autor NUNCA abre esta página, ver CommunityFeedCard.tsx/ProfilePage.tsx).

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("es", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function AuthorAvatarPlaceholder({ username }: { username: string }) {
  const initial = username.charAt(0).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-bg-elevated font-display text-lg text-text-secondary"
    >
      {initial}
    </span>
  );
}

/** A diferencia del feed (miniaturas no interactivas dentro de un <Link>, ver
 *  CommunityFeedCard.tsx), el detalle SÍ es el lugar real de reproducción: controles nativos,
 *  silenciado por defecto (nunca autoplay con sonido), playsInline — el usuario decide reproducir. */
function PostMedia({ media }: { media: CommunityFeedPost["media"] }) {
  if (media.length === 0) return null;
  return (
    <div className="mt-4 flex flex-col gap-3">
      {media.map((item) =>
        item.kind === "video" ? (
          <div key={item.id} className="overflow-hidden rounded-lg bg-black">
            <video
              src={item.url}
              controls
              muted
              playsInline
              preload="metadata"
              style={{ aspectRatio: `${item.width} / ${item.height}` }}
              className="w-full"
            />
          </div>
        ) : (
          <div key={item.id} className="overflow-hidden rounded-lg bg-bg-elevated">
            <img
              src={item.url}
              alt=""
              style={{ aspectRatio: `${item.width} / ${item.height}` }}
              className="w-full object-contain"
            />
          </div>
        ),
      )}
    </div>
  );
}

export default function PostDetailPage() {
  const { postId } = useParams<{ postId: string }>();
  const { data: post, isLoading, isError, refetch } = useCommunityPostDetail(postId);
  const notFound = !isLoading && !isError && post === null;
  const { likedByMe } = useCommunityLikedByMe(post ? [post.id] : []);

  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      {isLoading ? (
        <p role="status" className="text-text-secondary" aria-live="polite">
          Cargando publicación…
        </p>
      ) : null}

      {isError ? (
        <div
          role="alert"
          className="rounded-lg border border-border-subtle bg-bg-surface px-6 py-10 text-center"
        >
          <p className="text-text-secondary">No se pudo cargar esta publicación.</p>
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
            Esta publicación no existe
          </p>
          <p className="mt-2 text-text-secondary">
            Puede haberse borrado o no estar disponible.
          </p>
          <Link
            to="/community"
            className="mt-4 inline-flex min-h-11 items-center justify-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors hover:border-accent-primary/70 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
          >
            Volver a Comunidad
          </Link>
        </div>
      ) : null}

      {post ? (
        <article className="rounded-lg border border-border-subtle bg-bg-surface p-6">
          <div className="flex items-center gap-3">
            <Link
              to={`/@${post.author.username}`}
              aria-label={`Ver el perfil de @${post.author.username}`}
              className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
            >
              <AuthorAvatarPlaceholder username={post.author.username} />
            </Link>
            <Link
              to={`/@${post.author.username}`}
              className="flex min-w-0 flex-col rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
            >
              <span className="truncate font-display text-sm tracking-wide text-text-primary">
                {post.author.displayName ?? `@${post.author.username}`}
              </span>
              {post.author.displayName ? (
                <span className="truncate text-xs text-text-secondary">
                  @{post.author.username}
                </span>
              ) : null}
            </Link>
            <time
              dateTime={post.createdAt}
              className="ml-auto shrink-0 text-xs text-text-secondary"
            >
              {formatDate(post.createdAt)}
            </time>
          </div>

          {post.text ? (
            <p className="mt-4 whitespace-pre-line break-words text-base text-text-primary">
              {post.text}
            </p>
          ) : null}

          <PostMedia media={post.media} />

          <div className="mt-4 border-t border-border-subtle pt-4">
            <CommunityLikeButton
              postId={post.id}
              likeCount={post.likeCount}
              likedByMe={likedByMe?.has(post.id) ?? false}
              stopPropagation={false}
            />
          </div>
        </article>
      ) : null}
    </div>
  );
}
