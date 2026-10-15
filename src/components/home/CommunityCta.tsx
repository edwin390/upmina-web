import { Link } from "react-router-dom";
import { useTranslations } from "use-intl";

// CTA estático: no consulta Supabase ni muestra contenido de usuarios.
export default function CommunityCta() {
  const t = useTranslations("site.cta");
  return (
    <section
      aria-labelledby="hecho-por-la-comunidad"
      className="mx-auto max-w-6xl px-4 pb-16 pt-10"
    >
      <div className="relative overflow-hidden rounded-xl border border-accent-primary/40 bg-bg-surface px-6 py-12 text-center sm:py-16">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgb(var(--c-accent-primary)/0.18),transparent_65%),radial-gradient(ellipse_at_bottom_right,rgb(var(--c-accent-pink)/0.12),transparent_60%)]"
          aria-hidden="true"
        />
        <div className="relative">
          <h2
            id="hecho-por-la-comunidad"
            className="font-display text-4xl tracking-wide text-text-primary md:text-6xl"
          >
            {t.rich("title", {
              heart: (chunks) => <span className="text-accent-pink">{chunks}</span>,
            })}
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-text-secondary">{t("text")}</p>
          <Link
            to="/community"
            className="mt-8 inline-flex min-h-12 items-center rounded-md border border-accent-primary/60 bg-accent-primary px-6 py-3 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface"
          >
            {t("button")}
          </Link>
        </div>
      </div>
    </section>
  );
}
