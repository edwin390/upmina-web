import clsx from "clsx";
import { useTranslations } from "use-intl";
import { SUPPORTED_LOCALES } from "@/i18n/locale";
import { useOptionalLocale } from "@/i18n/useUpminaLocale";

// Selector de idioma compacto (ES · EN · DE). Cambia el idioma de TODA la interfaz (proveedor único de la raíz), se
// conserva entre visitas (localStorage) y no recarga ni toca la sesión. Sin proveedor (pruebas de componentes sueltos) no
// se pinta. Accesible: grupo con etiqueta, botones con nombre completo del idioma y aria-pressed.
export default function LanguageSwitcher({ className }: { className?: string }) {
  const ctx = useOptionalLocale();
  const t = useTranslations("site.header.language");
  if (!ctx) return null;
  return (
    <div
      role="group"
      aria-label={t("label")}
      className={clsx(
        "inline-flex items-center rounded-md border border-border-subtle p-0.5",
        className,
      )}
    >
      {SUPPORTED_LOCALES.map((code) => {
        const active = ctx.locale === code;
        return (
          <button
            key={code}
            type="button"
            lang={code}
            aria-pressed={active}
            aria-label={t(code)}
            title={t(code)}
            onClick={() => ctx.setLocale(code)}
            className={clsx(
              "min-h-8 min-w-8 rounded px-2 text-xs font-semibold uppercase tracking-wider transition-colors duration-200 ease-smooth focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary",
              active
                ? "bg-accent-primary/15 text-accent-primary shadow-[inset_0_0_0_1px_rgba(255,45,149,0.45)]"
                : "text-text-secondary hover:text-text-primary",
            )}
          >
            {code}
          </button>
        );
      })}
    </div>
  );
}
