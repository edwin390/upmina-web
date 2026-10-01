import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { ProcessingFailure, processImage } from "./media-processing";

// Procesador canónico (Fase 9I-2B): fixtures generadas EN MEMORIA con sharp — nunca se comete un
// archivo de imagen real al repositorio (sección 39 del checkpoint). Cada test genera exactamente
// el píxel que necesita y lo descarta.

async function makeJpeg(
  width: number,
  height: number,
  orientation?: number,
): Promise<Buffer> {
  const image = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } },
  }).jpeg();
  if (orientation !== undefined) {
    return image.withMetadata({ orientation }).toBuffer();
  }
  return image.toBuffer();
}

async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 10, g: 200, b: 10, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

async function makeWebp(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 10, b: 200 } },
  })
    .webp()
    .toBuffer();
}

describe("processImage — formatos de origen", () => {
  it("decodifica JPEG y produce al menos una variante WebP", async () => {
    const result = await processImage(await makeJpeg(3000, 2000), "image/jpeg");
    expect(result.sourceWidth).toBe(3000);
    expect(result.sourceHeight).toBe(2000);
    expect(result.variants.length).toBeGreaterThan(0);
    for (const variant of result.variants) {
      const meta = await sharp(variant.buffer).metadata();
      expect(meta.format).toBe("webp");
    }
  });

  it("decodifica PNG", async () => {
    const result = await processImage(await makePng(1000, 1000), "image/png");
    expect(result.variants.length).toBeGreaterThan(0);
  });

  it("decodifica WebP de origen", async () => {
    const result = await processImage(await makeWebp(1000, 800), "image/webp");
    expect(result.variants.length).toBeGreaterThan(0);
  });

  it("un origen ilegible (bytes no válidos) falla como verification_failed, nunca opaco", async () => {
    const garbage = Buffer.from("esto no es una imagen de verdad");
    await expect(processImage(garbage, "image/jpeg")).rejects.toMatchObject({
      code: "verification_failed",
    });
    await expect(processImage(garbage, "image/jpeg")).rejects.toBeInstanceOf(
      ProcessingFailure,
    );
  });
});

describe("processImage — variantes: anchos, calidad, nunca upscaling", () => {
  it.each([
    [468, 428],
    [428, 468],
    [480, 320],
    [700, 500],
    [4000, 3000],
    [1, 1],
  ])(
    "9J-FIX4: %i×%i respeta el dominio SQL nominal sin enlargement",
    async (width, height) => {
      const schema = readFileSync(
        "supabase/migrations/20261001120000_cosplay_media_pipeline.sql",
        "utf8",
      );
      const match = schema.match(
        /media_asset_variants_variant_check\s+check\s*\(variant in \(([^)]+)\)\)/,
      );
      expect(match).not.toBeNull();
      const allowed = match![1]!.split(",").map(Number);
      const result = await processImage(await makeJpeg(width, height), "image/jpeg");
      expect(result.variants.map((row) => row.variant)).toEqual(
        Math.max(width, height) >= 2560 ? [480, 960, 1600, 2560] : [480],
      );
      for (const row of result.variants) {
        expect(allowed).toContain(row.variant);
        expect(row.width).toBeLessThanOrEqual(width);
        expect(row.height).toBeLessThanOrEqual(height);
        expect(row.bytes).toBeGreaterThan(0);
        expect(row.bytes).toBeLessThanOrEqual(8388608);
      }
      if (Math.max(width, height) <= 480) {
        expect(result.variants[0]).toMatchObject({ variant: 480, width, height });
      }
    },
  );
  it("original grande (lado largo ≥2560): genera las 4 variantes, cada una ≤ su ancho nominal", async () => {
    const result = await processImage(await makeJpeg(4000, 3000), "image/jpeg");
    const widths = result.variants.map((v) => v.width).sort((a, b) => a - b);
    expect(widths).toEqual([480, 960, 1600, 2560]);
  });

  it("original pequeño (lado largo < 480): UNA sola variante, sin agrandar", async () => {
    const result = await processImage(await makeJpeg(300, 200), "image/jpeg");
    expect(result.variants).toHaveLength(1);
    // El lado largo real (300) nunca se agranda a 480.
    expect(
      Math.max(result.variants[0]!.width, result.variants[0]!.height),
    ).toBeLessThanOrEqual(300);
  });

  it("imagen VERTICAL (retrato): el lado largo es la ALTURA, no el ancho — nunca se distorsiona", async () => {
    // 1000×2000: lado largo = 2000 (altura). targetWidthsForLongEdge(2000) → [480, 960, 1600].
    const result = await processImage(await makeJpeg(1000, 2000), "image/jpeg");
    for (const variant of result.variants) {
      // La proporción original es 1:2 (ancho:alto); debe conservarse en cada variante.
      const ratio = variant.width / variant.height;
      expect(ratio).toBeCloseTo(1000 / 2000, 1);
      // El lado LARGO (la altura, en una foto vertical) es el que coincide con el ancho nominal.
      expect(Math.max(variant.width, variant.height)).toBeLessThanOrEqual(1600);
    }
  });

  it("imagen VERTICAL: `variant` (nominal) NUNCA es el ancho real — regresión real de la Fase 9I-2C", async () => {
    // Bug real: media-handlers.ts usaba el ANCHO REAL de salida como valor de la columna
    // media_asset_variants.variant (CHECK IN (480,960,1600,2560)), en vez del ancho NOMINAL que
    // generó cada variante. En una foto vertical el ancho real casi nunca coincide con el nominal
    // (aquí: 1000×2000 escalado a la caja 480×480 da un ancho real de 240, no 480), así que este
    // caso lo habría atrapado desde el principio si processImage() hubiera expuesto `variant`.
    const result = await processImage(await makeJpeg(1000, 2000), "image/jpeg");
    const nominals = result.variants.map((v) => v.variant).sort((a, b) => a - b);
    expect(nominals).toEqual([480, 960, 1600]);
    for (const variant of result.variants) {
      expect(variant.width).not.toBe(variant.variant);
    }
  });

  it("nunca upscaling: ninguna variante supera las dimensiones del original ya reorientado", async () => {
    const result = await processImage(await makeJpeg(700, 500), "image/jpeg");
    for (const variant of result.variants) {
      expect(variant.width).toBeLessThanOrEqual(700);
      expect(variant.height).toBeLessThanOrEqual(500);
    }
  });
});

