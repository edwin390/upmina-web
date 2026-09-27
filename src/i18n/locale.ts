// Resolución e idioma activo (Fase 9I-1), SOLO NAVEGADOR (usa localStorage/navigator). El tipo
// `Locale` y las constantes viven en locale-core.ts (sin DOM) para que el código de servidor
// (src/lib/cosplay-domain.ts) pueda importar el tipo sin arrastrar esta parte.
//
// Orden de resolución (congelado):
//   1. preferencia explícita persistida (localStorage);
//   2. idioma del navegador, si es uno de los soportados;
//   3. español (idioma de reserva final).
// Un idioma de navegador no soportado (p. ej. "fr") cae directamente en español: nunca se
// negocia un idioma "parecido" ni se adivina.
//
// Sin prefijo de idioma en la URL (decisión congelada de 9I): el idioma vive en localStorage,
// no en la ruta. El idioma es una preferencia de PRESENTACIÓN, nunca de autorización — no tiene
// relación alguna con admin-access.ts.

export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  type Locale,
} from "./locale-core";
import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from "./locale-core";

const STORAGE_KEY = "upmina:locale";

/** Preferencia explícita ya guardada, o `null` si no hay ninguna o localStorage no está
 *  disponible (navegación privada, storage bloqueado, SSR futuro). Nunca lanza. */
export function getPersistedLocale(): Locale | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isSupportedLocale(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Guarda la preferencia explícita. Es solo una comodidad del navegador: si falla (storage
 *  lleno/bloqueado) el idioma activo de esta sesión no cambia, así que se ignora en silencio. */
export function persistLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Solo comodidad: un fallo aquí no debe romper el cambio de idioma en memoria.
  }
}

/** El primer idioma soportado entre los que declara el navegador, o `null` si ninguno lo es.
 *  Usa `navigator.languages` (orden de preferencia real del usuario) con `navigator.language`
 *  como respaldo para entornos que no exponen la lista. */
function detectBrowserLocale(): Locale | null {
  const candidates =
    typeof navigator !== "undefined"
      ? navigator.languages?.length
        ? navigator.languages
        : [navigator.language]
      : [];
  for (const raw of candidates) {
    if (!raw) continue;
    // "en-US" → "en": solo se compara el subtag primario de idioma.
    const primary = raw.split("-")[0]?.toLowerCase();
    if (isSupportedLocale(primary)) return primary;
  }
  return null;
}

/** Idioma activo al arrancar: persistida → navegador → español. Pura, sin efectos. */
export function resolveInitialLocale(): Locale {
  return getPersistedLocale() ?? detectBrowserLocale() ?? DEFAULT_LOCALE;
}
