import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { IntlProvider } from "use-intl";
import {
  DEFAULT_LOCALE,
  persistLocale,
  resolveInitialLocale,
  type Locale,
} from "./locale";
import {
  ensureNamespaces,
  getMessagesSnapshot,
  isNamespaceName,
  loadMessages,
  loadedNamespaces,
  setCurrentLocale,
  subscribeMessages,
  type Messages,
} from "./messages";
import { LocaleContext, type LocaleContextValue } from "./useUpminaLocale";
import "./types";

// use-intl NO gestiona el cambio de idioma por sí solo (su IntlProvider es de solo lectura desde
// fuera): este módulo añade el contexto que falta (locale actual + setLocale persistente, en
// useUpminaLocale.ts) y envuelve <IntlProvider> con los mensajes ya cargados.
//
// Proveedor ÚNICO de idioma: main.tsx lo monta en la raíz (con `gate`, que no pinta hasta tener los mensajes del
// idioma elegido: sin parpadeo de otro idioma). Los proveedores que algunas páginas montaban por su cuenta pasan a
// ser transparentes (reutilizan el de la raíz), así que el selector de idioma cambia TODA la interfaz a la vez.
export default function UpminaLocaleProvider({
  children,
  gate = false,
}: {
  children: ReactNode;
  gate?: boolean;
}) {
  const parent = useContext(LocaleContext);
  if (parent) return <>{children}</>;
  return <RootLocaleProvider gate={gate}>{children}</RootLocaleProvider>;
}

function RootLocaleProvider({ children, gate }: { children: ReactNode; gate: boolean }) {
  const [locale, setLocaleState] = useState<Locale>(resolveInitialLocale);
  // Idioma cuyos mensajes se están mostrando. Arranca en ES (el núcleo está en el bundle, sin red) y sólo pasa
  // al idioma elegido cuando sus mensajes ya están cargados: al cambiar de idioma nunca se ve una mezcla ni claves.
  const [shown, setShown] = useState<Locale>(DEFAULT_LOCALE);
  const messages = useSyncExternalStore(subscribeMessages, () =>
    getMessagesSnapshot(shown),
  );
  const isChangingLocale = locale !== shown;
  // Con `gate`, hasta que no están los mensajes del idioma inicial no se pinta nada (evita mostrar ES y saltar a EN/DE).
  const ready = !gate || !isChangingLocale;

  useEffect(() => {
    setCurrentLocale(locale);
  }, [locale]);

  useEffect(() => {
    if (locale === shown) return;
    let cancelled = false;
    // Se conservan los espacios de nombres que la sesión ya estaba usando (páginas abiertas incluidas).
    void loadMessages(locale, loadedNamespaces(shown)).then(() => {
      if (!cancelled) setShown(locale);
    });
    return () => {
      cancelled = true;
    };
  }, [locale, shown]);

  // <html lang> refleja el idioma mostrado.
  useEffect(() => {
    document.documentElement.lang = shown;
  }, [shown]);
  useEffect(() => {
    return () => {
      document.documentElement.lang = DEFAULT_LOCALE;
    };
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setCurrentLocale(next);
    setLocaleState(next);
    persistLocale(next);
  }, []);

  const contextValue = useMemo<LocaleContextValue>(
    () => ({ locale, isChangingLocale, setLocale }),
    [locale, isChangingLocale, setLocale],
  );

  return (
    <LocaleContext.Provider value={contextValue}>
      <IntlProvider
        locale={shown}
        messages={messages as unknown as Messages}
        // Un espacio de nombres sin cargar (p. ej. un componente suelto fuera de una ruta con precarga) se pide en
        // cuanto se detecta; el resto de errores siguen yendo a la consola como siempre.
        onError={(error) => {
          const namespace = /`([A-Za-z0-9_]+)[.`]/.exec(error.message)?.[1];
          if (
            namespace &&
            isNamespaceName(namespace) &&
            !(namespace in getMessagesSnapshot(shown))
          ) {
            void ensureNamespaces(shown, [namespace]);
            return;
          }
          console.error(error);
        }}
        // ES es el idioma de reserva final para claves ausentes (no debería ocurrir: la paridad
        // ES/EN/DE está cubierta por messages-parity.test.ts).
        getMessageFallback={({ key, namespace }) => {
          const path = namespace ? `${namespace}.${key}` : key;
          const fromEs = path
            .split(".")
            .reduce<unknown>(
              (acc, part) =>
                acc && typeof acc === "object"
                  ? (acc as Record<string, unknown>)[part]
                  : undefined,
              getMessagesSnapshot(DEFAULT_LOCALE),
            );
          return typeof fromEs === "string" ? fromEs : path;
        }}
      >
        {ready ? (
          children
        ) : (
          <div className="min-h-screen bg-bg-base" aria-hidden="true" />
        )}
      </IntlProvider>
    </LocaleContext.Provider>
  );
}
