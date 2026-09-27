import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslations } from "use-intl";
import { useCosplayPost } from "@/hooks/useCosplayPost";
import { resolveEditorial, resolveRequiredEditorial } from "@/lib/cosplay-domain";
import { formatDateOnly, useUpminaLocale } from "@/i18n/useUpminaLocale";
import CosplayLightbox from "./CosplayLightbox";

interface MetaRowProps {
  label: string;
  value: string | null;
}

function MetaRow({ label, value }: MetaRowProps) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="text-text-secondary">{value}</dd>
    </div>
  );
}

export default function CosplayDetail({ slug }: { slug: string | undefined }) {
  const { locale } = useUpminaLocale();
  const t = useTranslations("cosplay.detail");
  const { data: post, isLoading, isError } = useCosplayPost(slug);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);

  // Sin slug (no debería ocurrir: la ruta es /cosplay/:slug), la query ni siquiera se dispara
  // (useCosplayPost la deja "enabled: false") — se trata igual que "no encontrado", nunca como
  // una carga infinita.
  if (isLoading && slug) {
    return (
      <section className="mx-auto max-w-4xl px-4 py-16">
        <p role="status" className="text-text-muted">
          {t("loading")}
        </p>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="mx-auto max-w-4xl px-4 py-16">
        <p role="status" className="text-text-muted">
          {t("error")}
        </p>
      </section>
    );
  }

  if (!post) {
    return (
      <section className="mx-auto max-w-4xl px-4 py-16 text-center">
        <p className="font-display text-xl tracking-wide text-text-primary">
          {t("notFound.title")}
        </p>
        <p className="mt-2 text-text-secondary">{t("notFound.body")}</p>
        <Link
          to="/cosplay"
          className="mt-6 inline-block rounded-md border border-border-subtle px-4 py-2 text-sm font-semibold text-text-secondary transition-colors hover:border-accent-primary/70 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
        >
          {t("notFound.back")}
        </Link>
      </section>
    );
  }

  const title = resolveRequiredEditorial(
    { es: post.titleEs, en: post.titleEn, de: post.titleDe },
    locale,
  );
  const description = resolveEditorial(
    { es: post.descriptionEs, en: post.descriptionEn, de: post.descriptionDe },
    locale,
  );

  return (
    <section className="mx-auto max-w-4xl px-4 py-16">
      <Link
        to="/cosplay"
        className="mb-6 inline-block text-sm font-medium text-accent-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
      >
        {t("backLink")}
      </Link>

      <h1
        {...(title.lang !== locale ? { lang: title.lang } : {})}
        className="font-display text-3xl tracking-wide text-text-primary sm:text-4xl"
      >
        {title.text}
      </h1>

      {description.text && (
        <p
          {...(description.lang !== locale ? { lang: description.lang } : {})}
          className="mt-4 whitespace-pre-line leading-relaxed text-text-secondary"
        >
          {description.text}
        </p>
      )}

      <dl className="mt-6 grid grid-cols-2 gap-4 border-y border-border-subtle py-4 sm:grid-cols-4">
        <MetaRow label={t("character")} value={post.characterName} />
        <MetaRow label={t("series")} value={post.series} />
        <MetaRow label={t("event")} value={post.event} />
        <MetaRow
          label={t("shotOn")}
          value={post.shotOn && formatDateOnly(post.shotOn, locale)}
        />
        <MetaRow label={t("photographerCredit")} value={post.photographerCredit} />
      </dl>

      <h2 className="sr-only">{t("galleryLabel")}</h2>
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {post.gallery.map((image, index) => {
          const alt = resolveEditorial(
            { es: image.altEs, en: image.altEn, de: image.altDe },
            locale,
          );
          return (
            <button
              key={image.id}
              type="button"
              onClick={(event) => {
                setTrigger(event.currentTarget);
                setOpenIndex(index);
              }}
              aria-haspopup="dialog"
              // El botón SIEMPRE necesita nombre accesible (abre el visor): "decorative" describe
              // el <img> en sí (alt=""), no el control que lo abre. Sin alt real, cae a un
              // genérico "Ver foto N" en vez de dejar el botón sin nombre (falla de accesibilidad
              // real, detectada al revisar el visor en localhost).
              aria-label={
                !image.decorative && alt.text
                  ? alt.text
                  : t("openPhoto", { position: index + 1 })
              }
              className="group aspect-square overflow-hidden rounded-md border border-transparent bg-bg-surface transition-[border-color,box-shadow] hover:border-accent-primary/70 hover:shadow-glow-primary focus-visible:border-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
            >
              <img
                src={image.url}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover transition-transform group-hover:scale-105"
              />
            </button>
          );
        })}
      </div>

      {openIndex !== null && (
        <CosplayLightbox
          images={post.gallery}
          index={openIndex}
          onNavigate={(delta) =>
            setOpenIndex((current) => {
              if (current === null) return current;
              const length = post.gallery.length;
              return (((current + delta) % length) + length) % length;
            })
          }
          onClose={() => setOpenIndex(null)}
          returnFocusTo={trigger}
        />
      )}
    </section>
  );
}
