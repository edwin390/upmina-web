import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  getPersistedLocale,
  isSupportedLocale,
  persistLocale,
  resolveInitialLocale,
} from "./locale";

// Resolución de idioma (Fase 9I-1): orden congelado preferencia persistida → navegador →
// español, y el idioma nunca vive en localStorage/navegador de otro modo que el previsto aquí.

function stubLanguages(languages: string[]) {
  vi.stubGlobal("navigator", { ...navigator, languages, language: languages[0] ?? "" });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("SUPPORTED_LOCALES / DEFAULT_LOCALE", () => {
  it("exactamente es, en, de — en ese orden", () => {
    expect(SUPPORTED_LOCALES).toEqual(["es", "en", "de"]);
  });

  it("el idioma de reserva final es español", () => {
    expect(DEFAULT_LOCALE).toBe("es");
  });
});

describe("isSupportedLocale", () => {
  it.each(["es", "en", "de"])("%s es soportado", (locale) => {
    expect(isSupportedLocale(locale)).toBe(true);
  });

  it.each([null, undefined, "", "ES", "fr", "es-ES", 1, {}, []])(
    "%s no es soportado",
    (value) => {
      expect(isSupportedLocale(value)).toBe(false);
    },
  );
});

describe("persistLocale / getPersistedLocale", () => {
  it("sin preferencia guardada → null", () => {
    expect(getPersistedLocale()).toBeNull();
  });

  it.each(["es", "en", "de"] as const)("guarda y recupera %s", (locale) => {
    persistLocale(locale);
    expect(getPersistedLocale()).toBe(locale);
  });

  it("un valor corrupto en localStorage (no un idioma soportado) → null, no lanza", () => {
    window.localStorage.setItem("upmina:locale", "fr");
    expect(getPersistedLocale()).toBeNull();
  });

  it("localStorage bloqueado (lanza) → null, nunca revienta la resolución", () => {
    const spy = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("bloqueado");
    });
    expect(getPersistedLocale()).toBeNull();
    spy.mockRestore();
  });

  it("persistLocale nunca lanza aunque localStorage falle al escribir", () => {
    const spy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("lleno");
    });
    expect(() => persistLocale("en")).not.toThrow();
    spy.mockRestore();
  });
});

describe("resolveInitialLocale", () => {
  it("preferencia persistida gana sobre el navegador", () => {
    stubLanguages(["de-DE", "de"]);
    persistLocale("en");
    expect(resolveInitialLocale()).toBe("en");
  });

  it.each([
    ["en-US", "en"],
    ["de-DE", "de"],
    ["es-MX", "es"],
  ] as const)("sin preferencia: navegador %s → %s", (browserLang, expected) => {
    stubLanguages([browserLang]);
    expect(resolveInitialLocale()).toBe(expected);
  });

  it("navegador con idioma NO soportado (p. ej. francés) → español, nunca se adivina", () => {
    stubLanguages(["fr-FR", "fr"]);
    expect(resolveInitialLocale()).toBe("es");
  });

  it("usa el primer idioma SOPORTADO de navigator.languages, en orden de preferencia real", () => {
    stubLanguages(["fr-FR", "de-DE", "en-US"]);
    expect(resolveInitialLocale()).toBe("de");
  });

  it("sin navigator.languages ni preferencia → español", () => {
    stubLanguages([]);
    expect(resolveInitialLocale()).toBe("es");
  });
});
