import { describe, expect, it } from "vitest";
import {
  RETURN_ROUTES,
  parseSafeReturnTo,
  parseSafeReturnToWithRoutes,
  type ReturnRoutes,
} from "./safe-return-to";

// Rutas SOLO de prueba para ejercitar `intent` sin crear rutas reales (no existe /cosplay).
const FIXTURE_ROUTES: ReturnRoutes = {
  "/fixture/item": { allowsIntent: true },
  "/fixture/plain": { allowsIntent: false },
};

describe("allowlist inicial", () => {
  it("contiene exactamente /admin, /admin/activate, /account y /comunidad, sin parámetros", () => {
    expect(Object.keys(RETURN_ROUTES).sort()).toEqual([
      "/account",
      "/admin",
      "/admin/activate",
      "/comunidad",
    ]);
    for (const route of Object.values(RETURN_ROUTES)) {
      expect(route.allowsIntent).toBe(false);
    }
  });

  it("no incluye /cosplay todavía", () => {
    expect(parseSafeReturnTo("/cosplay")).toBeNull();
    expect(parseSafeReturnTo("/cosplay/42")).toBeNull();
    expect(parseSafeReturnTo("/cosplay?intent=create")).toBeNull();
  });
});

describe("la allowlist de producción no puede ser alterada ni sustituida", () => {
  it("la tabla y sus entradas están congeladas: asignar o añadir rutas lanza", () => {
    expect(Object.isFrozen(RETURN_ROUTES)).toBe(true);
    for (const route of Object.values(RETURN_ROUTES))
      expect(Object.isFrozen(route)).toBe(true);
    expect(() => {
      (RETURN_ROUTES as Record<string, unknown>)["/cosplay"] = { allowsIntent: true };
    }).toThrow(TypeError);
    expect(() => {
      (RETURN_ROUTES["/admin"] as { allowsIntent: boolean }).allowsIntent = true;
    }).toThrow(TypeError);
    expect(parseSafeReturnTo("/cosplay")).toBeNull();
    expect(parseSafeReturnTo("/admin?intent=create")).toBeNull();
  });

  it("la API pública ignora cualquier segundo argumento: una tabla de rutas no controla producción", () => {
    const hostile = { "/evil": { allowsIntent: true }, "/admin": { allowsIntent: true } };
    const publicParse = parseSafeReturnTo as (raw: unknown, routes?: unknown) => unknown;
    expect(publicParse("/evil", hostile)).toBeNull();
    expect(publicParse("/admin?intent=create", hostile)).toBeNull();
    expect(publicParse("/admin", hostile)).toEqual({
      pathname: "/admin",
      intent: null,
      path: "/admin",
    });
  });

  it("usar rutas fixture con la variante de pruebas no altera la allowlist de producción", () => {
    expect(
      parseSafeReturnToWithRoutes("/fixture/item?intent=edit", FIXTURE_ROUTES),
    ).not.toBeNull();
    expect(parseSafeReturnTo("/fixture/item")).toBeNull();
    expect(Object.keys(RETURN_ROUTES)).not.toContain("/fixture/item");
  });
});

describe("destinos válidos", () => {
  it.each(["/admin", "/admin/activate", "/account", "/comunidad"])("%s", (path) => {
    expect(parseSafeReturnTo(path)).toEqual({ pathname: path, intent: null, path });
  });

  it("devuelve un destino reconstruido, nunca el objeto/texto original", () => {
    const raw = "/admin";
    const result = parseSafeReturnTo(raw);
    expect(result?.path).toBe("/admin");
    expect(Object.isFrozen(result)).toBe(false); // es un valor nuevo, no una referencia compartida
  });
});

describe("destinos inválidos: no string / vacío / forma", () => {
  it.each([null, undefined, 0, 1, true, {}, [], ["/admin"], () => "/admin", Symbol("x")])(
    "%s no es un string → null",
    (value) => {
      expect(parseSafeReturnTo(value)).toBeNull();
    },
  );

  it.each([
    ["vacío", ""],
    ["raíz", "/"],
    ["sin barra inicial", "admin"],
    ["relativo ./", "./admin"],
    ["relativo ../", "../admin"],
    ["con barra final", "/admin/"],
    ["mayúsculas", "/Admin"],
    ["mayúsculas 2", "/ADMIN"],
    ["ruta desconocida", "/desconocida"],
    ["subruta desconocida", "/admin/unknown"],
    ["subruta de admin/activate", "/admin/activate/extra"],
    ["prefijo no exacto", "/administrator"],
    ["prefijo no exacto 2", "/accounts"],
    ["punto-punto", "/admin/../account"],
    ["punto", "/admin/./activate"],
    ["punto-punto que sale", "/account/../admin"],
    ["punto y coma", "/admin;/x"],
    ["propiedad de Object.prototype", "/constructor"],
    ["proto", "/__proto__"],
  ])("%s → null", (_name, value) => {
    expect(parseSafeReturnTo(value)).toBeNull();
  });
});

