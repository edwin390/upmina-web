import { useCallback, useState } from "react";
import { useInstagramFeed } from "@/hooks/useInstagramFeed";
import { useInstagramProfile } from "@/hooks/useInstagramProfile";
import { wrapIndex } from "@/lib/media-ratio";
import InstagramGrid from "./InstagramGrid";
import InstagramPostModal from "./InstagramPostModal";
import ProfileAvatar from "./ProfileAvatar";

const PROFILE_URL = "https://www.instagram.com/";

export default function InstagramSection() {
  const { data: items, isLoading, isError } = useInstagramFeed();
  // Se guarda el id (no el índice): si el feed se refresca, el modal sigue en el mismo post.
  const [selected, setSelected] = useState<{
    id: string;
    trigger: HTMLElement;
  } | null>(null);

  const { data: profile } = useInstagramProfile();
  const username = profile?.username ?? items?.find((item) => item.username)?.username;
  const selectedIndex =
    selected && items ? items.findIndex((i) => i.id === selected.id) : -1;

  const navigate = useCallback(
    (delta: number) => {
      if (!items || selectedIndex < 0) return;
      setSelected((current) =>
        current
          ? { ...current, id: items[wrapIndex(selectedIndex, delta, items.length)].id }
          : current,
      );
    },
    [items, selectedIndex],
  );

  return (
    <section className="mx-auto max-w-6xl px-4 py-16">
      <h2 className="mb-6 font-display text-3xl tracking-wide">INSTAGRAM</h2>

      {isLoading && <p className="text-text-muted">Cargando publicaciones…</p>}

      {isError && (
        <p role="status" className="text-text-muted">
          No se pudieron cargar las publicaciones de Instagram ahora mismo. Inténtalo de
          nuevo más tarde.
        </p>
      )}

      {items && items.length === 0 && (
        <p className="text-text-muted">Todavía no hay publicaciones para mostrar.</p>
      )}

      {items && items.length > 0 && (
        <>
          {username && (
            <a
              href={`${PROFILE_URL}${encodeURIComponent(username)}/`}
              target="_blank"
              rel="noreferrer noopener"
              className="group mb-4 inline-flex items-center gap-3 text-sm font-medium text-accent-primary"
            >
              <ProfileAvatar
                url={profile?.profilePictureUrl}
                name={username}
                className="h-10 w-10 sm:h-11 sm:w-11"
              />
              <span className="group-hover:underline">@{username} en Instagram →</span>
            </a>
          )}
          <InstagramGrid
            items={items}
            onSelect={(item, trigger) => setSelected({ id: item.id, trigger })}
          />
        </>
      )}

      {items && selected && selectedIndex >= 0 && (
        <InstagramPostModal
          items={items}
          index={selectedIndex}
          onNavigate={navigate}
          returnFocusTo={selected.trigger}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
