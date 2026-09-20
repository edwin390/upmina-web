import type { ReactNode } from "react";

export type Platform = "twitch" | "youtube" | "instagram" | "tiktok" | "comunidad";

// Glifos simples propios (24x24, trazo currentColor): evitan una librería de iconos
// para cinco figuras.
const GLYPHS: Record<Platform, ReactNode> = {
  twitch: (
    <>
      <path d="M4 3h17v11l-4 4h-4l-3 3v-3H4z" />
      <path d="M11 7v4M16 7v4" />
    </>
  ),
  youtube: (
    <>
      <rect x="2.5" y="5.5" width="19" height="13" rx="4" />
      <path d="M10 9.5v5l4.5-2.5z" fill="currentColor" />
    </>
  ),
  instagram: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17" cy="7" r="0.6" fill="currentColor" />
    </>
  ),
  tiktok: (
    <>
      <path d="M14 4v10.5a3.5 3.5 0 1 1-3.5-3.5" />
      <path d="M14 4c0 2.2 1.8 4 4 4" />
    </>
  ),
  comunidad: (
    <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
  ),
};

export default function PlatformIcon({
  platform,
  className,
}: {
  platform: Platform;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {GLYPHS[platform]}
    </svg>
  );
}
