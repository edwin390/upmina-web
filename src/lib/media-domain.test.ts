import { describe, expect, it } from "vitest";
import {
  canTransition,
  isSourceMimeType,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_MEGAPIXELS,
  MULTIPART_PART_SIZE_BYTES,
  MULTIPART_THRESHOLD_BYTES,
  multipartPartCount,
  NO_CLIENT_PRESHRINK_MIME_TYPES,
  privateObjectKey,
  publicVariantKey,
  qualityForOutputWidth,
  reservationValidationError,
  stagingKey,
  targetWidthsForLongEdge,
  usesMultipart,
  validateReservationInput,
} from "./media-domain";

describe("isSourceMimeType", () => {
  it("acepta los 6 tipos de origen del V1", () => {
    for (const mime of [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
      "image/avif",
    ]) {
      expect(isSourceMimeType(mime)).toBe(true);
    }
  });

  it("rechaza SVG y cualquier tipo fuera de la lista cerrada", () => {
    expect(isSourceMimeType("image/svg+xml")).toBe(false);
    expect(isSourceMimeType("application/octet-stream")).toBe(false);
    expect(isSourceMimeType("")).toBe(false);
    expect(isSourceMimeType(undefined)).toBe(false);
    expect(isSourceMimeType(123)).toBe(false);
  });
});

describe("NO_CLIENT_PRESHRINK_MIME_TYPES", () => {
  it("HEIC/HEIF/AVIF nunca se reducen en el navegador", () => {
    expect(NO_CLIENT_PRESHRINK_MIME_TYPES.has("image/heic")).toBe(true);
    expect(NO_CLIENT_PRESHRINK_MIME_TYPES.has("image/heif")).toBe(true);
    expect(NO_CLIENT_PRESHRINK_MIME_TYPES.has("image/avif")).toBe(true);
  });

  it("JPEG/PNG/WebP sí son elegibles para reducción de transporte", () => {
    expect(NO_CLIENT_PRESHRINK_MIME_TYPES.has("image/jpeg")).toBe(false);
    expect(NO_CLIENT_PRESHRINK_MIME_TYPES.has("image/png")).toBe(false);
    expect(NO_CLIENT_PRESHRINK_MIME_TYPES.has("image/webp")).toBe(false);
  });
});

describe("usesMultipart / multipartPartCount", () => {
  it("por debajo del umbral (16 MiB) usa un único PUT", () => {
    expect(usesMultipart(MULTIPART_THRESHOLD_BYTES - 1)).toBe(false);
  });

  it("en el umbral exacto y por encima usa multipart", () => {
    expect(usesMultipart(MULTIPART_THRESHOLD_BYTES)).toBe(true);
    expect(usesMultipart(MULTIPART_THRESHOLD_BYTES + 1)).toBe(true);
  });

  it("cuenta partes de 8 MiB, redondeando hacia arriba", () => {
    expect(multipartPartCount(MULTIPART_PART_SIZE_BYTES)).toBe(1);
    expect(multipartPartCount(MULTIPART_PART_SIZE_BYTES + 1)).toBe(2);
    expect(multipartPartCount(MULTIPART_PART_SIZE_BYTES * 3)).toBe(3);
    expect(multipartPartCount(MAX_SOURCE_BYTES)).toBe(
      Math.ceil(MAX_SOURCE_BYTES / MULTIPART_PART_SIZE_BYTES),
    );
  });

  it("nunca devuelve 0 partes incluso para un tamaño degenerado", () => {
    expect(multipartPartCount(0)).toBe(1);
  });
});

describe("targetWidthsForLongEdge — nunca upscaling", () => {
  it("original grande (≥2560): las 4 variantes", () => {
    expect(targetWidthsForLongEdge(3000)).toEqual([480, 960, 1600, 2560]);
  });

  it("original exactamente en un ancho nominal lo incluye", () => {
    expect(targetWidthsForLongEdge(1600)).toEqual([480, 960, 1600]);
  });

  it("original mediano (entre 960 y 1600) excluye 1600/2560", () => {
    expect(targetWidthsForLongEdge(1200)).toEqual([480, 960]);
  });

  it("original más pequeño que el ancho nominal mínimo (480): UNA variante a su tamaño nativo", () => {
    expect(targetWidthsForLongEdge(300)).toEqual([300]);
  });

  it("nunca genera una lista vacía para una entrada válida", () => {
    for (const longEdge of [1, 100, 479, 480, 481, 5000]) {
      expect(targetWidthsForLongEdge(longEdge).length).toBeGreaterThan(0);
    }
  });

  it("entrada no finita o ≤0 devuelve lista vacía en vez de lanzar", () => {
    expect(targetWidthsForLongEdge(0)).toEqual([]);
    expect(targetWidthsForLongEdge(-10)).toEqual([]);
    expect(targetWidthsForLongEdge(NaN)).toEqual([]);
    expect(targetWidthsForLongEdge(Infinity)).toEqual([]);
  });
});

