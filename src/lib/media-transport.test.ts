import { describe, expect, it } from "vitest";
import {
  decideTransportStrategy,
  PRESHRINK_BYTES_THRESHOLD,
  PRESHRINK_LONG_EDGE_THRESHOLD,
  prepareUploadBlob,
} from "./media-transport";

function fakeFile(mime: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], "foto.jpg", { type: mime });
}

describe("decideTransportStrategy — política congelada (Fase 9I, sección 13)", () => {
  it("HEIC/HEIF/AVIF de origen SIEMPRE 'original', nunca se reducen en el navegador", () => {
    for (const mime of ["image/heic", "image/heif", "image/avif"]) {
      expect(
        decideTransportStrategy({
          mime,
          bytes: 50_000_000,
          longEdge: 8000,
          browserCapable: true,
        }),
      ).toBe("original");
    }
  });

  it("sin capacidad de navegador: 'original' aunque el resto de condiciones se cumplan", () => {
    expect(
      decideTransportStrategy({
        mime: "image/jpeg",
        bytes: 10_000_000,
        longEdge: 5000,
        browserCapable: false,
      }),
    ).toBe("original");
  });

  it("sin dimensiones conocidas (longEdge=null): 'original', nunca se reduce a ciegas", () => {
    expect(
      decideTransportStrategy({
        mime: "image/jpeg",
        bytes: 10_000_000,
        longEdge: null,
        browserCapable: true,
      }),
    ).toBe("original");
  });

  it("frontera de bytes: exactamente 2.5 MB NO dispara pre-shrink (es '>', no '>=')", () => {
    expect(
      decideTransportStrategy({
        mime: "image/jpeg",
        bytes: PRESHRINK_BYTES_THRESHOLD,
        longEdge: 3000,
        browserCapable: true,
      }),
    ).toBe("original");
    expect(
      decideTransportStrategy({
        mime: "image/jpeg",
        bytes: PRESHRINK_BYTES_THRESHOLD + 1,
        longEdge: 3000,
        browserCapable: true,
      }),
    ).toBe("pre-shrink");
  });

  it("frontera de lado largo: exactamente 2560px NO dispara pre-shrink (es '>', no '>=')", () => {
    expect(
      decideTransportStrategy({
        mime: "image/jpeg",
        bytes: 5_000_000,
        longEdge: PRESHRINK_LONG_EDGE_THRESHOLD,
        browserCapable: true,
      }),
    ).toBe("original");
    expect(
      decideTransportStrategy({
        mime: "image/jpeg",
        bytes: 5_000_000,
        longEdge: PRESHRINK_LONG_EDGE_THRESHOLD + 1,
        browserCapable: true,
      }),
    ).toBe("pre-shrink");
  });

  it("ambas condiciones son obligatorias (AND, no OR)", () => {
    // Grande en bytes pero pequeño en dimensiones: no reduce.
    expect(
      decideTransportStrategy({
        mime: "image/jpeg",
        bytes: 10_000_000,
        longEdge: 1000,
        browserCapable: true,
      }),
    ).toBe("original");
    // Grande en dimensiones pero pequeño en bytes: no reduce.
    expect(
      decideTransportStrategy({
        mime: "image/jpeg",
        bytes: 100_000,
        longEdge: 5000,
        browserCapable: true,
      }),
    ).toBe("original");
  });

  it("JPEG/PNG/WebP son igualmente elegibles cuando se cumplen las dos condiciones", () => {
    for (const mime of ["image/jpeg", "image/png", "image/webp"]) {
      expect(
        decideTransportStrategy({
          mime,
          bytes: 5_000_000,
          longEdge: 4000,
          browserCapable: true,
        }),
      ).toBe("pre-shrink");
    }
  });
});

describe("prepareUploadBlob — orquestación + fallback único", () => {
  it("estrategia 'original': el blob es EXACTAMENTE el File de entrada, sin tocar canvas", async () => {
    const file = fakeFile("image/heic", 50_000_000);
    const result = await prepareUploadBlob(
      file,
      { width: 8000, height: 6000 },
      {
        browserCapable: true,
      },
    );
    expect(result.strategy).toBe("original");
    expect(result.blob).toBe(file);
    expect(result.mime).toBe("image/heic");
  });

  it("estrategia 'pre-shrink' con éxito: usa el resultado del pre-shrink inyectado", async () => {
    const file = fakeFile("image/jpeg", 5_000_000);
    const shrunkBlob = new Blob([new Uint8Array(100)], { type: "image/jpeg" });
    const result = await prepareUploadBlob(
      file,
      { width: 4000, height: 3000 },
      {
        browserCapable: true,
        preShrink: async () => ({ blob: shrunkBlob, width: 4096, height: 3072 }),
      },
    );
    expect(result.strategy).toBe("pre-shrink");
    expect(result.blob).toBe(shrunkBlob);
    expect(result.width).toBe(4096);
    expect(result.height).toBe(3072);
    expect(result.mime).toBe("image/jpeg");
  });

  it("si el pre-shrink elegido FALLA, cae UNA vez al original — nunca un segundo intento ni un error propagado", async () => {
    const file = fakeFile("image/jpeg", 5_000_000);
    let calls = 0;
    const result = await prepareUploadBlob(
      file,
      { width: 4000, height: 3000 },
      {
        browserCapable: true,
        preShrink: async () => {
          calls += 1;
          throw new Error("canvas explotó");
        },
      },
    );
    expect(result.strategy).toBe("original");
    expect(result.blob).toBe(file);
    expect(calls).toBe(1); // un único intento, nunca reintenta
  });

  it("la velocidad de red nunca es parte de la decisión: no existe ningún parámetro de red en la firma", () => {
    // Documenta la invariante de diseño: TransportDecisionInput no tiene ningún campo de
    // conectividad/velocidad — es estructuralmente imposible que la decisión dependa de la red.
    expect(decideTransportStrategy.length).toBe(1); // un único argumento: el objeto de entrada
  });
});
