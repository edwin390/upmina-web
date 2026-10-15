import clsx from "clsx";
import { useTranslations } from "use-intl";
import { THEME_PREFERENCES, resolveTheme, useThemePreference } from "@/theme/theme";
import { useDropdown } from "./useDropdown";
import { ITEM, ITEM_ACTIVE, MENU, TRIGGER } from "./menuStyles";

// Selector de apariencia: botón compacto con sol / luna / monitor (según la preferencia) y menú Claro · Oscuro · Sistema.
const ICON = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function Icon({ kind }: { kind: "light" | "dark" | "system" }) {
  if (kind === "light")
    return (
      <svg {...ICON}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  if (kind === "dark")
    return (
      <svg {...ICON}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    );
  return (
    <svg {...ICON}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

export default function ThemeSwitcher({ className }: { className?: string }) {
  const t = useTranslations("site.header.theme");
  const [pref, setPref] = useThemePreference();
  const { open, setOpen, close, rootRef, buttonRef, onKeyDown } = useDropdown();
  return (
    <div ref={rootRef} onKeyDown={onKeyDown} className={clsx("relative", className)}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t("label")}: ${t(pref)}`}
        title={t("label")}
        onClick={() => setOpen((v) => !v)}
        className={clsx(TRIGGER, "px-2")}
      >
        <Icon kind={pref === "system" ? "system" : resolveTheme(pref)} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t("label")}
          className={clsx(MENU, "md:left-auto md:right-0")}
        >
          {THEME_PREFERENCES.map((value) => {
            const active = pref === value;
            return (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  setPref(value);
                  close(true);
                }}
                className={clsx(ITEM, active && ITEM_ACTIVE)}
              >
                <span className="inline-flex items-center gap-2">
                  <Icon kind={value} />
                  {t(value)}
                </span>
                {active && <span aria-hidden="true">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