describe("processImage — orientación EXIF y metadatos", () => {
  it("normaliza la orientación EXIF una vez: una imagen 100×50 con orientation=6 termina como 50×100", async () => {
    const rotated = await makeJpeg(100, 50, 6);
    const result = await processImage(rotated, "image/jpeg");
    // Tras auto-rotar según EXIF orientation=6 (90° CW), las dimensiones físicas se intercambian.
    expect(result.sourceWidth).toBe(50);
    expect(result.sourceHeight).toBe(100);
  });

  it("las variantes de salida no llevan EXIF/orientación (sharp las descarta por defecto)", async () => {
    const rotated = await makeJpeg(200, 100, 6);
    const result = await processImage(rotated, "image/jpeg");
    for (const variant of result.variants) {
      const meta = await sharp(variant.buffer).metadata();
      expect(meta.orientation).toBeUndefined();
      expect(meta.exif).toBeUndefined();
    }
  });

  it("las variantes de salida están en sRGB", async () => {
    const result = await processImage(await makeJpeg(600, 400), "image/jpeg");
    for (const variant of result.variants) {
      const meta = await sharp(variant.buffer).metadata();
      expect(meta.space).toBe("srgb");
    }
  });
});

describe("processImage — HEIC (sección 24 del checkpoint)", () => {
  it("un HEIC ilegible/no soportado falla como heic_unsupported_profile, preservando el original (no se borra nada aquí: el procesador no toca R2)", async () => {
    // Sin un fixture HEIC real legal disponible en este entorno, se prueba la ruta de fallo real:
    // libheif-js SIEMPRE rechaza bytes que no son un contenedor HEIF válido, exactamente el mismo
    // camino de código que un perfil real no soportado (ver el 5º caso del spike de la Fase 9I).
    const garbage = Buffer.from("no es un heic válido, ni de broma");
    await expect(processImage(garbage, "image/heic")).rejects.toMatchObject({
      code: "heic_unsupported_profile",
    });
    await expect(processImage(garbage, "image/heic")).rejects.toBeInstanceOf(
      ProcessingFailure,
    );
  });

  it("HEIF (mismo decodificador que HEIC) también falla explícito, nunca opaco, ante bytes inválidos", async () => {
    const garbage = Buffer.from("tampoco es un heif válido");
    await expect(processImage(garbage, "image/heif")).rejects.toMatchObject({
      code: "heic_unsupported_profile",
    });
  });
});
