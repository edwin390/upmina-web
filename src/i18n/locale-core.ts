// Constantes y tipo de idioma SIN dependencias del navegador (sin `window`/`navigator`/
// `document`). Separado de locale.ts a propósito: src/lib/cosplay-domain.ts es código de
// servidor (lo importa api/content/[resource].ts) y se compila bajo tsconfig.node.json, que no
// incluye la lib DOM — importar el `locale.ts` completo (con localStorage/navigator) rompería
// esa compilación aunque solo se usara el tipo `Locale`. Este archivo es lo único que el
// servidor necesita; locale.ts lo reexporta para que el navegador siga teniendo una sola fuente.

export const SUPPORTED_LOCALES = ["es", "en", "de"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "es";

export function isSupportedLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}
