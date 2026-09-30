import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth-context";
import { setCommunityPostLike } from "@/lib/community-client";

// Control de "me gusta" de una publicación de Comunidad (Fase 9J-2C). Reutilizable en el feed
// (CommunityFeedCard), el detalle (PostDetailPage) y — en su variante de solo lectura, ver
// CommunityLikeCountBadge más abajo — la galería del perfil público. Nunca un segundo tipo de
// reacción: ♡/♥ es la única semántica, tal como congela el checkpoint.
//
// Estado local con reconciliación optimista (sección 9 del checkpoint): el clic actualiza
// liked/count de inmediato; si el backend confirma, se reconcilia con la respuesta REAL del
// servidor (nunca se asume que el optimismo acertó); si falla, se revierte a los valores previos
// al clic. Un `isPending` bloquea clics repetidos mientras una mutación sigue en vuelo — "evita
// duplicar mutaciones por clics rápidos" sin construir una cola offline.
//
// Visitante: el clic NUNCA muta nada client-side ni se descarta en silencio — navega a
// /login?returnTo=/community (el único destino de Comunidad en la allowlist de safe-return-to.ts;
// /community/post/:id y /@username son rutas dinámicas, fuera de ese modelo de tabla exacta, así
// que "volver al feed" es el destino seguro más cercano, suficiente según el checkpoint: "Returning
// them to the post/feed is sufficient").

const LOGIN_PATH = "/login?returnTo=/community";

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 2}
    >
      <path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 2.7 5 6.1 5c2 0 3.3 1 3.9 2.1h4C14.6 6 15.9 5 17.9 5c3.4 0 5.2 3.4 3.7 6.8C19.5 16.4 12 21 12 21z" />
    </svg>
  );
}

export interface CommunityLikeButtonProps {
  postId: string;
  likeCount: number;
  likedByMe: boolean;
  /** Detiene la propagación del clic (evita abrir el detalle de la publicación cuando el botón
   *  vive dentro de una tarjeta cuyo contenido es, aparte, un enlace). Por defecto true. */
  stopPropagation?: boolean;
  className?: string;
}

export default function CommunityLikeButton({
  postId,
  likeCount,
  likedByMe,
  stopPropagation = true,
  className,
}: CommunityLikeButtonProps) {
  const { session } = useAuth();
  const authenticated = Boolean(session);
  const navigate = useNavigate();

  const [liked, setLiked] = useState(likedByMe);
  const [count, setCount] = useState(likeCount);
  const [isPending, setIsPending] = useState(false);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Una vez que ESTA instancia confirmó su propio like/unlike contra el backend, su estado local
  // pasa a ser la verdad para el resto de su vida útil: `likedByMe`/`likeCount` (props) vienen de
  // consultas por lote (useCommunityLikedByMe) y del feed (useCommunityFeed) que NUNCA se
  // invalidan tras un like — si esa consulta por lote seguía en vuelo desde antes del clic y
  // resuelve DESPUÉS de que el propio clic ya confirmó el estado real, sin este flag su valor
  // (correcto pero más viejo que nuestra propia mutación) pisaría el toggle que el usuario acaba
  // de completar, dando la sensación de que el clic "no funcionó". Se reinicia solo al desmontar
  // (navegar fuera y volver monta una instancia nueva, que sincroniza con props frescos).
  const hasLocalMutationRef = useRef(false);

  // Resincroniza con la verdad del servidor cuando llega (p. ej. useCommunityLikedByMe resuelve
  // después del primer render, o un refetch trae datos nuevos) — nunca mientras una mutación
  // propia sigue en vuelo (para no pisar el optimismo del clic recién hecho) ni después de que
  // esta instancia ya confirmó su propio estado contra el backend.
  useEffect(() => {
    if (isPending || hasLocalMutationRef.current) return;
    setLiked(likedByMe);
    setCount(likeCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [likedByMe, likeCount]);

  function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    if (stopPropagation) event.stopPropagation();

    if (!authenticated) {
      navigate(LOGIN_PATH);
      return;
    }
    if (isPending) return;

    const prevLiked = liked;
    const prevCount = count;
    const next = !prevLiked;

    setLiked(next);
    setCount(Math.max(0, next ? prevCount + 1 : prevCount - 1));
    setIsPending(true);

    setCommunityPostLike({ postId, liked: next })
      .then((result) => {
        if (!isMountedRef.current) return;
        hasLocalMutationRef.current = true;
        setLiked(result.likedByMe);
        setCount(result.likeCount);
      })
      .catch(() => {
        if (!isMountedRef.current) return;
        setLiked(prevLiked);
        setCount(prevCount);
      })
      .finally(() => {
        if (isMountedRef.current) setIsPending(false);
      });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      aria-pressed={liked}
      aria-busy={isPending}
      aria-label={liked ? `Quitar me gusta (${count})` : `Me gusta (${count})`}
      className={
        className ??
        `inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary ${
          liked ? "text-accent-live" : "text-text-secondary hover:text-text-primary"
        }`
      }
    >
      <HeartIcon filled={liked} />
      <span aria-hidden="true">{count}</span>
    </button>
  );
}

/** Variante de SOLO LECTURA para la galería del perfil (sección 13 del checkpoint: "Do NOT put a
 *  large permanent like button over every profile tile... display-only at gallery level"). Nunca
 *  interactiva: activar la miniatura sigue abriendo el detalle de la publicación (el tile es un
 *  <Link>; este badge es contenido visual puro, pointer-events-none, igual que MultiMediaBadge en
 *  ProfilePage.tsx). */
export function CommunityLikeCountBadge({ count }: { count: number }) {
  return (
    <span
      aria-hidden="true"
      className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white"
    >
      <HeartIcon filled={count > 0} />
      {count}
    </span>
  );
}
