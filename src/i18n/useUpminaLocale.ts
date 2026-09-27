import { createContext, useContext } from "react";
import type { Locale } from "./locale-core";

// Contexto + hook de CosplayLocaleProvider, en un archivo separado (no .tsx) a propósito: así
// LocaleProvider.tsx exporta SOLO el componente y React Fast Refresh sigue funcionando en
// desarrollo (regla react-refresh/only-export-components).

export interface LocaleContextValue {
  locale: Locale;
  /** true mientras se cargan los mensajes de un idioma recién elegido (en/de la primera vez). */
  isChangingLocale: boolean;
  setLocale: (locale: Locale) => void;
}

export const LocaleContext = createContext<LocaleContextValue | null>(null);

export function useUpminaLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error("useUpminaLocale debe usarse dentro de <CosplayLocaleProvider>");
  }
  return ctx;
}

/** Formatea una fecha SOLO-fecha (columna `date`, sin hora) con el idioma activo, en UTC. Evitar
 *  la zona horaria local es intencional: una fecha civil como "2026-03-01" no debe convertirse a
 *  "28 de febrero" para quien vive al oeste de UTC. */
export function formatDateOnly(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}