describe("open redirects y esquemas", () => {
  it.each([
    "//evil.com",
    "///evil.com",
    "////evil.com",
    "//evil.com/admin",
    "https://evil.com",
    "http://evil.com",
    "https://evil.com/admin",
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "ftp://evil.com",
    "evil.com",
    "www.evil.com/admin",
    "mailto:a@b.c",
    "/\\evil.com",
    "\\evil.com",
    "\\\\evil.com",
    "/admin\\evil",
    "/admin\\",
    "/\\/evil.com",
  ])("%s → null", (value) => {
    expect(parseSafeReturnTo(value)).toBeNull();
  });

  it("una URL absoluta del propio origen tampoco es un destino válido (solo rutas relativas)", () => {
    expect(parseSafeReturnTo("https://upmina.example/admin")).toBeNull();
    expect(parseSafeReturnTo("http://localhost:3000/admin")).toBeNull();
  });
});

describe("codificación y ambigüedad: cualquier % falla cerrado", () => {
  it.each([
    "/%5cevil",
    "/%5Cevil.com",
    "/%2f%2fevil.com",
    "/%2F%2Fevil.com",
    "/admin%2f..%2faccount",
    "/admin%00",
    "/admin%0d%0aSet-Cookie:x=1",
    "/admin%20",
    "/%61dmin",
    "/admin%",
    "/admin%zz",
    "/admin%2",
    "/%",
    "%2f%2fevil.com",
    "%2fadmin",
    "/admin?intent=%63reate",
    "/admin?%69ntent=create",
    "/admin?a=%",
  ])("%s → null", (value) => {
    expect(parseSafeReturnTo(value)).toBeNull();
    expect(parseSafeReturnToWithRoutes(value, FIXTURE_ROUTES)).toBeNull();
  });
});

describe("caracteres de control, espacios y Unicode", () => {
  it.each([
    ["nulo", "/admin\u0000"],
    ["tab", "/admin\t"],
    ["salto de línea", "/admin\n"],
    ["retorno de carro", "/admin\r"],
    ["CRLF inyectado", "/admin\r\nLocation: https://evil.com"],
    ["DEL", "/admin\u007f"],
    ["escape", "/admin\u001b"],
    ["espacio inicial", " /admin"],
    ["espacio final", "/admin "],
    ["espacio en medio", "/ad min"],
    ["tab inicial", "\t/admin"],
    ["salto de línea inicial", "\n/admin"],
    ["NBSP", "/admin "],
    ["espacio Unicode", "/admin "],
    ["separador de línea", "/admin "],
    ["ZWSP", "/adm​in"],
    ["homógrafo cirílico", "/аdmin"],
    ["barra de ancho completo", "／／evil.com"],
    ["barra fraccionaria", "/admin∕"],
    ["BOM", "﻿/admin"],
    ["emoji", "/admin😀"],
  ])("%s → null", (_name, value) => {
    expect(parseSafeReturnTo(value)).toBeNull();
  });
});

describe("fragmento", () => {
  it.each([
    "/admin#",
    "/admin#x",
    "/admin/activate#token=abc",
    "/account#top",
    "#/admin",
    "/admin?#",
  ])("%s → null", (value) => {
    expect(parseSafeReturnTo(value)).toBeNull();
  });
});

describe("query: por defecto ninguna ruta admite parámetros", () => {
  it.each([
    "/admin?",
    "/admin?x=1",
    "/admin?intent=create",
    "/admin?intent=delete",
    "/admin/activate?token=secreto",
    "/account?returnTo=/admin",
    "/comunidad?page=2",
    "/admin?&",
    "/admin??",
  ])("%s → null", (value) => {
    expect(parseSafeReturnTo(value)).toBeNull();
  });

  it("un token en la query nunca se acepta como destino", () => {
    expect(parseSafeReturnTo("/admin/activate?token=abc")).toBeNull();
  });
});

