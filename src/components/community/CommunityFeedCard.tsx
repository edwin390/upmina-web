import { Link } from "react-router-dom";
import type { CommunityFeedPost } from "@/types";

// Tarjeta de una publicación en el feed público de /community (Fase 9J-2A). Puramente
// presentacional: nunca consulta Supabase ni ningún API — todos los datos ya llegan normalizados
// desde useCommunityFeed. Sin menú ADMIN ni acciones de gestión (eso vive exclusivamente en
// /account, CommunityPostsSection.tsx): esta tarjeta es de solo lectura.

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("es", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** Identidad del autor (Fase 9J-2B): enlaza al perfil público /@username — el username YA llega
 *  canónico (minúsculas) desde el servidor, así que se usa tal cual, sin volver a normalizar. Solo
 *  el avatar y esta identidad son clicables (nunca la tarjeta entera: el resto del post no es un
 *  enlace de perfil). */
function AuthorIdentity({ post }: { post: CommunityFeedPost }) {
  const { username, displayName } = post.author;
  return (
    <Link
      to={`/@${username}`}
      className="flex min-w-0 flex-col rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
    >
      <span className="truncate font-display text-sm tracking-wide text-text-primary">
        {displayName ?? `@${username}`}
      </span>
      {displayName ? (
        <span className="truncate text-xs text-text-secondary">@{username}</span>
      ) : null}
    </Link>
  );
}

/** Avatar: placeholder deliberado y estilizado — la subida de avatar todavía no existe (checkpoint
 *  futuro), así que nunca se intenta construir una URL que casi con certeza no resolvería. Enlaza
 *  al perfil público /@username (Fase 9J-2B), igual que la identidad de al lado. */
function AuthorAvatar({ username }: { username: string }) {
  const initial = username.charAt(0).toUpperCase();
  return (
    <Link
      to={`/@${username}`}
      aria-label={`Ver el perfil de @${username}`}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-bg-elevated font-display text-sm text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
    >
      <span aria-hidden="true">{initial}</span>
    </Link>
  );
}

function MediaGrid({ media }: { media: CommunityFeedPost["media"] }) {
  if (media.length === 0) return null;

  if (media.length === 1) {
    const item = media[0]!;
    return (
      <div className="mt-3 overflow-hidden rounded-lg bg-bg-elevated">
        <img
          src={item.url}
          alt=""
          loading="lazy"
          style={{ aspectRatio: `${item.width} / ${item.height}` }}
          className="w-full object-contain"
        />
      </div>
    );
  }

  const shown = media.slice(0, 4);
  const overflowCount = media.length - shown.length;
  const cols =
    shown.length === 2
      ? "grid-cols-2"
      : shown.length === 3
        ? "grid-cols-3"
        : "grid-cols-2";

  return (
    <div className={`mt-3 grid ${cols} gap-1`}>
      {shown.map((item, index) => {
        const isLastVisible = index === shown.length - 1 && overflowCount > 0;
        return (
          <div
            key={item.id}
            className="relative aspect-square overflow-hidden rounded-md bg-bg-elevated"
          >
            <img
              src={item.url}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
            {isLastVisible ? (
              <span
                aria-hidden="true"
                className="absolute inset-0 flex items-center justify-center bg-black/50 font-display text-lg text-white"
              >
                +{overflowCount}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default function CommunityFeedCard({ post }: { post: CommunityFeedPost }) {
  return (
    <li className="rounded-lg border border-border-subtle bg-bg-surface p-4">
      <div className="flex items-center gap-3">
        <AuthorAvatar username={post.author.username} />
        <AuthorIdentity post={post} />
        <time
          dateTime={post.createdAt}
          className="ml-auto shrink-0 text-xs text-text-secondary"
        >
          {formatDate(post.createdAt)}
        </time>
      </div>

      {post.text ? (
        <p className="mt-3 whitespace-pre-line break-words text-sm text-text-primary">
          {post.text}
        </p>
      ) : null}

      <MediaGrid media={post.media} />
    </li>
  );
}
