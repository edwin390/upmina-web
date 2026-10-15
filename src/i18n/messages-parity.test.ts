import { describe, expect, it } from "vitest";
const FILES = import.meta.glob<Json>("./locales/*/*.json", {
  eager: true,
  import: "default",
});

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
  const withoutBranches = message.replace(
    /(?:(?:zero|one|two|few|many|other)|=\d+)\s*\{/g,
    "(",
  );
  for (const match of withoutBranches.matchAll(/\{\s*([a-zA-Z0-9_]+)/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

const NAMES = [
  ...new Set(Object.keys(FILES).map((p) => p.split("/").pop()!.replace(".json", ""))),
].sort();
const NAMESPACES: [string, Json, Json, Json][] = NAMES.map((n) => [
  n,
  FILES[`./locales/es/${n}.json`],
  FILES[`./locales/en/${n}.json`],
  FILES[`./locales/de/${n}.json`],
]);

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
