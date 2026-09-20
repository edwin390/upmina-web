import { Link } from "react-router-dom";
import PlatformIcon, { type Platform } from "./PlatformIcon";
import SectionHeading from "./SectionHeading";

const DESTINATIONS: { platform: Platform; to: string; label: string; blurb: string }[] = [
  { platform: "twitch", to: "/twitch", label: "Twitch", blurb: "Directos, VODs y clips" },
  { platform: "youtube", to: "/youtube", label: "YouTube", blurb: "Videos y Shorts" },
  { platform: "instagram", to: "/instagram", label: "Instagram", blurb: "Posts y Reels" },
  { platform: "tiktok", to: "/tiktok", label: "TikTok", blurb: "Videos y momentos" },
  {
    platform: "comunidad",
    to: "/comunidad",
    label: "Comunidad",
    blurb: "Contenido de fans",
  },
];

// Solo enlaces: no consulta ninguna API (Instagram/TikTok siguen sin backend listo).
export default function ExploreSection() {
  return (
    <section aria-labelledby="explora" className="mx-auto max-w-6xl px-4 py-10">
      <SectionHeading id="explora" title="EXPLORA UPMINA" />
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:gap-4">
        {DESTINATIONS.map((item) => (
          <li key={item.to} className="sm:max-lg:last:col-span-2">
            <Link
              to={item.to}
              className="group flex min-h-16 items-center gap-4 rounded-lg border border-border-subtle bg-bg-surface p-4 transition-[transform,box-shadow,border-color] duration-350 ease-bounce hover:-translate-y-1 hover:border-accent-primary/70 hover:shadow-glow-primary focus-visible:-translate-y-1 focus-visible:border-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary lg:h-full lg:flex-col lg:items-start lg:gap-5 lg:p-5"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent-primary/10 text-accent-primary transition-colors duration-200 group-hover:bg-accent-primary group-hover:text-text-inverse">
                <PlatformIcon platform={item.platform} className="h-6 w-6" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-display text-2xl leading-none tracking-wide text-text-primary">
                  {item.label}
                </span>
                <span className="mt-1 block text-sm text-text-secondary">
                  {item.blurb}
                </span>
              </span>
              <span
                aria-hidden="true"
                className="text-sm font-semibold text-accent-primary transition-transform duration-200 group-hover:translate-x-1 lg:mt-auto"
              >
                Explorar →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
