import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { InstagramMediaItem } from "@/types";
import {
  InstagramCommentsPermissionError,
  instagramChildrenQuery,
  useInstagramChildren,
  useInstagramComments,
} from "@/hooks/useInstagramPost";
import { useInstagramProfile } from "@/hooks/useInstagramProfile";
import { formatRelativeDate } from "@/lib/format";
import { getKnownAspectRatio, rememberAspectRatio, wrapIndex } from "@/lib/media-ratio";
import { CommentIcon, HeartIcon } from "./InstagramIcons";
import InstagramMediaViewer, { type ViewerSlide } from "./InstagramMediaViewer";
import ProfileAvatar from "./ProfileAvatar";

interface InstagramPostModalProps {
  /** Publicaciones del feed, en el orden de la grid. */
  items: InstagramMediaItem[];
  /** Índice de la publicación abierta. */
  index: number;
  /** Cambia de publicación (circular): -1 anterior, +1 siguiente. */
  onNavigate: (delta: number) => void;
  onClose: () => void;
  /** Elemento que abrió el modal; recupera el foco al cerrarlo. */
  returnFocusTo?: HTMLElement | null;
}

const dateFormat = new Intl.DateTimeFormat("es", { dateStyle: "long" });
const formatDate = (iso: string) => dateFormat.format(new Date(iso));

const POST_NAV_BUTTON =
  "grid h-12 w-12 place-items-center rounded-full border-2 border-accent-secondary bg-bg-base/90 text-2xl text-accent-secondary shadow-glow-secondary transition-colors hover:bg-accent-secondary hover:text-text-inverse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary";

function ViewCommentsLink({ permalink }: { permalink: string }) {
  return (
    <a
      href={permalink}
      target="_blank"
      rel="noreferrer noopener"
      className="text-sm font-medium text-accent-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
    >
      Ver comentarios en Instagram →
    </a>
  );
}

