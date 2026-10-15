import { Link } from "react-router-dom";
import { useTranslations } from "use-intl";
import PlatformIcon, { type Platform } from "./PlatformIcon";
import SectionHeading from "./SectionHeading";

// Mismo orden que la navegación: Twitch, YouTube, Instagram, TikTok, Cosplays, Comunidad.
const DESTINATIONS: { platform: Platform; to: string; label?: string; key: string }[] = [
  { platform: "twitch", to: "/twitch", label: "Twitch", key: "twitch" },
  { platform: "youtube", to: "/youtube", label: "YouTube", key: "youtube" },
  { platform: "instagram", to: "/instagram", label: "Instagram", key: "instagram" },
  { platform: "tiktok", to: "/tiktok", label: "TikTok", key: "tiktok" },
  { platform: "cosplay", to: "/cosplay", key: "cosplay" },
  { platform: "comunidad", to: "/community", key: "community" },
];

// Solo enlaces: no consulta ninguna API (Instagram/TikTok siguen sin backend listo).
export default function ExploreSection() {
  const t = useTranslations("site.explore");
  return (
    <section aria-labelledby="explora" className="mx-auto max-w-6xl px-4 py-10">
      <SectionHeading id="explora" title={t("title")} />
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 lg:gap-4">
        {DESTINATIONS.map((item) => (
          <li key={item.to}>
            <Link
              to={item.to}
              className="group flex min-h-16 items-center gap-4 rounded-lg border border-border-subtle bg-bg-surface p-4 transition-[transform,box-shadow,border-color] duration-350 ease-bounce hover:-translate-y-1 hover:border-accent-primary/70 hover:shadow-glow-primary focus-visible:-translate-y-1 focus-visible:border-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary lg:h-full lg:flex-col lg:items-start lg:gap-5 lg:p-5"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent-primary/10 text-accent-primary transition-colors duration-200 group-hover:bg-accent-primary group-hover:text-text-inverse">
                <PlatformIcon platform={item.platform} className="h-6 w-6" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-display text-2xl leading-none tracking-wide text-text-primary">
                  {item.label ??
                    t(item.key === "cosplay" ? "cosplayLabel" : "communityLabel")}
                </span>
                <span className="mt-1 block text-sm text-text-secondary">
                  {t(item.key as "twitch")}
                </span>
              </span>
              <span
                aria-hidden="true"
                className="text-sm font-semibold text-accent-primary transition-transform duration-200 group-hover:translate-x-1 lg:mt-auto"
              >
                {t("go")}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
