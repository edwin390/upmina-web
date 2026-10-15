import { Link } from "react-router-dom";
import { useTranslations } from "use-intl";
import ExploreSection from "@/components/home/ExploreSection";
import NowSection from "@/components/home/NowSection";
import LatestContentSection from "@/components/home/LatestContentSection";
import CommunityCta from "@/components/home/CommunityCta";

// Inicio = portada/hub: hero + previews ligeras. Las secciones completas de cada red
// viven en su propia ruta (ver App.tsx) y no se montan aquí.
export default function HomePage() {
  const t = useTranslations("site.home");
  return (
    <>
      <section className="relative mx-auto flex min-h-[min(480px,65vh)] max-w-6xl flex-col items-center justify-center overflow-hidden px-4 py-16 text-center">
        <div className="hero-kicker mb-5 inline-flex items-center gap-2 rounded-full border border-accent-primary/30 bg-accent-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.28em] text-accent-primary">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-pink" />
          {t("badge")}
        </div>
        <h1 className="hero-title hero-logo w-[min(86vw,30rem)] md:w-[min(60vw,38rem)]">
          <img
            src="/images/upminaa-logo-1280.webp"
            srcSet="/images/upminaa-logo-640.webp 640w, /images/upminaa-logo-1280.webp 1280w"
            sizes="(min-width: 768px) 608px, 86vw"
            width={1280}
            height={489}
            alt="UPMINAA"
            fetchPriority="high"
            decoding="async"
          />
        </h1>
        <p className="hero-subtitle mx-auto mt-5 max-w-xl text-lg text-text-secondary">
          {t("subtitle")}
        </p>
        <div className="hero-subtitle mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/youtube"
            className="inline-flex min-h-12 items-center rounded-md border border-accent-primary/60 bg-accent-primary px-6 py-3 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base"
          >
            {t("seeContent")}
          </Link>
          <Link
            to="/twitch"
            className="inline-flex min-h-12 items-center rounded-md border border-accent-primary/60 px-6 py-3 text-sm font-bold uppercase tracking-[0.18em] text-accent-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:border-accent-secondary hover:text-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base"
          >
            Twitch
          </Link>
        </div>
        <span className="hero-scroll-hint mt-10 text-xs font-semibold tracking-[0.4em] text-text-muted">
          {t("scrollHint")}
        </span>
      </section>

      <ExploreSection />
      <NowSection />
      <LatestContentSection />
      <CommunityCta />
    </>
  );
}
