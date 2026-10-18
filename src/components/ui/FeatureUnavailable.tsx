import { Link } from "react-router-dom";
import { useTranslations } from "use-intl";

// Estado neutral para una sección desactivada en el modo restringido (Instagram, TikTok, Cosplays). Sin datos ni llamadas a APIs.
export default function FeatureUnavailable() {
  const t = useTranslations("site.featureUnavailable");
  return (
    <section
      className="mx-auto max-w-2xl px-4 py-24 text-center"
      aria-labelledby="feature-unavailable-title"
    >
      <h1
        id="feature-unavailable-title"
        className="font-display text-3xl text-text-primary"
      >
        {t("title")}
      </h1>
      <p role="status" className="mt-3 text-text-secondary">
        {t("body")}
      </p>
      <Link
        to="/"
        className="mt-6 inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2 text-sm font-semibold text-text-secondary hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
      >
        {t("home")}
      </Link>
    </section>
  );
}
