import { useCallback, useState } from "react";
import { useTikTokVideos } from "@/hooks/useTikTokVideos";
import { wrapIndex } from "@/lib/media-ratio";
import TikTokCard from "./TikTokCard";
import TikTokViewer from "./TikTokViewer";

export default function TikTokSection() {
  const { data: videos, isLoading, isError } = useTikTokVideos();
  // Se guarda el id (no el índice): si el feed se refresca, el visor sigue en el mismo vídeo.
  const [selected, setSelected] = useState<{ id: string; trigger: HTMLElement } | null>(
    null,
  );
  const selectedIndex =
    selected && videos ? videos.findIndex((video) => video.id === selected.id) : -1;

  const navigate = useCallback(
    (delta: number) => {
      if (!videos || selectedIndex < 0) return;
      setSelected((current) =>
        current
          ? { ...current, id: videos[wrapIndex(selectedIndex, delta, videos.length)].id }
          : current,
      );
    },
    [videos, selectedIndex],
  );

  return (
    <section className="mx-auto max-w-6xl px-4 py-16">
      <h2 className="mb-6 font-display text-3xl tracking-wide">TIKTOK</h2>

      {isLoading && <p className="text-text-muted">Cargando videos…</p>}

      {isError && (
        <p role="status" className="text-text-muted">
          No se pudieron cargar los videos de TikTok ahora mismo. Inténtalo de nuevo más
          tarde.
        </p>
      )}

      {videos && videos.length === 0 && (
        <p className="text-text-muted">Todavía no hay videos para mostrar.</p>
      )}

      {/* Portadas verticales 9:16: 2 columnas en móvil (como el perfil de TikTok) y hasta
          4 en escritorio, para que las tarjetas no crezcan de más. */}
      {videos && videos.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
          {videos.map((video) => (
            <TikTokCard
              key={video.id}
              video={video}
              onOpen={(item, trigger) => setSelected({ id: item.id, trigger })}
            />
          ))}
        </div>
      )}

      {videos && selected && selectedIndex >= 0 && (
        <TikTokViewer
          videos={videos}
          index={selectedIndex}
          onNavigate={navigate}
          returnFocusTo={selected.trigger}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