function CommentsBlock({ item }: { item: InstagramMediaItem }) {
  // Con 0 comentarios conocidos no hace falta preguntar a Meta.
  const hasNone = item.commentsCount === 0;
  const { data, isLoading, error } = useInstagramComments(item.id, !hasNone);

  const total = item.commentsCount;
  const totalText =
    total === undefined ? "" : `${total} ${total === 1 ? "comentario" : "comentarios"}`;

  let content;
  if (hasNone) {
    content = <p className="text-text-muted">Todavía no hay comentarios.</p>;
  } else if (isLoading) {
    content = <p className="text-text-muted">Cargando comentarios…</p>;
  } else if (error instanceof InstagramCommentsPermissionError) {
    // Meta devolvió un error EXPLÍCITO de permisos (403): es el único caso en que se
    // habla de permisos. Sin comentarios inventados.
    content = (
      <div className="space-y-1 text-text-muted">
        <p>
          {totalText ? `${totalText} en Instagram. ` : ""}
          Los comentarios no se pueden mostrar aquí todavía.
        </p>
        <ViewCommentsLink permalink={item.permalink} />
        {import.meta.env.DEV && (
          <p className="text-xs text-accent-warning">
            Dev: Meta rechazó la lectura de comentarios por permisos (¿falta
            instagram_business_manage_comments en el token?).
          </p>
        )}
      </div>
    );
  } else if (error) {
    content = <p className="text-text-muted">No se pudieron cargar los comentarios.</p>;
  } else if (data && data.comments.length > 0) {
    content = (
      <ul className="space-y-3">
        {data.comments.map((comment) => (
          <li key={comment.id} className="break-words text-sm text-text-secondary">
            {comment.username && (
              <span className="mr-1.5 font-semibold text-text-primary">
                {comment.username}
              </span>
            )}
            {comment.text}
            {(comment.timestamp || comment.likeCount !== undefined) && (
              <span className="mt-0.5 flex items-center gap-3 text-xs text-text-muted">
                {comment.timestamp && (
                  <span>{formatRelativeDate(comment.timestamp)}</span>
                )}
                {comment.likeCount !== undefined && (
                  <span className="inline-flex items-center gap-1">
                    <HeartIcon /> {comment.likeCount}
                    <span className="sr-only">Me gusta</span>
                  </span>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
    );
  } else if (total !== undefined && total > 0) {
    // HTTP 200 con lista vacía pero comments_count > 0: Meta no entrega el contenido.
    // No se interpreta como falta de permisos: se muestra el número y se enlaza al post.
    content = (
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-text-muted">
        <span>{totalText}</span>
        <ViewCommentsLink permalink={item.permalink} />
      </p>
    );
  } else {
    // Estado DESCONOCIDO: Meta no dio `comments_count` (commentsCount === undefined) y la lista
    // llegó vacía. No se sabe si hay comentarios, así que no se afirma que no los haya ni se
    // habla de permisos: solo se ofrece consultarlos en Instagram. (Con commentsCount === 0 no
    // se llega aquí: ese caso se resuelve arriba sin consultar a Meta.)
    content = (
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-text-muted">
        <span>Los comentarios pueden consultarse en Instagram.</span>
        <ViewCommentsLink permalink={item.permalink} />
      </p>
    );
  }

  return (
    <section aria-label="Comentarios" className="border-t border-border-subtle pt-4">
      <h3 className="mb-3 text-sm font-semibold text-text-primary">Comentarios</h3>
      {content}
    </section>
  );
}

/** Contenido de UNA publicación. Se monta con `key` = id: cada post empieza limpio (slide 1). */
function PostView({
  item,
  position,
  total,
  onClose,
}: {
  item: InstagramMediaItem;
  position: number;
  total: number;
  onClose: () => void;
}) {
  const isCarousel = item.mediaType === "CAROUSEL_ALBUM";
  const { data: children } = useInstagramChildren(item.id, isCarousel);
  // Proporción real: la que ya midió la grid o, mientras tanto, 1:1.
  const [ratio, setRatio] = useState(() => getKnownAspectRatio(item.id) ?? 1);

  const slides = useMemo<ViewerSlide[]>(() => {
    if (isCarousel && children && children.length > 0) {
      return children.map((child) => ({
        id: child.id,
        type: child.mediaType,
        imageUrl: child.imageUrl,
        videoUrl: child.videoUrl,
      }));
    }
    // Mientras cargan los children (o si fallan) se muestra la portada del feed.
    return [
      {
        id: item.id,
        type: item.mediaType === "VIDEO" ? "VIDEO" : "IMAGE",
        imageUrl: item.imageUrl,
        videoUrl: item.videoUrl,
      },
    ];
  }, [isCarousel, children, item]);

  // Perfil compartido (una sola petición para todo el modal, con caché).
  const { data: profile } = useInstagramProfile();
  const username = item.username ?? profile?.username;

  const label = item.caption ?? "Publicación de Instagram";
  const isReel = item.productType === "REELS";

  return (
    <div className="flex min-w-0 flex-col lg:h-full lg:flex-row">
      {/* Móvil: ancho completo con la proporción real (tope de alto); escritorio: la
          columna se ajusta a la proporción y ocupa todo el alto. */}
      <div
        style={{ "--ig-ratio": ratio } as CSSProperties}
        className="relative aspect-[var(--ig-ratio)] max-h-[68dvh] w-full shrink-0 lg:aspect-auto lg:h-full lg:max-h-none lg:w-[clamp(380px,calc(min(88dvh,720px)*var(--ig-ratio)),min(684px,68%))]"
      >
        <InstagramMediaViewer
          slides={slides}
          label={label}
          onRatio={(next) => {
            setRatio(next);
            rememberAspectRatio(item.id, next, 1);
          }}
        />
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border-subtle p-4">
          <ProfileAvatar url={profile?.profilePictureUrl} name={username} />
          <div className="min-w-0 flex-1">
            <h2 id="ig-modal-title" className="truncate text-sm font-semibold">
              {username ?? "Instagram"}
            </h2>
            <p className="text-xs text-text-muted">
              {isReel && <span className="mr-2 text-accent-secondary">Reel</span>}
              {total > 1 && `Publicación ${position} de ${total}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            data-autofocus
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-xl text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 p-4 lg:overflow-y-auto">
          {item.caption && (
            <p className="whitespace-pre-line break-words text-sm leading-relaxed text-text-secondary">
              {item.caption}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-text-secondary">
            {item.likeCount !== undefined && (
              <span className="inline-flex items-center gap-1.5 text-accent-primary">
                <HeartIcon />
                <span className="text-text-primary">{item.likeCount}</span>
                <span className="sr-only">Me gusta</span>
              </span>
            )}
            {item.commentsCount !== undefined && (
              <span className="inline-flex items-center gap-1.5 text-accent-secondary">
                <CommentIcon />
                <span className="text-text-primary">{item.commentsCount}</span>
                <span className="sr-only">Comentarios</span>
              </span>
            )}
            <time dateTime={item.timestamp} className="text-text-muted">
              {formatDate(item.timestamp)}
            </time>
          </div>

          <CommentsBlock item={item} />
        </div>

        <footer className="border-t border-border-subtle p-4">
          <a
            href={item.permalink}
            target="_blank"
            rel="noreferrer noopener"
            className="block rounded-md bg-accent-primary px-4 py-2 text-center text-sm font-semibold text-text-inverse transition-shadow hover:shadow-glow-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
          >
            Ver en Instagram →
          </a>
        </footer>
      </div>
    </div>
  );
}

/**
 * Modal de publicación. Dos niveles de navegación distintos:
 * - Elementos de un carrusel: flechas pequeñas sobre la media (InstagramMediaViewer).
 * - Publicaciones del feed: botones grandes fuera de la media (laterales en escritorio,
 *   barra superior en móvil), circulares.
 *
 * Regla de teclado ← →: si el foco está dentro del visor de un carrusel, cambian los
 * elementos (el visor consume el evento); en cualquier otro caso cambian de
 * publicación. Se ignoran con modificadores y sobre <video> o campos de texto.
 */
export default function InstagramPostModal({
  items,
  index,
  onNavigate,
  onClose,
  returnFocusTo,
}: InstagramPostModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pressStartedOnBackdrop = useRef(false);
  const queryClient = useQueryClient();

  const item = items[index];
  const total = items.length;
  const canNavigate = total > 1;

  // El padre pasa callbacks nuevos en cada render; los efectos no deben reiniciarse por eso.
  const onCloseRef = useRef(onClose);
  const onNavigateRef = useRef(onNavigate);
  const canNavigateRef = useRef(canNavigate);
  useEffect(() => {
    onCloseRef.current = onClose;
    onNavigateRef.current = onNavigate;
    canNavigateRef.current = canNavigate;
  });

  // showModal() da focus trap y fondo inerte de forma nativa.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    // Foco inicial fuera del visor: por defecto ← → cambian de publicación; solo al
    // interactuar con el carrusel (foco dentro del visor) cambian de elemento.
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      // Si el visor de un carrusel ya consumió la flecha, no se cambia de post.
      if (event.defaultPrevented) return;

      // Escape explícito: no depende de que el navegador dispare `cancel`.
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (!canNavigateRef.current) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as Element | null;
      if (target?.closest?.("video, input, textarea, select, [contenteditable]")) return;

      event.preventDefault();
      onNavigateRef.current(event.key === "ArrowLeft" ? -1 : 1);
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      // Diferido un frame y solo si el diálogo ya salió del DOM (desmontaje real,
      // no la simulación de StrictMode): el foco vuelve a la tarjeta que lo abrió.
      requestAnimationFrame(() => {
        if (!dialog.isConnected) returnFocusTo?.focus?.();
      });
    };
  }, [returnFocusTo]);

  // Precarga solo de los dos vecinos (no de todo el feed): sus children si son
  // carrusel y la portada para conocer su proporción antes de mostrarlos.
  useEffect(() => {
    if (total < 2) return;
    const neighbors = new Set([wrapIndex(index, -1, total), wrapIndex(index, 1, total)]);
    neighbors.delete(index);

    for (const i of neighbors) {
      const neighbor = items[i];
      if (neighbor.mediaType === "CAROUSEL_ALBUM") {
        void queryClient.prefetchQuery(instagramChildrenQuery(neighbor.id));
      }
      if (getKnownAspectRatio(neighbor.id) === undefined) {
        const image = new Image();
        image.onload = () =>
          rememberAspectRatio(neighbor.id, image.naturalWidth, image.naturalHeight);
        image.src = neighbor.imageUrl;
      }
    }
  }, [index, items, total, queryClient]);

  if (!item) return null;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="ig-modal-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        pressStartedOnBackdrop.current = isBackdrop(event.target, event.currentTarget);
      }}
      onClick={(event) => {
        // Solo cierra si pulsar y soltar fueron ambos sobre el fondo.
        if (
          pressStartedOnBackdrop.current &&
          isBackdrop(event.target, event.currentTarget)
        ) {
          onClose();
        }
      }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden bg-transparent p-0 text-text-primary backdrop:bg-black/80 backdrop:backdrop-blur-sm"
    >
      <div
        data-ig-backdrop
        className="grid h-full w-full place-items-center p-2 lg:px-[72px] lg:py-6"
      >
        <div className="max-h-full w-full max-w-5xl overflow-y-auto rounded-xl border border-border-strong bg-bg-surface shadow-glow-secondary lg:h-[min(88dvh,720px)] lg:overflow-hidden">
          {canNavigate && (
            <div className="flex items-center justify-between border-b border-border-subtle px-2 py-1 lg:hidden">
              <button
                type="button"
                onClick={() => onNavigate(-1)}
                aria-label="Publicación anterior"
                className="rounded-md px-3 py-2 text-sm font-semibold text-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
              >
                ‹ Anterior
              </button>
              <span className="text-xs text-text-muted">
                {index + 1} / {total}
              </span>
              <button
                type="button"
                onClick={() => onNavigate(1)}
                aria-label="Publicación siguiente"
                className="rounded-md px-3 py-2 text-sm font-semibold text-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
              >
                Siguiente ›
              </button>
            </div>
          )}

          <PostView
            key={item.id}
            item={item}
            position={index + 1}
            total={total}
            onClose={onClose}
          />
        </div>
      </div>

      {canNavigate && (
        <>
          <button
            type="button"
            onClick={() => onNavigate(-1)}
            aria-label="Publicación anterior"
            className={`${POST_NAV_BUTTON} fixed left-3 top-1/2 hidden -translate-y-1/2 lg:grid`}
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => onNavigate(1)}
            aria-label="Publicación siguiente"
            className={`${POST_NAV_BUTTON} fixed right-3 top-1/2 hidden -translate-y-1/2 lg:grid`}
          >
            ›
          </button>
        </>
      )}

      <p className="sr-only" aria-live="polite">
        {canNavigate ? `Publicación ${index + 1} de ${total}` : ""}
      </p>
    </dialog>
  );
}

// El "fondo" es el propio <dialog> (transparente, a pantalla completa) o su contenedor
// centrador: cualquier clic fuera de la tarjeta.
function isBackdrop(target: EventTarget, dialog: HTMLElement): boolean {
  return target === dialog || (target as HTMLElement).dataset?.igBackdrop !== undefined;
}
