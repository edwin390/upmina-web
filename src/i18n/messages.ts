import type { Locale } from "./locale";

// Mensajes ES: fuente editorial de la UI y fuente de tipos (ver types.ts). Import ESTÁTICO
// a propósito (es el idioma de reserva final: si el idioma activo fallara al cargar, o si un
// consumidor pide un mensaje antes de que termine la carga perezosa, ES debe estar disponible
// sin otro round-trip).
import commonEs from "./locales/es/common.json";
import cosplayEs from "./locales/es/cosplay.json";

export interface Messages {
  common: typeof commonEs;
  cosplay: typeof cosplayEs;
}

const ES_MESSAGES: Messages = { common: commonEs, cosplay: cosplayEs };

// Import perezoso SOLO para en/de (el patrón EXCLUYE es a propósito: ya está importado de forma
// estática arriba, y si el glob también lo alcanzara, Vite generaría un chunk duplicado e
// inalcanzable para esos dos JSON — advertencia real de `vite build`, no cosmética). Crea un
// chunk separado por idioma y espacio de nombres, así que visitar /cosplay en español nunca
// descarga common.en.json ni cosplay.de.json. `eager: false` es el valor por defecto; se deja
// explícito por claridad.
const LAZY_MODULES = import.meta.glob<{ default: unknown }>("./locales/{en,de}/*.json", {
  eager: false,
});

async function loadNamespace(locale: Locale, ns: keyof Messages): Promise<unknown> {
  const key = `./locales/${locale}/${ns}.json`;
  const loader = LAZY_MODULES[key];
  if (!loader) throw new Error(`Mensajes no encontrados: ${key}`);
  const mod = await loader();
  return mod.default;
}

/** Mensajes completos de un idioma. ES se resuelve sin red (ya está en memoria); en/de se
 *  cargan de forma perezosa la primera vez que se piden. Nunca lanza hacia quien llama: un
 *  fallo de carga (red, chunk corrupto) cae a ES para que la UI siga siendo utilizable. */
export async function loadMessages(locale: Locale): Promise<Messages> {
  if (locale === "es") return ES_MESSAGES;
  try {
    const [common, cosplay] = await Promise.all([
      loadNamespace(locale, "common"),
      loadNamespace(locale, "cosplay"),
    ]);
    return { common, cosplay } as Messages;
  } catch {
    return ES_MESSAGES;
  }
}

export { ES_MESSAGES };
