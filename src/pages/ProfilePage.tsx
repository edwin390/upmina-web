import { useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useAdminAccess } from "@/hooks/useAdminAccess";
import { useCommunityProfile } from "@/hooks/useCommunityProfile";
import { useOwnCommunityPosts } from "@/hooks/useOwnCommunityPosts";
import { useOwnProfile } from "@/hooks/useOwnProfile";
import CommunityPostEditorDialog from "@/components/community/CommunityPostEditorDialog";
import CommunityPostTileMenu from "@/components/community/CommunityPostTileMenu";
import type { CommunityOwnPost } from "@/lib/community-client";

// /@username (Fase 9J-2B, ampliado en 9J-2B.1): perfil PÚBLICO de Comunidad — identidad/contenido
// de solo lectura para un visitante, inspirado en la jerarquía de información de un perfil de
// creador estilo TikTok (nunca un clon pixel a pixel). AHORA también es la experiencia primaria
// del propio dueño cuando visita SU PROPIO /@username: misma base visual, más controles
// contextuales (Editar perfil, Nueva publicación, gestión ⋯ por publicación, atajo a
// /admin si aplica). /account sigue siendo la superficie de CONFIGURACIÓN (username, display
// name, bio — ver ProfileSection.tsx): "Editar perfil" navega ahí, nunca duplica ese formulario.
//
// Ownership (sección 23 del checkpoint, "never trust... frontend owner state"): se deriva
// EXCLUSIVAMENTE de useOwnProfile() (el username propio, leído con la sesión autenticada real),
// comparado contra el username de la URL — nunca de un valor del cliente ni de la respuesta
// pública en sí. Esto es solo UX: toda mutación (guardar/borrar) vuelve a exigir y re-verificar
// autenticación + propiedad EN EL SERVIDOR (ver community-post-handlers.ts), sin MFA privilegiada
// (gestionar contenido propio nunca lo fue).
//
// Likes NO existen todavía (9J-2C futuro): nunca se fabrica ni se muestra "0 likes". Avatar real
// tampoco (checkpoint futuro): el placeholder estilizado es deliberado, no un estado de carga.

interface GalleryTileData {
  id: string;
  text: string | null;
  createdAt: string;
  media: { id: string; url: string }[];
}

function toVisitorTile(post: {
  id: string;
  text: string | null;
  createdAt: string;
  media: { id: string; url: string }[];
}): GalleryTileData {
  return { id: post.id, text: post.text, createdAt: post.createdAt, media: post.media };
}

/** Solo la media ya lista (con URL resuelta) cuenta para la miniatura/el indicador — una imagen
 *  todavía procesándose no debe aparecer en la galería, mismo criterio "solo ready" que el resto
 *  de superficies públicas de Comunidad. */
function toOwnerTile(post: CommunityOwnPost): GalleryTileData {
  return {
    id: post.id,
    text: post.text,
    createdAt: post.createdAt,
    media: post.media
      .filter((m): m is typeof m & { url: string } => m.url !== null)
      .map((m) => ({ id: m.id, url: m.url })),
  };
}

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

function postTileLabel(tile: GalleryTileData): string {
  const when = new Date(tile.createdAt);
  const dateLabel = Number.isNaN(when.getTime())
    ? ""
    : new Intl.DateTimeFormat("es", { dateStyle: "medium" }).format(when);
  if (tile.media.length > 0) {
    const mediaLabel =
      tile.media.length === 1 ? "1 imagen" : `${tile.media.length} imágenes`;
    return `Publicación con ${mediaLabel}${dateLabel ? `, ${dateLabel}` : ""}`;
  }
  const preview = (tile.text ?? "").trim();
  return `Publicación de texto${dateLabel ? ` del ${dateLabel}` : ""}: ${preview}`;
}

interface PostTileProps {
  tile: GalleryTileData;
  /** Presente SOLO cuando este visitante es el dueño real (ver ownership arriba). */
  ownerPost?: CommunityOwnPost;
  onEdit?: (post: CommunityOwnPost) => void;
  onDeleted?: () => void;
}

/** Activar la tarjeta (click/tap/teclado) abre /community/post/:postId (Fase 9J-2B.1). El menú
 *  "⋯" del dueño es un HERMANO del Link (nunca un descendiente ni un ancestro): mismo patrón que
 *  CosplayCard.tsx — un Link absolute inset-0 como único objetivo de clic, el contenido visual
 *  pointer-events-none para que el clic lo atraviese, y el menú posicionado encima con su propio
 *  z-index, así que activarlo nunca abre también la publicación. */