describe("qualityForOutputWidth", () => {
  it("usa la calidad congelada para cada ancho nominal", () => {
    expect(qualityForOutputWidth(480)).toBe(80);
    expect(qualityForOutputWidth(960)).toBe(80);
    expect(qualityForOutputWidth(1600)).toBe(82);
    expect(qualityForOutputWidth(2560)).toBe(85);
  });

  it("un ancho no nominal (variante única por original pequeño) usa 85 por defecto", () => {
    expect(qualityForOutputWidth(300)).toBe(85);
  });
});

describe("claves de objeto — generadas por servidor, sin datos personales", () => {
  it("staging/objects/public siguen el contrato exacto de la Fase 9I-2", () => {
    expect(stagingKey("cosplay", "abc-123", "image/jpeg")).toBe(
      "staging/cosplay/abc-123/original.jpg",
    );
    expect(privateObjectKey("cosplay", "abc-123", "image/heic")).toBe(
      "objects/cosplay/abc-123/original.heic",
    );
    expect(publicVariantKey("cosplay", "abc-123", 960)).toBe("cosplay/abc-123/w960.webp");
  });

  it("nunca incluye nada que no sea domain/assetId/rol — ni aunque se le pase basura", () => {
    const key = stagingKey("cosplay", "some-uuid", "image/png");
    expect(key).not.toMatch(/@/);
    expect(key.split("/")).toEqual(["staging", "cosplay", "some-uuid", "original.png"]);
  });
});

describe("validateReservationInput", () => {
  it("acepta una reserva mínima válida sin dimensiones declaradas", () => {
    const result = validateReservationInput({
      sourceMime: "image/jpeg",
      sourceBytes: 1000,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        sourceMime: "image/jpeg",
        sourceBytes: 1000,
        sourceWidth: null,
        sourceHeight: null,
      },
    });
  });

  it("acepta una reserva con dimensiones válidas dentro del límite de megapíxeles", () => {
    const result = validateReservationInput({
      sourceMime: "image/heic",
      sourceBytes: 5_000_000,
      sourceWidth: 4000,
      sourceHeight: 3000,
    });
    expect(result.ok).toBe(true);
  });

  it("rechaza un mime fuera de la lista cerrada (p. ej. SVG)", () => {
    expect(
      validateReservationInput({ sourceMime: "image/svg+xml", sourceBytes: 1000 }),
    ).toEqual({ ok: false, error: "invalid_mime" });
  });

  it("rechaza bytes ausentes, no numéricos, cero o negativos", () => {
    for (const sourceBytes of [undefined, "1000", 0, -5, NaN, Infinity]) {
      expect(validateReservationInput({ sourceMime: "image/jpeg", sourceBytes })).toEqual(
        {
          ok: false,
          error: "invalid_bytes",
        },
      );
    }
  });

  it("rechaza bytes por encima del máximo (60 MiB)", () => {
    expect(
      validateReservationInput({
        sourceMime: "image/jpeg",
        sourceBytes: MAX_SOURCE_BYTES + 1,
      }),
    ).toEqual({ ok: false, error: "too_large" });
  });

  it("acepta exactamente el máximo de bytes", () => {
    expect(
      validateReservationInput({
        sourceMime: "image/jpeg",
        sourceBytes: MAX_SOURCE_BYTES,
      }).ok,
    ).toBe(true);
  });

  it("rechaza dimensiones parciales (solo ancho, o solo alto)", () => {
    expect(
      validateReservationInput({
        sourceMime: "image/jpeg",
        sourceBytes: 1000,
        sourceWidth: 100,
      }),
    ).toEqual({ ok: false, error: "invalid_dimensions" });
    expect(
      validateReservationInput({
        sourceMime: "image/jpeg",
        sourceBytes: 1000,
        sourceHeight: 100,
      }),
    ).toEqual({ ok: false, error: "invalid_dimensions" });
  });

  it("rechaza dimensiones no numéricas, cero o negativas", () => {
    expect(
      validateReservationInput({
        sourceMime: "image/jpeg",
        sourceBytes: 1000,
        sourceWidth: 0,
        sourceHeight: 100,
      }),
    ).toEqual({ ok: false, error: "invalid_dimensions" });
  });

  it("rechaza más de 100 megapíxeles (100 MP exactos se aceptan)", () => {
    const [w, h] = [10000, 10000]; // 100_000_000 exacto
    expect(
      validateReservationInput({
        sourceMime: "image/jpeg",
        sourceBytes: 1000,
        sourceWidth: w,
        sourceHeight: h,
      }).ok,
    ).toBe(true);
    expect(
      validateReservationInput({
        sourceMime: "image/jpeg",
        sourceBytes: 1000,
        sourceWidth: w + 1,
        sourceHeight: h,
      }),
    ).toEqual({ ok: false, error: "too_many_pixels" });
    expect(w * h).toBe(MAX_SOURCE_MEGAPIXELS);
  });

  it("nunca acepta claves de objeto, propiedad de asset ni URL pública del cliente (el tipo de entrada no las admite)", () => {
    // ReservationInput solo tiene sourceMime/sourceBytes/sourceWidth/sourceHeight — este test
    // documenta la invariante de diseño: un objeto con campos extra los ignora por completo.
    const result = validateReservationInput({
      sourceMime: "image/jpeg",
      sourceBytes: 1000,
      // @ts-expect-error — campos deliberadamente ajenos al contrato, probando que se ignoran.
      storageKey: "objects/cosplay/otro-asset/original.jpg",
      ownerId: "otro-usuario",
    });
    expect(result.ok).toBe(true);
  });
});

