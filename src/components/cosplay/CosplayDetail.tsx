import { Link } from "react-router-dom";
import { useTranslations } from "use-intl";
import { useCosplayPost } from "@/hooks/useCosplayPost";
import { useUpminaLocale } from "@/i18n/useUpminaLocale";
import type { Locale } from "@/i18n/locale-core";
import CosplayPostMediaViewer from "./CosplayPostMediaViewer";

// Detalle de UNA publicación de Cosplay (Fase "COSPLAY DETAIL REDESIGN"): inspirado visualmente
// en el detalle de Community (PostDetailPage.tsx) — contenedor angosto centrado, tarjeta única,
// media siempre visible sin un paso adicional de "abrir". Sigue siendo Cosplay: sin likes, sin
// lógica de Community, sin compartir datos entre ambas superficies. El feed de Cosplay
// (CosplaySection/CosplayCard/CosplayHero) NO cambia — este componente es exclusivamente lo que
// se ve DESPUÉS de entrar en una publicación.
//
// Ya NO se pide Evento ni Fecha manual (shotOn) al crear/editar — ver useCosplayEditor.ts — así
// que tampoco se muestran aquí. La fecha visible es la automática de publicación (publishedAt,
// columna published_at: se fija la primera vez que se publica y nunca se reescribe al editar).

/** Igual que formatDateOnly (useUpminaLocale.ts) pero para un timestamp REAL (publishedAt tiene
 *  hora, no es una fecha civil sin huso) — por eso NO reutiliza el mismo helper: ese fija UTC a
 *  propósito para columnas `date`, lo que aquí correría el día en cualquier huso al oeste de UTC. */
function formatPublishedAt(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date(iso));
}

interface MetaRowProps {
  label: string;
  value: string | null;
}

function MetaRow({ label, value }: MetaRowProps) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="truncate text-text-secondary">{value}</dd>
    </div>
  );
}

export default function CosplayDetail({ slug }: { slug: string | undefined }) {
  const { locale } = useUpminaLocale();
  const t = useTranslations("cosplay.detail");
  const { data: post, isLoading, isError, refetch } = useCosplayPost(slug);
  // `post` es `undefined` mientras la query sigue deshabilitada (sin slug) y `null` en un 404
  // explícito del servidor — ambos casos se tratan igual, nunca como una carga infinita.
  const notFound = !isLoading && !isError && !post;

  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <Link
        to="/cosplay"
        className="mb-6 inline-block text-sm font-medium text-accent-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
      >
        {t("backLink")}
      </Link>

      {/* Sin slug (no debería ocurrir: la ruta es /cosplay/:slug), la query ni siquiera se
          dispara (useCosplayPost la deja "enabled: false") — se trata igual que "no encontrado",
          nunca como una carga infinita. */}
      {isLoading && slug ? (
        <p role="status" className="text-text-secondary" aria-live="polite">
          {t("loading")}
        </p>
      ) : null}

      {isError ? (
        <div
          role="alert"
          className="rounded-lg border border-border-subtle bg-bg-surface px-6 py-10 text-center"
        >
          <p className="text-text-secondary">{t("error")}</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="mt-4 inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold text-text-inverse transition hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
          >
            {t("retry")}
          </button>
        </div>
      ) : null}

      {notFound ? (
        <div className="rounded-lg border border-border-subtle bg-bg-surface px-6 py-16 text-center">
          <p className="font-display text-lg tracking-wide text-text-primary">
            {t("notFound.title")}
          </p>
          <p className="mt-2 text-text-secondary">{t("notFound.body")}</p>
          <Link
            to="/cosplay"
            className="mt-4 inline-flex min-h-11 items-center justify-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors hover:border-accent-primary/70 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
          >
            {t("notFound.back")}
          </Link>
        </div>
      ) : null}

      {post ? (
        <article className="rounded-lg border border-border-subtle bg-bg-surface p-6">
          <div className="flex items-start justify-between gap-3">
            <h1 className="min-w-0 font-display text-2xl tracking-wide text-text-primary sm:text-3xl">
              {post.title}
            </h1>
            <time
              dateTime={post.publishedAt}
              className="shrink-0 text-xs text-text-secondary"
            >
              {formatPublishedAt(post.publishedAt, locale)}
            </time>
          </div>

          {post.description ? (
            <p className="mt-4 whitespace-pre-line break-words text-base text-text-primary">
              {post.description}
            </p>
          ) : null}

          {(post.characterName || post.series || post.photographerCredit) && (
            <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-border-subtle pt-4 sm:grid-cols-3">
              <MetaRow label={t("character")} value={post.characterName} />
              <MetaRow label={t("series")} value={post.series} />
              <MetaRow label={t("photographerCredit")} value={post.photographerCredit} />
            </dl>
          )}

          <h2 className="sr-only">{t("galleryLabel")}</h2>
          <CosplayPostMediaViewer gallery={post.gallery} />
        </article>
      ) : null}
    </div>
  );
}
