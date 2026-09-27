import { afterEach, describe, expect, it, vi } from "vitest";
import { isMobileUploadDevice } from "./media-device";

// Detección de dispositivo para concurrencia de subida (Fase 9I-2C fix): deliberadamente NO usa
// navigator.userAgent (falsificable/cambia de forma) sino la señal estándar "puntero grueso
// (táctil) + viewport estrecho" vía matchMedia.

function stubMatchMedia(matches: boolean, onQuery?: (query: string) => void) {
  vi.stubGlobal("matchMedia", (query: string) => {
    onQuery?.(query);
    return { matches, media: query };
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isMobileUploadDevice", () => {
  it("true cuando puntero grueso + viewport estrecho coinciden", () => {
    stubMatchMedia(true);
    expect(isMobileUploadDevice()).toBe(true);
  });

  it("false cuando la consulta no coincide (desktop típico)", () => {
    stubMatchMedia(false);
    expect(isMobileUploadDevice()).toBe(false);
  });

  it("consulta puntero grueso combinado con un ancho máximo, nunca solo uno de los dos", () => {
    const seen: string[] = [];
    stubMatchMedia(false, (query) => seen.push(query));
    isMobileUploadDevice();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("pointer: coarse");
    expect(seen[0]).toContain("max-width");
  });

  it("no revienta y devuelve false si matchMedia no existe (SSR/entornos sin soporte)", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(() => isMobileUploadDevice()).not.toThrow();
    expect(isMobileUploadDevice()).toBe(false);
  });
});