describe("reservationValidationError", () => {
  it("devuelve null para un resultado válido", () => {
    const result = validateReservationInput({
      sourceMime: "image/jpeg",
      sourceBytes: 1000,
    });
    expect(reservationValidationError(result)).toBeNull();
  });

  it("devuelve el código de error exacto para un resultado inválido", () => {
    const result = validateReservationInput({
      sourceMime: "image/svg+xml",
      sourceBytes: 1000,
    });
    expect(reservationValidationError(result)).toBe("invalid_mime");
  });
});

describe("canTransition — máquina de estados servidor-autoritativa", () => {
  it("permite el camino feliz completo", () => {
    expect(canTransition("reserved", "uploaded")).toBe(true);
    expect(canTransition("uploaded", "verifying")).toBe(true);
    expect(canTransition("verifying", "processing")).toBe(true);
    expect(canTransition("processing", "ready")).toBe(true);
    expect(canTransition("ready", "deleting")).toBe(true);
  });

  it("permite fallar desde cualquier paso de subida/verificación/procesado", () => {
    expect(canTransition("uploaded", "failed")).toBe(true);
    expect(canTransition("verifying", "failed")).toBe(true);
    expect(canTransition("processing", "failed")).toBe(true);
  });

  it("permite reintentar desde failed volviendo a uploaded (nueva verificación, sin nueva reserva)", () => {
    expect(canTransition("failed", "uploaded")).toBe(true);
  });

  it("nunca permite saltarse pasos (p. ej. reserved → ready directo)", () => {
    expect(canTransition("reserved", "ready")).toBe(false);
    expect(canTransition("reserved", "processing")).toBe(false);
    expect(canTransition("uploaded", "ready")).toBe(false);
  });

  it("nunca permite retroceder desde ready salvo a deleting", () => {
    expect(canTransition("ready", "reserved")).toBe(false);
    expect(canTransition("ready", "processing")).toBe(false);
  });

  it("deleting es terminal: ninguna transición sale de él", () => {
    for (const to of [
      "reserved",
      "uploaded",
      "verifying",
      "processing",
      "ready",
      "failed",
      "deleting",
    ] as const) {
      expect(canTransition("deleting", to)).toBe(false);
    }
  });

  it("una transición a sí mismo nunca es válida (idempotencia se corta antes, no aquí)", () => {
    for (const status of [
      "reserved",
      "uploaded",
      "verifying",
      "processing",
      "ready",
      "failed",
      "deleting",
    ] as const) {
      expect(canTransition(status, status)).toBe(false);
    }
  });
});
