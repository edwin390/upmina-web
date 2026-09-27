import { Link } from "react-router-dom";
import { useTranslations } from "use-intl";
import type { CosplayPostSummary } from "@/types";
import { resolveRequiredEditorial } from "@/lib/cosplay-domain";
import { useUpminaLocale } from "@/i18n/useUpminaLocale";

/** Publicación destacada del listado (la más reciente): imagen grande con el título superpuesto.
 *  Puramente presentacional, sin lógica propia de "qué es lo destacado" (la decide CosplaySection
 *  con la primera del array, que ya viene ordenado por published_at desde el servidor). */
export default function CosplayHero({ post }: { post: CosplayPostSummary }) {
  const { locale } = useUpminaLocale();
  const t = useTranslations("cosplay.list");
  const title = resolveRequiredEditorial(
    { es: post.titleEs, en: post.titleEn, de: post.titleDe },
    locale,
  );

  return (
    <Link
      to={`/cosplay/${post.slug}`}
      className="group relative mb-8 block overflow-hidden rounded-xl border border-border-subtle bg-bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
    >
      <div className="relative aspect-[16/10] w-full overflow-hidden sm:aspect-[21/9]">
        {post.cover && (
          <img
            src={post.cover.url}
            alt=""
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
      </div>
      <div className="absolute inset-x-0 bottom-0 p-4 sm:p-6">
        <span className="mb-2 inline-block rounded-full bg-accent-primary/90 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-text-inverse">
          {t("heroLabel")}
        </span>
        <h2
          {...(title.lang !== locale ? { lang: title.lang } : {})}
          className="font-display text-2xl tracking-wide text-white drop-shadow sm:text-4xl"
        >
          {title.text}
        </h2>
      </div>
    </Link>
  );
}
