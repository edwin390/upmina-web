import { Link } from "react-router-dom";
import { useTranslations } from "use-intl";
import type { CosplayPostSummary } from "@/types";
import { resolveRequiredEditorial } from "@/lib/cosplay-domain";
import { useUpminaLocale } from "@/i18n/useUpminaLocale";

export default function CosplayCard({ post }: { post: CosplayPostSummary }) {
  const { locale } = useUpminaLocale();
  const t = useTranslations("cosplay.list");
  const title = resolveRequiredEditorial(
    { es: post.titleEs, en: post.titleEn, de: post.titleDe },
    locale,
  );
  const meta = [post.characterName, post.series].filter(Boolean).join(" · ");

  return (
    <Link
      to={`/cosplay/${post.slug}`}
      className="group flex flex-col overflow-hidden rounded-lg border border-transparent bg-bg-surface transition-[border-color,box-shadow] hover:border-accent-primary/70 hover:shadow-glow-primary focus-visible:border-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
    >
      <div className="relative aspect-[4/5] overflow-hidden bg-bg-elevated">
        {post.cover && (
          <img
            src={post.cover.url}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
          />
        )}
        {post.photoCount > 1 && (
          <span
            aria-hidden="true"
            className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white"
          >
            {t("photoCount", { count: post.photoCount })}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <h3
          {...(title.lang !== locale ? { lang: title.lang } : {})}
          className="line-clamp-2 font-display text-base tracking-wide text-text-primary"
        >
          {title.text}
        </h3>
        {meta && <p className="line-clamp-1 text-sm text-text-secondary">{meta}</p>}
      </div>
    </Link>
  );
}
