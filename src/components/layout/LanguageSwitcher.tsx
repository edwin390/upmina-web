import clsx from "clsx";
import { useTranslations } from "use-intl";
import { SUPPORTED_LOCALES, type Locale } from "@/i18n/locale";
import { useOptionalLocale } from "@/i18n/useUpminaLocale";
import { useDropdown } from "./useDropdown";
import { ITEM, ITEM_ACTIVE, MENU, TRIGGER } from "./menuStyles";

// Selector de idioma desplegable: globo + código activo + flecha. Orden del menú: English, Deutsch, Español.
// Cambia el idioma de TODA la interfaz (proveedor único de la raíz), se conserva entre visitas y no recarga ni toca la
// sesión. Sin proveedor (pruebas de componentes sueltos) no se pinta.
const ORDER: readonly Locale[] = ["en", "de", "es"];

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

export default function LanguageSwitcher({ className }: { className?: string }) {
  const ctx = useOptionalLocale();
  const t = useTranslations("site.header.language");
  const { open, setOpen, close, rootRef, buttonRef, onKeyDown } = useDropdown();
  if (!ctx) return null;
  const order = ORDER.filter((code) => SUPPORTED_LOCALES.includes(code));
  return (
    <div ref={rootRef} onKeyDown={onKeyDown} className={clsx("relative", className)}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t("label")}: ${t(ctx.locale)}`}
        onClick={() => setOpen((v) => !v)}
        className={TRIGGER}
      >
        <svg {...ICON}>
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
        </svg>
        <span className="uppercase tracking-wider">{ctx.locale}</span>
        <svg {...ICON} width={12} height={12} strokeWidth={2.5}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div role="menu" aria-label={t("label")} className={MENU}>
          {order.map((code) => {
            const active = ctx.locale === code;
            return (
              <button
                key={code}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                lang={code}
                onClick={() => {
                  ctx.setLocale(code);
                  close(true);
                }}
                className={clsx(ITEM, active && ITEM_ACTIVE)}
              >
                <span>{t(code)}</span>
                {active && <span aria-hidden="true">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
