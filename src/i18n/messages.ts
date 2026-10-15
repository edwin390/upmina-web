import { resolveInitialLocale, type Locale } from "./locale";

// Mensajes de la interfaz, repartidos en «espacios de nombres» (un JSON por idioma y espacio).
//
// RENDIMIENTO: sólo el núcleo (common + site: cabecera, Inicio, Twitch/YouTube/Instagram/TikTok/Cosplays
// públicos y formatos) viaja en el bundle inicial, y únicamente en español. Todo lo demás (auth, cuenta,
// Community, administración, Developer, moderación…) es un chunk perezoso por idioma y espacio de nombres
// que se descarga EN PARALELO con el chunk de la ruta que lo usa (ver lazyPage.ts) y nunca antes de
// visitarla. Cambiar de idioma descarga únicamente los espacios que la sesión ya ha usado.
//
// Los tipos salen de los JSON en español (fuente de verdad; ver types.ts) mediante `import type`, que no
// añade nada al bundle. La paridad es/en/de está vigilada por messages-parity.test.ts.
import commonEs from "./locales/es/common.json";
import siteEs from "./locales/es/site.json";

type Json<T> = T extends { default: infer D } ? D : T;

export interface Messages {
  auth: Json<typeof import("./locales/es/auth.json")>;
  common: typeof commonEs;
  cosplay: Json<typeof import("./locales/es/cosplay.json")>;
  media: Json<typeof import("./locales/es/media.json")>;
  moderation: Json<typeof import("./locales/es/moderation.json")>;
  site: typeof siteEs;
  community: Json<typeof import("./locales/es/community.json")>;
  account: Json<typeof import("./locales/es/account.json")>;
  admin: Json<typeof import("./locales/es/admin.json")>;
  developer: Json<typeof import("./locales/es/developer.json")>;
}

export type NamespaceName = keyof Messages;

export const NAMESPACES: readonly NamespaceName[] = [
  "auth",
  "common",
  "cosplay",
  "media",
  "moderation",
  "site",
  "community",
  "account",
  "admin",
  "developer",
];

/** Espacios que se cargan siempre antes de pintar (los usan la cabecera y la home). */
export const CORE_NAMESPACES: readonly NamespaceName[] = ["common", "site"];

// Importación perezosa de todos los JSON salvo los dos núcleos en español (ya importados de forma
// estática arriba; si el glob también los alcanzara Vite generaría un chunk duplicado e inalcanzable).
const LAZY_MODULES = import.meta.glob<{ default: unknown }>(
  ["./locales/*/*.json", "!./locales/es/common.json", "!./locales/es/site.json"],
  { eager: false },
);

type Store = Partial<Record<Locale, Partial<Messages>>>;

let store: Store = { es: { common: commonEs, site: siteEs } };
const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<void>>();
let activeLocale: Locale | null = null;

function publish(locale: Locale, namespace: NamespaceName, data: unknown) {
  store = { ...store, [locale]: { ...store[locale], [namespace]: data } };
  listeners.forEach((listener) => listener());
}

export function subscribeMessages(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const EMPTY: Partial<Messages> = {};

/** Mensajes cargados de un idioma (identidad estable hasta que se añade un espacio de nombres). */
export function getMessagesSnapshot(locale: Locale): Partial<Messages> {
  return store[locale] ?? EMPTY;
}

export function loadedNamespaces(locale: Locale): NamespaceName[] {
  return Object.keys(store[locale] ?? {}) as NamespaceName[];
}

export function isNamespaceName(value: string): value is NamespaceName {
  return (NAMESPACES as readonly string[]).includes(value);
}

/** Idioma que la interfaz está mostrando (lo fija el proveedor); antes de montarse, el que resolverá. */
export function currentLocale(): Locale {
  return (activeLocale ??= resolveInitialLocale());
}
export function setCurrentLocale(locale: Locale): void {
  activeLocale = locale;
}

async function importNamespace(
  locale: Locale,
  namespace: NamespaceName,
): Promise<unknown> {
  const key = `./locales/${locale}/${namespace}.json`;
  const loader = LAZY_MODULES[key];
  if (!loader) throw new Error(`Mensajes no encontrados: ${key}`);
  return (await loader()).default;
}

function ensureOne(locale: Locale, namespace: NamespaceName): Promise<void> {
  if (store[locale]?.[namespace]) return Promise.resolve();
  const id = `${locale}:${namespace}`;
  let pending = inFlight.get(id);
  if (!pending) {
    pending = (async () => {
      try {
        publish(locale, namespace, await importNamespace(locale, namespace));
      } catch {
        // Fallo de red o chunk corrupto: en/de caen a ES para que la UI siga siendo utilizable.
        if (locale !== "es") {
          try {
            publish(locale, namespace, await importNamespace("es", namespace));
          } catch {
            /* sin mensajes: se mostrará la clave */
          }
        }
      } finally {
        inFlight.delete(id);
      }
    })();
    inFlight.set(id, pending);
  }
  return pending;
}

/** Garantiza que los espacios de nombres indicados estén cargados en `locale`. Nunca lanza. */
export async function ensureNamespaces(
  locale: Locale,
  namespaces: readonly NamespaceName[],
): Promise<void> {
  await Promise.all(namespaces.map((namespace) => ensureOne(locale, namespace)));
}

/** Carga el núcleo (más los espacios extra) de un idioma. Nunca lanza. */
export async function loadMessages(
  locale: Locale,
  extra: readonly NamespaceName[] = [],
): Promise<void> {
  await ensureNamespaces(locale, [...CORE_NAMESPACES, ...extra]);
}
