import { Link } from "react-router-dom";
import type { CommunityFeedPost } from "@/types";
import CommunityLikeButton from "./CommunityLikeButton";

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

/** Insignia ▶ superpuesta sobre una miniatura de vídeo (Fase 9J-3, sección 16/17 del checkpoint):
 *  nunca autoplay con sonido en el feed — el indicador deja claro que hace falta interactuar
 *  (controles nativos) para reproducir. */
function VideoPlayBadge() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white">
        <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
      </span>
    </span>
  );
}

/** UN solo item de media, imagen o vídeo (Fase 9J-3). Toda esta grilla vive DENTRO del <Link> al
 *  detalle (ver CommunityFeedCard más abajo), así que el vídeo aquí es SIEMPRE una vista previa no
 *  interactiva (silenciada, sin controles nativos — mismo criterio que una imagen no es "clicable
 *  para zoom" en el feed): mezclar controles reales dentro de un enlace clicable sería frágil
 *  (sección 16 del checkpoint: "prefer a simple click-to-play... over fragile complexity"). La
 *  reproducción real con controles vive en el detalle (PostDetailPage.tsx), que SÍ es interactivo.
 *  El clic en cualquier punto de la tarjeta navega al detalle, igual que ya ocurría con imagen. */
function MediaItemView({
  item,
  className,
}: {
  item: CommunityFeedPost["media"][number];
  className: string;
}) {
  if (item.kind === "video") {
    return (
      <video
        src={item.url}
        muted
        playsInline
        preload="metadata"
        style={{ aspectRatio: `${item.width} / ${item.height}` }}
        className={className}
      />
    );
  }
  return (
    <img
      src={item.url}
      alt=""
      loading="lazy"
      style={{ aspectRatio: `${item.width} / ${item.height}` }}
      className={className}
    />
  );
}

/** Altura FIJA (no derivada del aspect-ratio natural del archivo) para el único media de un post
 *  de un solo item en el feed — Fase 9J-3 follow-up "COMPACT FEED MEDIA": antes, un vídeo o imagen
 *  vertical (p. ej. 9:16) se renderizaba a `width / (width/height)` de alto, produciendo tarjetas
 *  desproporcionadamente altas en desktop ahora que el vídeo vertical es un caso real y común.
 *  Compacta pero creciente por breakpoint (nunca fuerza la altura de escritorio en móvil); usa
 *  object-cover en vez de object-contain (aceptado explícitamente por el checkpoint) para llenar
 *  esa altura sin deformar — recorta el sobrante en vez de hacer letterboxing. El post DETALLE
 *  (PostDetailPage.tsx) no cambia: sigue mostrando el media a su tamaño/proporción real, sin
 *  recortar — el feed es solo para explorar.*/
const SINGLE_MEDIA_HEIGHT_CLASS = "h-72 sm:h-80 md:h-96";

function MediaGrid({ media }: { media: CommunityFeedPost["media"] }) {
  if (media.length === 0) return null;

  if (media.length === 1) {
    const item = media[0]!;
    return (
      <div
        className={`relative mt-3 w-full overflow-hidden rounded-lg bg-bg-elevated ${SINGLE_MEDIA_HEIGHT_CLASS}`}
      >
        <MediaItemView item={item} className="h-full w-full object-cover" />
        {item.kind === "video" ? <VideoPlayBadge /> : null}
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
            <MediaItemView item={item} className="h-full w-full object-cover" />
            {item.kind === "video" && !isLastVisible ? <VideoPlayBadge /> : null}
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

export default function CommunityFeedCard({
  post,
  likedByMe,
}: {
  post: CommunityFeedPost;
  likedByMe: boolean;
}) {
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

      {/* Fase 9J-2B.1: el contenido (texto + media) abre el detalle de la publicación —
          /community/post/:postId. Este Link es HERMANO de los de arriba (avatar/identidad),
          nunca su ancestro ni su descendiente: el enlace de autor sigue yendo SOLO al perfil,
          nunca abre la publicación, y no hay controles interactivos anidados dentro de este
          enlace (MediaGrid solo pinta <img>, nunca <a>/<button>). */}
      <Link
        to={`/community/post/${post.id}`}
        aria-label="Ver publicación completa"
        className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
      >
        {post.text ? (
          <p className="mt-3 whitespace-pre-line break-words text-sm text-text-primary">
            {post.text}
          </p>
        ) : null}

        <MediaGrid media={post.media} />
      </Link>

      {/* Fase 9J-2C: HERMANO del Link de contenido (nunca dentro de él — un <button> anidado en
          un <a> es HTML inválido y CommunityLikeButton ya detiene su propia propagación de clic,
          así que activar "me gusta" nunca abre el detalle de la publicación). */}
      <div className="mt-2">
        <CommunityLikeButton
          postId={post.id}
          likeCount={post.likeCount}
          likedByMe={likedByMe}
        />
      </div>
    </li>
  );
}
