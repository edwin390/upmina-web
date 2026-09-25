import { parsePrivilegedIntent, type PrivilegedIntent } from "./privileged-intent";

// Destinos de retorno seguros (Fase 9G-2). ÚNICA fuente de verdad para decidir si un `returnTo`
// recibido (query string, estado de navegación, etc.) es un destino interno permitido. Sirve a
// los futuros flujos login → MFA → destino (9G-3/4), que hoy NO están conectados.
//
// Estrategia: NO se confía en `startsWith("/")` ni en el parser de URL del navegador. El valor se
// valida estructuralmente y, si pasa, se RECONSTRUYE a partir de piezas ya validadas: nunca se
// devuelve el texto original.
//   1. Solo ASCII imprimible sin espacios (0x21–0x7E), longitud acotada. Esto descarta caracteres
//      de control, espacios/tabs/saltos de línea al inicio, medio o final, y todo Unicode.
//   2. Sin `\` (los navegadores lo tratan como `/`), sin `%` (ningún destino permitido necesita
//      percent-encoding, así que cualquier codificación —`%2f`, `%5c`, `%69ntent`, `%` suelto— es
//      ambigua y falla cerrado) y sin `#` (un fragmento nunca es parte del destino).
//   3. Debe empezar por UN solo `/` (no `//`, no `///`); las URL absolutas y de esquema
//      (`https:`, `javascript:`, `data:`, `file:`) no empiezan por `/`.
//   4. El pathname debe coincidir EXACTAMENTE (sensible a mayúsculas, sin barra final, sin
//      segmentos `.`/`..`) con una ruta de la allowlist.
//   5. Query: por defecto una ruta NO admite parámetros. Solo puede admitir `intent`, y solo si la
//      ruta lo declara. Cualquier parámetro desconocido, duplicado, sin valor, con valor
//      inválido o una `?` vacía hace fallar TODO el destino (no se descarta en silencio).
//
// Es DATA pura: devolver un destino nunca navega ni ejecuta nada. Quien lo use debe navegar con
// el router interno de la SPA (navigate), nunca con window.location.

export interface ReturnRoute {
  /** ¿Admite `?intent=<create|edit|delete>`? Por defecto false: ninguna ruta admite parámetros. */
  readonly allowsIntent: boolean;
}

export type ReturnRoutes = Readonly<Record<string, ReturnRoute>>;

/**
 * Allowlist de PRODUCCIÓN. /cosplay se añadirá cuando esa ruta exista (fase posterior). Congelada
 * (tabla y entradas): ningún módulo puede ampliarla en tiempo de ejecución.
 */
export const RETURN_ROUTES: ReturnRoutes = Object.freeze({
  "/admin": Object.freeze({ allowsIntent: false }),
  "/admin/activate": Object.freeze({ allowsIntent: false }),
  "/account": Object.freeze({ allowsIntent: false }),
  "/comunidad": Object.freeze({ allowsIntent: false }),
});

export interface SafeReturnTo {
  /** Pathname de la allowlist, tal como está en la tabla (nunca el texto original). */
  readonly pathname: string;
  /** Intención transportada, o null si el destino no lleva `intent`. Solo DATOS. */
  readonly intent: PrivilegedIntent | null;
  /** Destino reconstruido, listo para `navigate()`: `pathname` o `pathname?intent=<valor>`. */
  readonly path: string;
}

const MAX_LENGTH = 256;
/** Solo ASCII imprimible visible: excluye controles, espacio (0x20), DEL y todo lo no ASCII. */
const SAFE_CHARS = /^[\x21-\x7e]+$/;

function findRoute(routes: ReturnRoutes, pathname: string): ReturnRoute | null {
  return Object.prototype.hasOwnProperty.call(routes, pathname) ? routes[pathname] : null;
}

/**
 * API PÚBLICA: destino interno permitido, o null. Fail closed ante cualquier ambigüedad. Usa
 * SIEMPRE la allowlist de producción (RETURN_ROUTES); no acepta una tabla de rutas.
 */
export function parseSafeReturnTo(raw: unknown): SafeReturnTo | null {
  return parseSafeReturnToWithRoutes(raw, RETURN_ROUTES);
}

/**
 * Misma validación con una tabla de rutas explícita. SOLO PARA PRUEBAS (probar `intent` con rutas
 * fixture sin crear rutas reales): el código de producción debe usar parseSafeReturnTo. La tabla
 * nunca debe construirse a partir de datos no confiables.
 */
export function parseSafeReturnToWithRoutes(
  raw: unknown,
  routes: ReturnRoutes,
): SafeReturnTo | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_LENGTH) return null;
  if (!SAFE_CHARS.test(raw)) return null;
  if (raw.includes("\\") || raw.includes("%") || raw.includes("#")) return null;

  // Exactamente un "/" inicial: rechaza "//host", "///host" y "/\host" (la "\" ya se rechazó).
  if (raw[0] !== "/" || raw[1] === "/") return null;

  const queryStart = raw.indexOf("?");
  const pathname = queryStart === -1 ? raw : raw.slice(0, queryStart);
  const queryString = queryStart === -1 ? null : raw.slice(queryStart + 1);

  const route = findRoute(routes, pathname);
  if (!route) return null;

  if (queryString === null) {
    return { pathname, intent: null, path: pathname };
  }

  // Cualquier query exige una ruta que admita `intent`; una "?" vacía es ambigua.
  if (!route.allowsIntent || queryString.length === 0) return null;

  let intent: PrivilegedIntent | null = null;
  for (const pair of queryString.split("&")) {
    const parts = pair.split("=");
    if (parts.length !== 2) return null; // sin "=", o con más de un "="
    const [name, value] = parts;
    if (name !== "intent") return null; // parámetro desconocido
    if (intent !== null) return null; // intent duplicado
    const parsed = parsePrivilegedIntent(value);
    if (parsed === null) return null;
    intent = parsed;
  }
  if (intent === null) return null;

  return { pathname, intent, path: `${pathname}?intent=${intent}` };
}
