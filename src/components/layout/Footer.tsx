const SOCIAL_LINKS = [
  { href: "https://twitch.tv/upminaa", label: "Twitch" },
  { href: "https://www.youtube.com/@upminaa", label: "YouTube" },
  { href: "https://www.instagram.com/upminaa/?hl=es", label: "Instagram" },
  { href: "https://www.tiktok.com/@upminaa.cos?lang=es", label: "TikTok" },
  { href: "https://www.reddit.com/user/upminaa/", label: "Reddit" },
];

export default function Footer() {
  return (
    <footer className="relative overflow-hidden border-t border-accent-primary/20 bg-bg-surface/90 py-14">
      <div
        className="absolute inset-x-0 bottom-0 h-48 bg-[radial-gradient(ellipse_at_bottom,rgba(255,45,149,0.2),transparent_70%)]"
        aria-hidden="true"
      />
      <div className="relative mx-auto flex max-w-6xl flex-col gap-6 px-4 text-sm text-text-secondary">
        <p className="font-display text-6xl leading-none tracking-wide text-transparent [text-shadow:0_0_28px_rgba(255,45,149,0.25)] [-webkit-text-stroke:1px_rgba(255,45,149,0.55)] transition-colors duration-350 ease-smooth hover:text-accent-primary">
          UPMINAA
        </p>

        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {SOCIAL_LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noreferrer noopener"
              className="transition-colors duration-200 ease-smooth hover:text-accent-secondary"
            >
              {link.label}
            </a>
          ))}
        </div>

        <p className="max-w-2xl text-text-muted">
          UPMINA Web es un proyecto no oficial creado por fans. No está afiliado,
          patrocinado ni respaldado por UPMINA ni por su management. Consulta el{" "}
          <a href="/docs/LEGAL.md" className="underline hover:text-accent-primary">
            aviso legal
          </a>
          .
        </p>

        <p className="text-text-muted">
          &copy; {new Date().getFullYear()} UPMINA Web · Hecho con{" "}
          <span className="text-accent-primary">♥</span> por fans · Distribuido bajo
          licencia MIT.
        </p>
      </div>
    </footer>
  );
}
