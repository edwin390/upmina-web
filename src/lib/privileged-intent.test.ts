import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PRIVILEGED_INTENTS, parsePrivilegedIntent } from "./privileged-intent";

describe("parsePrivilegedIntent", () => {
  it.each(["create", "edit", "delete"] as const)("%s es válido", (value) => {
    expect(parsePrivilegedIntent(value)).toBe(value);
  });

  it("los valores reconocidos son exactamente create, edit y delete", () => {
    expect([...PRIVILEGED_INTENTS]).toEqual(["create", "edit", "delete"]);
  });

  it.each([
    "unknown",
    "update",
    "remove",
    "publish",
    "admin",
    "",
    " ",
    "create ",
    " create",
    "create\n",
    "create,edit",
    "create&edit",
    "create=edit",
    "cosplay-create",
    "cosplay-edit:42",
    "delete:42",
    "__proto__",
    "constructor",
    "toString",
  ])("%j → null", (value) => {
    expect(parsePrivilegedIntent(value)).toBeNull();
  });

  it.each(["Create", "CREATE", "cReAtE", "Edit", "EDIT", "Delete", "DELETE"])(
    "política: sensible a mayúsculas (%s → null)",
    (value) => {
      expect(parsePrivilegedIntent(value)).toBeNull();
    },
  );

  it.each([null, undefined, 0, 1, true, false, {}, [], ["create"], { intent: "create" }])(
    "no-string %j → null",
    (value) => {
      expect(parsePrivilegedIntent(value)).toBeNull();
    },
  );

  it("un objeto con toString() que devuelve una intención no cuenta", () => {
    expect(parsePrivilegedIntent({ toString: () => "delete" })).toBeNull();
  });
});

describe("una intención es solo DATOS: no concede ni ejecuta nada", () => {
  it("parsear 'delete' no dispara ningún efecto (ni fetch, ni XHR, ni beacon, ni navegación)", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("no debe llamarse");
    });
    const beaconSpy = vi.fn();
    Object.defineProperty(navigator, "sendBeacon", {
      value: beaconSpy,
      configurable: true,
    });
    const before = window.location.href;

    const result = parsePrivilegedIntent("delete");

    expect(result).toBe("delete");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beaconSpy).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    fetchSpy.mockRestore();
  });

  it("el resultado es un string plano: sin funciones ni callbacks que pudieran ejecutar algo", () => {
    for (const intent of PRIVILEGED_INTENTS) {
      const parsed = parsePrivilegedIntent(intent);
      expect(typeof parsed).toBe("string");
      expect(typeof parsed).not.toBe("function");
    }
  });

  it("'delete' recibe exactamente el mismo tratamiento inerte que 'create'", () => {
    expect(typeof parsePrivilegedIntent("delete")).toBe(
      typeof parsePrivilegedIntent("create"),
    );
  });

  it("el módulo no contiene fetch, XMLHttpRequest, sendBeacon, storage, supabase ni Authorization (verificación estructural)", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/privileged-intent.ts"),
      "utf8",
    )
      // Se ignoran los comentarios: la documentación puede nombrar estos conceptos.
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    for (const forbidden of [
      "fetch(",
      "XMLHttpRequest",
      "sendBeacon",
      "localStorage",
      "sessionStorage",
      "document.",
      "window.",
      "supabase",
      "Authorization",
      "import ",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("no existe ninguna API que convierta una intención en autorización: solo exporta datos y un parser", () => {
    // Importación estática de todo el módulo: cualquier export futuro de tipo "ejecutar" o
    // "autorizar" rompería este contrato y debe revisarse.
    return import("./privileged-intent").then((mod) => {
      expect(Object.keys(mod).sort()).toEqual([
        "PRIVILEGED_INTENTS",
        "parsePrivilegedIntent",
      ]);
    });
  });
});
