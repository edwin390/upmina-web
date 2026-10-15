import { useCallback } from "react";
import { useTranslations } from "use-intl";
import { formatRelativeDate } from "@/lib/format";
import type { Locale } from "./locale-core";
import { useOptionalLocale } from "./useUpminaLocale";

// Formato dependiente del idioma activo (fechas relativas, números). Sin proveedor (pruebas de componentes sueltos) usa ES.
export function useLocaleCode(): Locale {
  return useOptionalLocale()?.locale ?? "es";
}

export function useRelativeDate(): (date: string | Date) => string {
  const locale = useLocaleCode();
  const t = useTranslations("common.format");
  const justNow = t("justNow");
  return useCallback(
    (date) => formatRelativeDate(date, locale, justNow),
    [locale, justNow],
  );
}

export function useLongDate(): (value: Date) => string {
  const locale = useLocaleCode();
  return useCallback(
    (value) => new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(value),
    [locale],
  );
}

export function useNumberFormat(): (value: number) => string {
  const locale = useLocaleCode();
  return useCallback((value) => value.toLocaleString(locale), [locale]);
}
