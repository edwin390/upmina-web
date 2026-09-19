import { useEffect, useState } from "react";

const NAV_LINKS = [
  { href: "#twitch", label: "Twitch" },
  { href: "#youtube", label: "YouTube" },
  { href: "#instagram", label: "Instagram" },
  { href: "#tiktok", label: "TikTok" },
  { href: "#comunidad", label: "Comunidad" },
];

interface HeaderProps {
  onLogoDoubleClick: () => void;
}

export default function Header({ onLogoDoubleClick }: HeaderProps) {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 80);
    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-50 border-b transition-[background-color,box-shadow,border-color] duration-350 ease-smooth ${
        isScrolled
          ? "border-accent-primary/30 bg-bg-base/90 shadow-glow-primary backdrop-blur-xl"
          : "border-border-subtle/60 bg-bg-base/55 backdrop-blur-md"
      }`}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <a
          href="#"
          onDoubleClick={onLogoDoubleClick}
          title="Doble click para una sorpresa"
          className="font-display text-2xl tracking-wide text-text-primary transition-transform duration-200 ease-bounce hover:scale-105 hover:text-accent-primary"
        >
          UPMINAA
        </a>

        <nav className="hidden gap-6 md:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="group relative text-sm text-text-secondary transition-colors duration-200 ease-smooth hover:text-accent-primary"
            >
              {link.label}
              <span className="absolute -bottom-2 left-1/2 h-px w-0 -translate-x-1/2 bg-accent-primary transition-all duration-200 ease-bounce group-hover:w-full" />
            </a>
          ))}
        </nav>

        <a
          href="https://twitch.tv/upminaa"
          target="_blank"
          rel="noreferrer noopener"
          className="rounded-md bg-accent-primary px-4 py-2 text-sm font-semibold text-text-inverse shadow-glow-primary transition-transform duration-200 ease-bounce hover:scale-105 hover:bg-accent-secondary"
        >
          Ver en Twitch
        </a>
      </div>
    </header>
  );
}
