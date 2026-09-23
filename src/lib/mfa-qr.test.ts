import { describe, expect, it } from "vitest";
import { buildTotpQrImageSrc } from "./mfa-qr";

// Todos los valores de este archivo son SINTÉTICOS (nunca un qr_code real de Supabase):
// SVGs de juguete y cadenas de ejemplo diseñadas para ejercitar cada formato posible,
// nunca datos de una cuenta real.

describe("buildTotpQrImageSrc", () => {
  it("formato A — data URI ya completa: se usa tal cual, sin anteponer otro prefijo", () => {
    const complete = "data:image/svg+xml;utf-8,%3Csvg%3E%3C%2Fsvg%3E";
    expect(buildTotpQrImageSrc(complete)).toBe(complete);
  });

  it("formato A (base64) — data URI completa en base64: se usa tal cual", () => {
    const complete = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
    expect(buildTotpQrImageSrc(complete)).toBe(complete);
  });

  it("nunca produce una data URI anidada (data:...data:...)", () => {
    const complete = "data:image/svg+xml;utf-8,%3Csvg%3E%3C%2Fsvg%3E";
    const result = buildTotpQrImageSrc(complete);
    expect(result.match(/data:/g)).toHaveLength(1);
  });

  it("formato B — SVG crudo: se encodea exactamente una vez (decodeURIComponent reproduce el original)", () => {
    const rawSvg = `<svg><text>"quoted" #hash</text></svg>`;
    const src = buildTotpQrImageSrc(rawSvg);
    expect(src.startsWith("data:image/svg+xml;utf-8,")).toBe(true);
    const encodedPart = src.slice("data:image/svg+xml;utf-8,".length);
    expect(decodeURIComponent(encodedPart)).toBe(rawSvg);
    // Nunca doble encoding: un `%` real del SVG original (no hay aquí) se codificaría
    // como %25 una sola vez, no dos.
    expect(src).not.toContain("%253C");
  });

  it('formato B — caracteres SVG especiales (<, >, ", #, %) sobreviven el roundtrip', () => {
    const rawSvg = `<svg viewBox="0 0 1 1"><path d="M0,0#frag"/><text>100%</text></svg>`;
    const src = buildTotpQrImageSrc(rawSvg);
    const encodedPart = src.slice("data:image/svg+xml;utf-8,".length);
    expect(decodeURIComponent(encodedPart)).toBe(rawSvg);
  });

  it("formato C — ya percent-encoded pero sin el prefijo data:: se antepone tal cual, sin doble encoding", () => {
    const preEncoded = "%3Csvg%3E%3C%2Fsvg%3E";
    const src = buildTotpQrImageSrc(preEncoded);
    expect(src).toBe(`data:image/svg+xml;utf-8,${preEncoded}`);
    // Doble encoding produciría %253C en vez de %3C.
    expect(src).not.toContain("%253C");
  });

  it("una cadena vacía no lanza y produce una data URI (vacía) coherente", () => {
    expect(() => buildTotpQrImageSrc("")).not.toThrow();
    expect(buildTotpQrImageSrc("")).toBe("data:image/svg+xml;utf-8,");
  });
});
