import { useInstagramFeed } from "@/hooks/useInstagramFeed";
import InstagramGrid from "./InstagramGrid";

export default function InstagramSection() {
  const { data: items, isLoading } = useInstagramFeed();

  return (
    <section className="mx-auto max-w-6xl px-4 py-16">
      <h2 className="mb-6 font-display text-3xl tracking-wide">INSTAGRAM</h2>
      {isLoading && <p className="text-text-muted">Cargando publicaciones…</p>}
      {items && <InstagramGrid items={items} />}
    </section>
  );
}
