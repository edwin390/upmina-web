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

/** Identidad del autor, ya "preparada para enlazar" a una futura /@username (el checkpoint prohíbe
 *  construir esa página pública todavía): un <span>, no un <Link>, para no crear una ruta que
 *  todavía no existe — sustituirlo por un Link real, cuando llegue ese checkpoint, es un cambio de
 *  una línea, no una reestructuración. */
function AuthorIdentity({ post }: { post: CommunityFeedPost }) {
  const { username, displayName } = post.author;
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate font-display text-sm tracking-wide text-text-primary">
        {displayName ?? `@${username}`}
      </span>
      {displayName ? (
        <span className="truncate text-xs text-text-secondary">@{username}</span>
      ) : null}
    </span>
  );
}

/** Avatar: placeholder deliberado y estilizado — la subida de avatar todavía no existe (checkpoint
 *  futuro), así que nunca se intenta construir una URL que casi con certeza no resolvería. */
function AuthorAvatar({ username }: { username: string }) {
  const initial = username.charAt(0).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-bg-elevated font-display text-sm text-text-secondary"
    >
      {initial}
    </span>
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
          className="w-full object-cover"
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