function PostTile({ tile, ownerPost, onEdit, onDeleted }: PostTileProps) {
  const cover = tile.media[0] ?? null;
  return (
    <li>
      <div className="group relative aspect-square w-full overflow-hidden rounded-md border border-border-subtle bg-bg-surface">
        <Link
          to={`/community/post/${tile.id}`}
          aria-label={postTileLabel(tile)}
          className="absolute inset-0 z-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
        />
        <div className="pointer-events-none relative flex h-full w-full items-center justify-center">
          {cover ? (
            <>
              <img
                src={cover.url}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover transition-transform group-hover:scale-105"
              />
              <MultiMediaBadge count={tile.media.length} />
            </>
          ) : (
            <p className="line-clamp-6 break-words px-3 text-center text-xs text-text-secondary">
              {tile.text}
            </p>
          )}
        </div>
        {ownerPost && onEdit && onDeleted ? (
          <div className="absolute right-1.5 top-1.5 z-20">
            <CommunityPostTileMenu
              post={ownerPost}
              onEdit={onEdit}
              onDeleted={onDeleted}
            />
          </div>
        ) : null}
      </div>
    </li>
  );
}

const PRIMARY_BUTTON_CLASS =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold text-text-inverse transition hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary";
const SECONDARY_BUTTON_CLASS =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors hover:border-accent-primary/70 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary";

type EditorState = { mode: "create" } | { mode: "edit"; post: CommunityOwnPost } | null;

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

  // Todos los hooks se llaman INCONDICIONALMENTE (reglas de Hooks) antes de cualquier return
  // anticipado — el hook de abajo ya seguía ese patrón (username ?? "" en vez de saltarse la
  // llamada); estos nuevos hooks hacen lo mismo.
  const { profile: ownProfile, isLoading: ownProfileLoading } = useOwnProfile();
  // Ownership real: el username propio (autenticado) coincide con el de la URL. Mientras se
  // resuelve, nunca se asume dueño (evita un parpadeo de controles antes de confirmar identidad).
  const isOwnProfile =
    !ownProfileLoading && ownProfile !== null && ownProfile.username === username;

  const ownPosts = useOwnCommunityPosts(isOwnProfile);
  const { status: adminStatus, access: adminAccess } = useAdminAccess();
  const [editorState, setEditorState] = useState<EditorState>(null);

  if (username === null) return <Navigate to="/" replace />;

  const firstPage = data?.pages[0] ?? null;
  const notFound = !isLoading && !isError && firstPage === null;
  const profile = firstPage?.profile ?? null;

  const visitorTiles = (data?.pages.flatMap((page) => page?.posts.items ?? []) ?? []).map(
    toVisitorTile,
  );
  const ownerTiles = (ownPosts.data ?? []).map(toOwnerTile);
  const tiles = isOwnProfile ? ownerTiles : visitorTiles;

  const showAdminShortcut =
    isOwnProfile && adminStatus === "ready" && adminAccess?.role === "admin";

  function refreshAfterMutation() {
    void ownPosts.invalidate();
    void refetch();
  }

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

            {isOwnProfile ? (
              <div className="mt-2 flex flex-wrap justify-center gap-3">
                <Link to="/account" className={SECONDARY_BUTTON_CLASS}>
                  Editar perfil
                </Link>
                <button
                  type="button"
                  onClick={() => setEditorState({ mode: "create" })}
                  className={PRIMARY_BUTTON_CLASS}
                >
                  Nueva publicación
                </button>
              </div>
            ) : null}

            {showAdminShortcut ? (
              <Link
                to="/admin"
                className="mt-1 text-sm font-semibold text-accent-primary underline decoration-accent-primary/40 underline-offset-4 hover:decoration-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
              >
                Panel de administración
              </Link>
            ) : null}
          </header>

          <div className="mt-6 border-t border-border-subtle pt-6">
            {tiles.length === 0 ? (
              <div className="rounded-lg border border-border-subtle bg-bg-surface px-6 py-16 text-center">
                <p className="font-display text-lg tracking-wide text-text-primary">
                  Todavía no hay publicaciones
                </p>
                <p className="mt-2 text-text-secondary">
                  {isOwnProfile
                    ? "Cuando publiques, tus publicaciones aparecerán aquí."
                    : `Cuando @${profile.username} publique, sus publicaciones aparecerán aquí.`}
                </p>
              </div>
            ) : (
              <>
                <ul className="grid grid-cols-3 gap-1 sm:gap-2">
                  {tiles.map((tile, index) => (
                    <PostTile
                      key={tile.id}
                      tile={tile}
                      ownerPost={isOwnProfile ? ownPosts.data?.[index] : undefined}
                      onEdit={
                        isOwnProfile
                          ? (post) => setEditorState({ mode: "edit", post })
                          : undefined
                      }
                      onDeleted={isOwnProfile ? refreshAfterMutation : undefined}
                    />
                  ))}
                </ul>

                {!isOwnProfile && hasNextPage ? (
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

      {editorState ? (
        <CommunityPostEditorDialog
          initialPost={editorState.mode === "edit" ? editorState.post : null}
          onClose={() => setEditorState(null)}
          onSaved={() => {
            setEditorState(null);
            refreshAfterMutation();
          }}
        />
      ) : null}
    </div>
  );
}
