import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { IntlProvider } from "use-intl";
import {
  DEFAULT_LOCALE,
  persistLocale,
  resolveInitialLocale,
  type Locale,
} from "./locale";
import { ES_MESSAGES, loadMessages, type Messages } from "./messages";
import { LocaleContext, type LocaleContextValue } from "./useUpminaLocale";
import "./types";

// Proveedor de idioma de Cosplay (Fase 9I-1). Deliberadamente NO envuelve toda la app: solo el
// subárbol de /cosplay lo monta (dentro de su propio chunk perezoso), así que use-intl y los
// JSON de mensajes nunca entran en el bundle de Inicio/Twitch/YouTube/etc. Cuando 9L migre el
// resto del sitio a i18n, este proveedor puede subirse a main.tsx sin cambiar su API.
//
// use-intl NO gestiona el cambio de idioma por sí solo (su IntlProvider es de solo lectura desde
// fuera): este módulo añade el contexto que falta (locale actual + setLocale persistente, en
// useUpminaLocale.ts) y envuelve <IntlProvider> con los mensajes ya cargados.

export default function CosplayLocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(resolveInitialLocale);
  // Arranca siempre con ES en memoria (sin red): si el idioma resuelto es en/de, el efecto de
  // abajo lo sustituye en cuanto termina de cargar.
  const [messages, setMessages] = useState<Messages>(ES_MESSAGES);
  const [isChangingLocale, setIsChangingLocale] = useState(locale !== DEFAULT_LOCALE);

  useEffect(() => {
    let cancelled = false;
    if (locale === DEFAULT_LOCALE) {
      setMessages(ES_MESSAGES);
      setIsChangingLocale(false);
      return;
    }
    setIsChangingLocale(true);
    loadMessages(locale).then((loaded) => {
      if (cancelled) return;
      setMessages(loaded);
      setIsChangingLocale(false);
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  // <html lang> refleja el idioma de Cosplay mientras está montado; al salir de /cosplay vuelve
  // al español del resto del sitio (que no es i18n-aware todavía, Fase 9L).
  useEffect(() => {
    document.documentElement.lang = locale;
    return () => {
      document.documentElement.lang = DEFAULT_LOCALE;
    };
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
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
        locale={locale}
        messages={messages}
        // ES es el idioma de reserva final para claves ausentes (no debería ocurrir: la
        // paridad ES/EN/DE está cubierta por i18n-parity.test.ts). `onError` se deja en su
        // valor por defecto (console.error): una clave realmente ausente debe seguir siendo
        // visible en desarrollo, aunque la UI no se rompa gracias al fallback de abajo.
        getMessageFallback={({ key, namespace }) => {
          const path = namespace ? `${namespace}.${key}` : key;
          const fromEs = path
            .split(".")
            .reduce<unknown>(
              (acc, part) =>
                acc && typeof acc === "object"
                  ? (acc as Record<string, unknown>)[part]
                  : undefined,
              ES_MESSAGES,
            );
          return typeof fromEs === "string" ? fromEs : path;
        }}
      >
        {children}
      </IntlProvider>
    </LocaleContext.Provider>
  );
}
