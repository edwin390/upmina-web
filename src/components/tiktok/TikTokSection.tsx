import { useTikTokVideos } from "@/hooks/useTikTokVideos";
import TikTokEmbed from "./TikTokEmbed";

export default function TikTokSection() {
  const { data: videos, isLoading } = useTikTokVideos();

  return (
    <section className="mx-auto max-w-6xl px-4 py-16">
      <h2 className="mb-6 font-display text-3xl tracking-wide">TIKTOK</h2>
      {isLoading && <p className="text-text-muted">Cargando videos…</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {videos?.map((video) => (
          <TikTokEmbed key={video.id} video={video} />
        ))}
      </div>
    </section>
  );
}
