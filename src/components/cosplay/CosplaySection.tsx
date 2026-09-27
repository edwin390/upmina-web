import { useTranslations } from "use-intl";
import { useCosplayList } from "@/hooks/useCosplayList";
import CosplayCard from "./CosplayCard";
import CosplayHero from "./CosplayHero";

/** Contenido de /cosplay (Fase 9I-1): hero + grid responsive + "Cargar más" (cursor, sin scroll
 *  infinito ni búsqueda/filtros, decisión congelada de 9I). El vacío es un estado de PRODUCTO
 *  cuidado, no un error: Cosplay es un dominio nuevo y Production puede empezar sin
 *  publicaciones. */
export default function CosplaySection() {
  const t = useTranslations("cosplay.list");
  const { data, isLoading, isError, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useCosplayList();

  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const [hero, ...rest] = items;

  return (
    <section className="mx-auto max-w-6xl px-4 py-16">
      <header className="mb-8">
        <h1 className="font-display text-3xl tracking-wide">{t("heading")}</h1>
        <p className="mt-1 text-text-secondary">{t("subheading")}</p>
      </header>

      {isLoading && (
        <p role="status" className="text-text-muted">
          {t("loading")}
        </p>
      )}

      {isError && (
        <p role="status" className="text-text-muted">
          {t("error")}
        </p>
      )}

      {!isLoading && !isError && items.length === 0 && (
        <div className="rounded-lg border border-border-subtle bg-bg-surface px-6 py-16 text-center">
          <p className="font-display text-lg tracking-wide text-text-primary">
            {t("empty.title")}
          </p>
          <p className="mt-2 text-text-secondary">{t("empty.body")}</p>
        </div>
      )}

      {hero && (
        <>
          <CosplayHero post={hero} />
          {rest.length > 0 && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {rest.map((post) => (
                <CosplayCard key={post.id} post={post} />
              ))}
            </div>
          )}
          {hasNextPage && (
            <div className="mt-8 flex justify-center">
              <button
                type="button"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                className="rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors hover:border-accent-primary/70 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:opacity-50"
              >
                {t("loadMore")}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
