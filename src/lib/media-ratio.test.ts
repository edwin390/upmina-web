import { describe, expect, it } from "vitest";
import {
  MAX_ASPECT_RATIO,
  MIN_ASPECT_RATIO,
  clampAspectRatio,
  getKnownAspectRatio,
  rememberAspectRatio,
  wrapIndex,
} from "./media-ratio";

// La proporción sale del recurso real (Meta no da width/height): estos tests fijan
// cómo se interpreta contenido vertical, cuadrado y horizontal.

describe("clampAspectRatio", () => {
  it("vertical 4:5 se conserva (0,8)", () => {
    expect(clampAspectRatio(1080, 1350)).toBeCloseTo(0.8);
  });

  it("cuadrado 1:1 se conserva", () => {
    expect(clampAspectRatio(1080, 1080)).toBe(1);
  });

  it("horizontal 1,91:1 se conserva", () => {
    expect(clampAspectRatio(1080, 566)).toBeCloseTo(1.908, 2);
  });

  it("Reel / video vertical 9:16 se conserva", () => {
    expect(clampAspectRatio(1080, 1920)).toBeCloseTo(MIN_ASPECT_RATIO);
  });

  it("proporciones extremas se acotan al rango de Instagram (el resto va con barras)", () => {
    expect(clampAspectRatio(3000, 1000)).toBe(MAX_ASPECT_RATIO);
    expect(clampAspectRatio(1000, 4000)).toBe(MIN_ASPECT_RATIO);
  });

  it("sin dimensiones válidas devuelve null, no inventa una proporción", () => {
    expect(clampAspectRatio(0, 0)).toBeNull();
    expect(clampAspectRatio(100, 0)).toBeNull();
    expect(clampAspectRatio(NaN, 100)).toBeNull();
  });
});

describe("rememberAspectRatio", () => {
  it("recuerda la proporción por id y no guarda dimensiones inválidas", () => {
    rememberAspectRatio("post-a", 1080, 1350);
    rememberAspectRatio("post-b", 0, 0);
    expect(getKnownAspectRatio("post-a")).toBeCloseTo(0.8);
    expect(getKnownAspectRatio("post-b")).toBeUndefined();
  });
});

describe("wrapIndex (navegación circular)", () => {
  it("el último → siguiente → primero", () => {
    expect(wrapIndex(4, 1, 5)).toBe(0);
  });

  it("el primero → anterior → último", () => {
    expect(wrapIndex(0, -1, 5)).toBe(4);
  });

  it("avanza y retrocede normalmente en medio", () => {
    expect(wrapIndex(2, 1, 5)).toBe(3);
    expect(wrapIndex(2, -1, 5)).toBe(1);
  });

  it("con un solo elemento se queda en él", () => {
    expect(wrapIndex(0, 1, 1)).toBe(0);
    expect(wrapIndex(0, -1, 1)).toBe(0);
  });
});
