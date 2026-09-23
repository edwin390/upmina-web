import { useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import clsx from "clsx";
import { useAuth } from "@/lib/auth-context";

const NAV_LINKS = [
  { to: "/", label: "Inicio" },
  { to: "/twitch", label: "Twitch" },
  { to: "/youtube", label: "YouTube" },
  { to: "/instagram", label: "Instagram" },
  { to: "/tiktok", label: "TikTok" },
  { to: "/comunidad", label: "Comunidad" },
];

// Estado de sesión en la navegación (Bloque 6B). Solo conoce session == null o != null
// del AuthProvider global: no distingue USER/MODERATOR/ADMIN, no muestra datos de la
// cuenta y no es autorización de nada (eso es server-side, ver /api/admin/me). Mientras
// loading=true reserva el espacio sin mostrar ninguna etiqueta, para no parpadear
// "Iniciar sesión" -> "Cuenta" ni desplazar el layout.
// Visitante (Bloque 6C): "Iniciar sesión" es un enlace SPA a /login. Autenticado:
// "Cuenta" es un <span> deliberadamente NO interactivo (sin button/link, sin foco, sin
// hover) hasta que exista una página de cuenta; no se inventan controles inertes.
function SessionAction({
  variant,
  onNavigate,
}: {
  variant: "desktop" | "mobile";
  onNavigate?: () => void;
}) {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <span
        aria-hidden="true"
        className={
          variant === "desktop" ? "hidden h-9 w-32 md:inline-block" : "block h-9"
        }
      />
    );
  }

  if (!session) {
    return (
      <Link
        to="/login"
        onClick={onNavigate}
        className={
          variant === "desktop"
            ? "hidden min-h-9 items-center rounded-md border border-border-subtle px-4 py-2 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary md:inline-flex"
            : "block rounded-md px-3 py-2 text-sm text-text-secondary transition-colors duration-200 ease-smooth hover:bg-bg-elevated hover:text-accent-primary"
        }
      >
        Iniciar sesión
      </Link>
    );
  }

  return (
    <span
      className={
        variant === "desktop"
          ? "hidden min-h-9 items-center rounded-md border border-border-subtle px-4 py-2 text-sm font-semibold text-text-secondary md:inline-flex"
          : "block rounded-md px-3 py-2 text-sm text-text-secondary"
      }
    >
      Cuenta
    </span>
  );
}

interface HeaderProps {
  onLogoDoubleClick: () => void;
}

export default function Header({ onLogoDoubleClick }: HeaderProps) {
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 80);
    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Si la ventana crece hasta el breakpoint de escritorio mientras el menú
  // móvil está abierto (p. ej. al rotar una tablet), ciérralo: el <nav>
  // de escritorio ya se muestra vía CSS y dejar ambos abiertos duplicaría
  // los enlaces.
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleResize = () => {
      if (window.innerWidth >= 768) setIsMenuOpen(false);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isMenuOpen]);

  const closeMenu = () => setIsMenuOpen(false);

  return (
    <header
      className={`sticky top-0 z-50 border-b transition-[background-color,box-shadow,border-color] duration-350 ease-smooth ${
        isScrolled
          ? "border-accent-primary/30 bg-bg-base/90 shadow-glow-primary backdrop-blur-xl"
          : "border-border-subtle/60 bg-bg-base/55 backdrop-blur-md"
      }`}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link
          to="/"
          onDoubleClick={onLogoDoubleClick}
          title="Doble click para una sorpresa"
          className="font-display text-2xl tracking-wide text-text-primary transition-transform duration-200 ease-bounce hover:scale-105 hover:text-accent-primary"
        >
          UPMINAA
        </Link>

        <nav className="hidden gap-6 md:flex">
          {NAV_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end
              className={({ isActive }) =>
                clsx(
                  "group relative text-sm transition-colors duration-200 ease-smooth hover:text-accent-primary",
                  isActive ? "font-semibold text-accent-primary" : "text-text-secondary",
                )
              }
            >
              {({ isActive }) => (
                <>
                  {link.label}
                  <span
                    className={clsx(
                      "absolute -bottom-2 left-1/2 h-px -translate-x-1/2 bg-accent-primary transition-all duration-200 ease-bounce group-hover:w-full",
                      isActive ? "w-full" : "w-0",
                    )}
                  />
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <SessionAction variant="desktop" />
          <a
            href="https://twitch.tv/upminaa"
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-md bg-accent-primary px-4 py-2 text-sm font-semibold text-text-inverse shadow-glow-primary transition-transform duration-200 ease-bounce hover:scale-105 hover:bg-accent-secondary"
          >
            Ver en Twitch
          </a>

          <button
            type="button"
            onClick={() => setIsMenuOpen((open) => !open)}
            aria-expanded={isMenuOpen}
            aria-controls="mobile-nav"
            aria-label={isMenuOpen ? "Cerrar menú" : "Abrir menú"}
            className="inline-flex h-9 w-9 flex-col items-center justify-center gap-1.5 rounded-md text-text-primary transition-colors duration-200 ease-smooth hover:text-accent-primary md:hidden"
          >
            <span
              className={clsx(
                "h-0.5 w-5 rounded-full bg-current transition-transform duration-200 ease-smooth",
                isMenuOpen && "translate-y-2 rotate-45",
              )}
            />
            <span
              className={clsx(
                "h-0.5 w-5 rounded-full bg-current transition-opacity duration-200 ease-smooth",
                isMenuOpen && "opacity-0",
              )}
            />
            <span
              className={clsx(
                "h-0.5 w-5 rounded-full bg-current transition-transform duration-200 ease-smooth",
                isMenuOpen && "-translate-y-2 -rotate-45",
              )}
            />
          </button>
        </div>
      </div>

      {isMenuOpen && (
        <nav
          id="mobile-nav"
          className="flex flex-col gap-1 border-t border-border-subtle/60 bg-bg-base/95 px-4 py-3 backdrop-blur-xl md:hidden"
        >
          {NAV_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end
              onClick={closeMenu}
              className={({ isActive }) =>
                clsx(
                  "rounded-md px-3 py-2 text-sm transition-colors duration-200 ease-smooth hover:bg-bg-elevated hover:text-accent-primary",
                  isActive
                    ? "bg-bg-elevated font-semibold text-accent-primary"
                    : "text-text-secondary",
                )
              }
            >
              {link.label}
            </NavLink>
          ))}
          <SessionAction variant="mobile" onNavigate={closeMenu} />
        </nav>
      )}
    </header>
  );
}
