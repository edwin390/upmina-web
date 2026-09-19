import { lazy, Suspense } from "react";
import TwitchSection from "@/components/twitch/TwitchSection";
import DeferredSection from "@/components/ui/DeferredSection";

const YouTubeSection = lazy(() => import("@/components/youtube/YouTubeSection"));
const InstagramSection = lazy(() => import("@/components/instagram/InstagramSection"));
const TikTokSection = lazy(() => import("@/components/tiktok/TikTokSection"));
const CommunitySection = lazy(() => import("@/components/community/CommunitySection"));

function DeferredFallback() {
  return (
    <div className="mx-auto min-h-[420px] max-w-6xl px-4 py-16" aria-hidden="true" />
  );
}

export default function HomePage() {
  return (
    <>
      <section className="relative mx-auto flex min-h-[min(560px,70vh)] max-w-6xl flex-col items-center justify-center overflow-hidden px-4 py-20 text-center">
        <div className="hero-kicker mb-5 inline-flex items-center gap-2 rounded-full border border-accent-primary/30 bg-accent-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.28em] text-accent-primary">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-primary" />
          live energy · fansite
        </div>
        <h1
          aria-label="UPMINAA"
          className="hero-title font-display text-6xl tracking-wide text-text-primary md:text-8xl"
        >
          <span className="hero-letter">U</span>
          <span className="hero-letter">P</span>
          <span className="hero-letter">M</span>
          <span className="hero-letter">I</span>
          <span className="hero-letter">N</span>
          <span className="hero-letter">A</span>
          <span className="hero-letter">A</span>
        </h1>
        <p className="hero-subtitle mx-auto mt-5 max-w-xl text-lg text-text-secondary">
          Directos, contenido y comunidad — todo en un solo lugar.
        </p>
        <a
          href="#twitch"
          className="mt-8 rounded-md border border-accent-primary/60 bg-accent-primary px-6 py-3 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary"
        >
          Entrar al stream
        </a>
        <span className="hero-scroll-hint mt-12 text-xs font-semibold tracking-[0.4em] text-text-muted">
          SCROLL ↓
        </span>
      </section>

      <TwitchSection />
      <Suspense fallback={<DeferredFallback />}>
        <DeferredSection id="youtube">
          <YouTubeSection />
        </DeferredSection>
        <DeferredSection id="instagram">
          <InstagramSection />
        </DeferredSection>
        <DeferredSection id="tiktok">
          <TikTokSection />
        </DeferredSection>
        <DeferredSection id="comunidad">
          <CommunitySection />
        </DeferredSection>
      </Suspense>
    </>
  );
}
