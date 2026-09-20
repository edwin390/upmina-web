import { useEffect, type ReactNode } from "react";

export const CONTACT_EMAIL = "er179822@gmail.com";
export const EFFECTIVE_DATE = "September 20, 2026";

interface LegalLayoutProps {
  title: string;
  children: ReactNode;
}

/** Contenedor común de las páginas legales: título, fecha, aviso de independencia y contenido. */
export default function LegalLayout({ title, children }: LegalLayoutProps) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${title} — UPMINAA Fan Site`;
    return () => {
      document.title = previousTitle;
    };
  }, [title]);

  return (
    <article className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="font-display text-4xl tracking-wide text-text-primary md:text-5xl">
        {title}
      </h1>
      <div
        className="mt-2 h-0.5 w-12 rounded-full bg-gradient-accent"
        aria-hidden="true"
      />
      <p className="mt-4 text-sm text-text-muted">Effective date: {EFFECTIVE_DATE}</p>

      <p
        role="note"
        className="mt-6 rounded-lg border border-accent-primary/30 bg-accent-primary/5 p-4 text-sm leading-relaxed text-text-secondary"
      >
        <strong className="text-text-primary">Independent fan website.</strong> Upmina Web
        is an independent fan project. It is not officially affiliated with, endorsed by,
        or sponsored by UpMinaa, TikTok, Twitch, YouTube, Instagram, or any other platform
        it displays.
      </p>

      <div className="mt-10 space-y-10">{children}</div>

      <p className="mt-12 border-t border-border-subtle pt-6 text-sm text-text-secondary">
        Contact:{" "}
        <a
          href={`mailto:${CONTACT_EMAIL}`}
          className="font-medium text-accent-primary hover:underline"
        >
          {CONTACT_EMAIL}
        </a>
      </p>
    </article>
  );
}

interface LegalSectionProps {
  title: string;
  children: ReactNode;
}

export function LegalSection({ title, children }: LegalSectionProps) {
  return (
    <section className="space-y-3 leading-relaxed text-text-secondary">
      <h2 className="text-xl font-semibold text-text-primary">{title}</h2>
      {children}
    </section>
  );
}

export function LegalList({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5">{children}</ul>;
}

export function ContactLink() {
  return (
    <a
      href={`mailto:${CONTACT_EMAIL}`}
      className="font-medium text-accent-primary hover:underline"
    >
      {CONTACT_EMAIL}
    </a>
  );
}