describe("query con intent (solo en rutas que lo declaran; fixture)", () => {
  it.each(["create", "edit", "delete"] as const)("intent=%s válido", (intent) => {
    expect(
      parseSafeReturnToWithRoutes(`/fixture/item?intent=${intent}`, FIXTURE_ROUTES),
    ).toEqual({
      pathname: "/fixture/item",
      intent,
      path: `/fixture/item?intent=${intent}`,
    });
  });

  it("sin query en una ruta que admite intent → intent null", () => {
    expect(parseSafeReturnToWithRoutes("/fixture/item", FIXTURE_ROUTES)).toEqual({
      pathname: "/fixture/item",
      intent: null,
      path: "/fixture/item",
    });
  });

  it("una ruta que no declara intent lo rechaza aunque exista en la tabla", () => {
    expect(
      parseSafeReturnToWithRoutes("/fixture/plain?intent=create", FIXTURE_ROUTES),
    ).toBeNull();
    expect(parseSafeReturnToWithRoutes("/fixture/plain", FIXTURE_ROUTES)).not.toBeNull();
  });

  it.each([
    ["intent desconocido", "/fixture/item?intent=drop"],
    ["intent vacío", "/fixture/item?intent="],
    ["mayúsculas", "/fixture/item?intent=CREATE"],
    ["Capitalizado", "/fixture/item?intent=Delete"],
    ["con espacio", "/fixture/item?intent=create%20"],
    ["intent duplicado igual", "/fixture/item?intent=create&intent=create"],
    ["intent duplicado distinto", "/fixture/item?intent=create&intent=delete"],
    ["parámetro extra", "/fixture/item?intent=create&x=1"],
    ["parámetro extra primero", "/fixture/item?x=1&intent=create"],
    ["solo parámetro desconocido", "/fixture/item?x=1"],
    ["nombre en mayúsculas", "/fixture/item?Intent=create"],
    ["nombre con espacios", "/fixture/item?intent =create"],
    ["nombre codificado", "/fixture/item?%69ntent=create"],
    ["sin =", "/fixture/item?intent"],
    ["doble =", "/fixture/item?intent=create=delete"],
    ["= inicial", "/fixture/item?=create"],
    ["&& vacío", "/fixture/item?intent=create&&"],
    ["& final", "/fixture/item?intent=create&"],
    ["& inicial", "/fixture/item?&intent=create"],
    ["? vacía", "/fixture/item?"],
    ["doble ?", "/fixture/item??intent=create"],
    ["punto y coma", "/fixture/item?intent=create;intent=delete"],
    ["array", "/fixture/item?intent[]=create"],
    ["proto", "/fixture/item?__proto__=x"],
    ["fragmento", "/fixture/item?intent=create#x"],
    ["ruta con intent en otra ruta no listada", "/otra?intent=create"],
  ])("%s → null", (_name, value) => {
    expect(parseSafeReturnToWithRoutes(value, FIXTURE_ROUTES)).toBeNull();
  });
});

describe("longitud y robustez", () => {
  it("rechaza destinos excesivamente largos", () => {
    expect(
      parseSafeReturnToWithRoutes(`/admin?${"a".repeat(5000)}`, FIXTURE_ROUTES),
    ).toBeNull();
    expect(parseSafeReturnTo(`/${"a".repeat(300)}`)).toBeNull();
  });

  it("no lanza con entradas hostiles", () => {
    const hostile = [
      "/admin?intent=create&".repeat(50),
      "\u0000".repeat(100),
      "/".repeat(1000),
      "?".repeat(100),
      "%".repeat(100),
      { toString: () => "/admin" },
    ];
    for (const value of hostile) {
      expect(() => parseSafeReturnTo(value)).not.toThrow();
      expect(parseSafeReturnTo(value)).toBeNull();
    }
  });

  it("un objeto con toString() que devuelve una ruta válida no cuenta (solo strings)", () => {
    expect(parseSafeReturnTo({ toString: () => "/admin" })).toBeNull();
  });

  it("el resultado de una ruta válida nunca contiene texto que no venga de la tabla o del enum", () => {
    const result = parseSafeReturnToWithRoutes(
      "/fixture/item?intent=edit",
      FIXTURE_ROUTES,
    );
    expect(result?.path).toBe("/fixture/item?intent=edit");
    expect(result?.path.startsWith("/")).toBe(true);
    expect(result?.path.startsWith("//")).toBe(false);
  });

  it("es una función pura: no navega ni toca el navegador", () => {
    const before = window.location.href;
    parseSafeReturnTo("/admin");
    parseSafeReturnTo("https://evil.com");
    expect(window.location.href).toBe(before);
  });
});
