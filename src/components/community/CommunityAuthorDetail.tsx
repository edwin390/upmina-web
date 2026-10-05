import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { fetchAuthorPost, acknowledgeAuthorNotice } from "@/lib/community-client";
import { NO_PROCEDE_NOTICE } from "@/lib/community-author-contract";
import CommunityPostMediaViewer from "./CommunityPostMediaViewer";
import CommunityPostTileMenu from "./CommunityPostTileMenu";
import { refreshCommunityContent } from "@/lib/content-freshness";
import type { CommunityFeedMediaItem } from "@/types";
import CommunityLikeButton from "./CommunityLikeButton";
import { useCommunityLikedByMe } from "@/hooks/useCommunityLikedByMe";

/** Private application content, not private storage delivery (R4-D). No prefetch/GET consumes a notice. */
export default function CommunityAuthorDetail({ postId }: { postId: string }) {
  const { user, session, loading } = useAuth();
  const client = useQueryClient();
  const attempted = useRef<string | null>(null);
  const deadlineRef = useRef<number | null>(null);
  const key = ["community", "author-detail", user?.id, postId];
  const query = useQuery({
    queryKey: key,
    enabled: !loading && Boolean(user && session),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: async () => {
      const started = performance.now();
      const r = await fetchAuthorPost(postId, true);
      const deadline = r?.items[0]?.moderation.deadline;
      deadlineRef.current =
        r && deadline
          ? performance.now() +
            Math.max(
              0,
              Date.parse(deadline) -
                Date.parse(r.serverNow) -
                (performance.now() - started),
            )
          : null;
      return r;
    },
  });
  const response = user && session && !query.isError ? query.data : null;
  const { refetch } = query;
  const post = response?.items[0];
  const notice = response?.noticeId;
  const { likedByMe } = useCommunityLikedByMe(
    post?.status === "published" ? [post.id] : [],
  );
  useEffect(() => {
    if (!post || !notice || attempted.current === notice) return;
    // Effect runs only after the detail and its notice have committed to the visible document.
    // A hidden tab waits until presentation; failures leave the durable notice unseen.
    let frame: number | undefined;
    const present = () => {
      if (document.visibilityState === "hidden") return;
      frame = requestAnimationFrame(() => {
        if (document.visibilityState === "hidden" || attempted.current === notice) return;
        attempted.current = notice;
        void acknowledgeAuthorNotice(post.id, notice)
          .then(() =>
            // Only a server-confirmed ACK refreshes the private Profile list (never optimistic).
            client.invalidateQueries({ queryKey: ["community", "own-posts"] }),
          )
          .catch(() => undefined);
      });
    };
    present();
    document.addEventListener("visibilitychange", present);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", present);
    };
  }, [notice, post, client]);
  useEffect(() => {
    if (!post || deadlineRef.current === null) return;
    const timer = setTimeout(
      () => {
        client.setQueryData(["community", "author-detail", user?.id, postId], null);
        void client.invalidateQueries({ queryKey: ["community", "own-posts"] });
        void refetch();
      },
      Math.min(Math.max(0, deadlineRef.current - performance.now()), 2147483647),
    );
    return () => clearTimeout(timer);
  }, [post, postId, user?.id, client, refetch]);
  if (loading || (query.isLoading && session))
    return <p role="status">Cargando publicación…</p>;
  if (!session)
    return (
      <p>
        Inicia sesión para acceder a tu publicación.{" "}
        <Link to="/login">Iniciar sesión</Link>
      </p>
    );
  if (query.isError)
    return (
      <div role="alert">
        No se pudo cargar esta publicación.{" "}
        <button type="button" onClick={() => void query.refetch()}>
          Reintentar
        </button>
      </div>
    );
  if (!post) return <p>Esta publicación no está disponible.</p>;
  const media = post.media
    .filter(
      (m): m is typeof m & { url: string; width: number; height: number } =>
        m.url !== null && m.width !== null && m.height !== null,
    )
    .map(
      ({
        id,
        position,
        kind,
        url,
        width,
        height,
        durationSeconds,
      }): CommunityFeedMediaItem => ({
        id,
        position,
        kind,
        url,
        width,
        height,
        durationSeconds,
      }),
    );
  return (
    <article className="min-w-0 rounded-lg border border-border-subtle bg-bg-surface p-4 sm:p-6">
      <Link
        to={`/@${post.author.username}`}
        className="text-accent-primary hover:underline"
      >
        Volver a mi perfil
      </Link>
      <p className="mt-4 text-text-secondary">
        {post.author.displayName ?? `@${post.author.username}`} ·{" "}
        <time dateTime={post.createdAt}>
          {new Intl.DateTimeFormat("es", {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(post.createdAt))}
        </time>
      </p>
      {post.moderation.kind !== "none" && (
        <section
          className="mt-4 rounded-md border border-accent-primary/40 bg-bg-elevated p-4"
          aria-label="Estado de la publicación"
        >
          <h1 className="font-display text-xl">
            {post.moderation.kind === "paused"
              ? "Publicación pausada"
              : "Publicación retirada"}
          </h1>
          {post.moderation.kind === "paused" ? (
            <p className="mt-2">
              Esta publicación fue ocultada temporalmente mientras el equipo de moderación
              revisa reportes.
            </p>
          ) : (
            <>
              <p className="mt-2">Esta publicación fue retirada por moderación.</p>
              <p className="mt-2">
                Se eliminará permanentemente después del{" "}
                <time dateTime={post.moderation.deadline!}>
                  {new Intl.DateTimeFormat("es", {
                    dateStyle: "long",
                    timeStyle: "short",
                  }).format(new Date(post.moderation.deadline!))}
                </time>
                . La retención inicial es de 72 horas (3 días).
              </p>
              <h2 className="mt-4 font-semibold">Mensaje de moderación</h2>
              <p className="mt-2 whitespace-pre-wrap break-words">
                {post.moderation.message}
              </p>
            </>
          )}
        </section>
      )}
      {notice && (
        <p
          role="status"
          className="mt-4 rounded-md border border-accent-secondary/40 p-4"
        >
          {NO_PROCEDE_NOTICE}
        </p>
      )}
      <p className="mt-4 whitespace-pre-wrap break-words">{post.text}</p>
      <CommunityPostMediaViewer media={media} />
      {post.status === "published" && (
        <CommunityLikeButton
          postId={post.id}
          likeCount={post.likeCount}
          likedByMe={likedByMe?.has(post.id) ?? false}
          stopPropagation={false}
        />
      )}
      <div className="mt-4">
        <CommunityPostTileMenu
          post={post}
          allowEdit={false}
          onEdit={() => {}}
          onDeleted={() => {
            client.setQueryData(key, null);
            void refreshCommunityContent(client, post.author.username, post.id, true);
          }}
        />
      </div>
    </article>
  );
}
