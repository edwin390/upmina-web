import { describe, expect, it } from "vitest";
import commonEs from "./locales/es/common.json";
import commonEn from "./locales/en/common.json";
import commonDe from "./locales/de/common.json";
import cosplayEs from "./locales/es/cosplay.json";
import cosplayEn from "./locales/en/cosplay.json";
import cosplayDe from "./locales/de/cosplay.json";
import mediaEs from "./locales/es/media.json";
import mediaEn from "./locales/en/media.json";
import mediaDe from "./locales/de/media.json";

// Paridad ES/EN/DE (Fase 9I-1): las tres traducciones deben cubrir EXACTAMENTE el mismo árbol de
// claves y los mismos argumentos de interpolación ICU. Una clave que falte en EN/DE se
// resolvería en tiempo de ejecución al fallback de LocaleProvider (texto en español dentro de un
// documento en otro idioma) — legítimo como red de seguridad, pero nunca por un descuido: este
// test falla si eso ocurriera sin querer.

type Json = Record<string, unknown>;

function leafPaths(obj: Json, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return leafPaths(value as Json, path);
    }
    return [path];
  });
}

function leafValues(obj: Json, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, leafValues(value as Json, path));
    } else {
      out[path] = String(value);
    }
  }
  return out;
}

/** Nombres de argumento ICU: `{name}`, `{count, plural, ...}` → "name", "count". No profundiza
 *  en las ramas del plural (`one {...}`, `other {...}`) porque esas no son argumentos. */
function icuArgNames(message: string): string[] {
  const names = new Set<string>();
  for (const match of message.matchAll(/\{\s*([a-zA-Z0-9_]+)/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

const NAMESPACES: [string, Json, Json, Json][] = [
  ["common", commonEs, commonEn, commonDe],
  ["cosplay", cosplayEs, cosplayEn, cosplayDe],
  ["media", mediaEs, mediaEn, mediaDe],
];

describe.each(NAMESPACES)("paridad de mensajes — %s", (ns, es, en, de) => {
  const esPaths = leafPaths(es).sort();

  it.each([
    ["en", en],
    ["de", de],
  ] as const)("%s cubre exactamente las mismas claves que es", (_locale, messages) => {
    expect(leafPaths(messages as Json).sort()).toEqual(esPaths);
  });

  it.each([
    ["en", en],
    ["de", de],
  ] as const)(
    "%s usa los mismos argumentos de interpolación ICU que es, por clave",
    (_locale, messages) => {
      const esValues = leafValues(es);
      const otherValues = leafValues(messages as Json);
      for (const path of esPaths) {
        expect(icuArgNames(otherValues[path] ?? "")).toEqual(icuArgNames(esValues[path]));
      }
    },
  );

  it("es no tiene claves duplicadas de hoja vacías ni valores vacíos", () => {
    for (const [path, value] of Object.entries(leafValues(es))) {
      expect(value.trim().length, `clave vacía: ${ns}.${path}`).toBeGreaterThan(0);
    }
  });
});
