import sharp, { type Sharp } from "sharp";
// libheif-js no publica tipos para su export CJS de alto nivel (index.js; los únicos .d.ts del
// paquete son para el binding wasm de bajo nivel). Se tipa localmente lo mínimo que se usa (ver
// LibheifModule más abajo) en vez de arrastrar `any` por todo el archivo.
// @ts-expect-error — ver comentario de arriba.
import libheifJs from "libheif-js";
import type { FailureCode, SourceMimeType } from "./media-domain.js";
import { qualityForOutputWidth, targetWidthsForLongEdge } from "./media-domain.js";

// Procesador canónico (Fase 9I-2B): SOLO servidor. Decodifica el original (sharp directamente
// para JPEG/PNG/WebP/AVIF; libheif-js → píxeles crudos → sharp para HEIC/HEIF, único camino
// probado en el spike de la Fase 9I) y genera hasta 4 variantes WebP (480/960/1600/2560, nunca
// upscaling). Nunca decide POR SU CUENTA qué hacer con el resultado (subir a R2, actualizar la
// fila) — eso es responsabilidad de media-handlers.ts; este módulo es puro I/O de imagen, sin
// I/O de red ni de base de datos, para poder probarlo con fixtures generadas en memoria.

export class ProcessingFailure extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ProcessingFailure";
  }
}

export interface ProcessedVariant {
  /** Ancho objetivo NOMINAL (480/960/1600/2560) que generó esta variante — el valor que exige
   *  media_asset_variants_variant_check, NUNCA el ancho real de salida. En una foto vertical el
   *  ancho real casi nunca coincide con el nominal (el lado largo es la altura), así que usar
   *  `width` en su lugar viola el CHECK y el procesado entero falla como processing_failed (bug
   *  real, Fase 9I-2C: reproducido con una foto real de 720×888). */
  variant: number;
  width: number;
  height: number;
  bytes: number;
  buffer: Buffer;
}

export interface ProcessingResult {
  variants: ProcessedVariant[];
  sourceWidth: number;
  sourceHeight: number;
}

interface HeifImageLike {
  get_width(): number;
  get_height(): number;
  display(
    target: { data: Uint8ClampedArray; width: number; height: number },
    callback: (result: { data: Uint8ClampedArray } | null) => void,
  ): void;
}

interface HeifDecoderLike {
  decode(buffer: Uint8Array): HeifImageLike[];
}

interface LibheifModule {
  HeifDecoder: new () => HeifDecoderLike;
}

/** Decodifica HEIC/HEIF a píxeles RGBA crudos vía libheif-js, luego los entrega a sharp como
 *  entrada `raw`. Único camino probado en el spike (4/5 ficheros reales; el 5º falló por un
 *  perfil 10-bit/Display-P3 HEVC que el decodificador precompilado no soporta) — cualquier fallo
 *  de decode/display se representa EXPLÍCITAMENTE como heic_unsupported_profile, nunca como un
 *  500 opaco ni una excepción sin tipar. */
async function decodeHeicToSharp(buffer: Buffer): Promise<Sharp> {
  const { HeifDecoder } = libheifJs as unknown as LibheifModule;
  const decoder = new HeifDecoder();

  let images: HeifImageLike[];
  try {
    images = decoder.decode(new Uint8Array(buffer));
  } catch {
    throw new ProcessingFailure(
      "heic_unsupported_profile",
      "El decodificador HEIC no pudo leer el archivo (perfil no soportado)",
    );
  }
  const image = images[0];
  if (!image) {
    throw new ProcessingFailure(
      "heic_unsupported_profile",
      "El archivo HEIC no contiene ninguna imagen decodificable",
    );
  }

  const width = image.get_width();
  const height = image.get_height();
  if (!(width > 0) || !(height > 0)) {
    throw new ProcessingFailure(
      "heic_unsupported_profile",
      "El decodificador HEIC devolvió dimensiones inválidas",
    );
  }

  const rgba: Uint8ClampedArray = await new Promise<Uint8ClampedArray>(
    (resolve, reject) => {
      image.display(
        { data: new Uint8ClampedArray(width * height * 4), width, height },
        (result) => {
          if (!result) {
            reject(new Error("display falló"));
            return;
          }
          resolve(result.data);
        },
      );
    },
  ).catch(() => {
    throw new ProcessingFailure(
      "heic_unsupported_profile",
      "El decodificador HEIC no pudo renderizar los píxeles (perfil no soportado, p. ej. 10-bit/Display-P3 HEVC)",
    );
  });

  return sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), {
    raw: { width, height, channels: 4 },
  });
}

async function decodeToSharp(buffer: Buffer, sourceMime: SourceMimeType): Promise<Sharp> {
  if (sourceMime === "image/heic" || sourceMime === "image/heif") {
    return decodeHeicToSharp(buffer);
  }
  const image = sharp(buffer, { failOn: "error" });
  try {
    // Fuerza a sharp a intentar decodificar de verdad (no solo leer cabeceras) antes de seguir:
    // un AVIF/JPEG/PNG/WebP corrupto o con un perfil que el libvips instalado no soporta falla
    // aquí, no a mitad del resize.
    await image.metadata();
  } catch {
    throw new ProcessingFailure(
      "verification_failed",
      `No se pudo decodificar la imagen de origen (${sourceMime})`,
    );
  }
  return image;
}

/** Pipeline canónico completo (Fase 9I-2, sección 23): normaliza orientación EXIF una vez,
 *  convierte a sRGB, genera cada variante SIN upscaling y codifica a WebP con la calidad
 *  congelada por tamaño. sharp no conserva metadatos salvo que se llame a `.withMetadata()`
 *  (nunca se llama aquí), así que EXIF/ICC/GPS se descartan por defecto en cada salida. */
export async function processImage(
  buffer: Buffer,
  sourceMime: SourceMimeType,
): Promise<ProcessingResult> {
  const decoded = await decodeToSharp(buffer, sourceMime);

  // .rotate() sin argumentos: normaliza según el EXIF Orientation una sola vez y lo descarta.
  // IMPORTANTE: sharp.metadata() siempre describe la entrada, NUNCA el resultado de operaciones
  // encadenadas como .rotate()/.resize() — hay que MATERIALIZAR el reorientado primero (toBuffer)
  // para conocer sus dimensiones reales; leer metadata() sobre el pipeline sin materializar
  // devolvería el ancho/alto ANTES de rotar (bug real, atrapado por
  // media-processing.test.ts al probar una imagen 100×50 con orientation=6).
  const { data: orientedBuffer, info: orientedInfo } = await decoded
    .rotate()
    .toBuffer({ resolveWithObject: true });
  const width = orientedInfo.width;
  const height = orientedInfo.height;
  if (!width || !height) {
    throw new ProcessingFailure(
      "verification_failed",
      "No se pudieron determinar las dimensiones tras normalizar la orientación",
    );
  }
  const oriented = sharp(orientedBuffer);

  const longEdge = Math.max(width, height);
  const targetWidths = targetWidthsForLongEdge(longEdge);
  if (targetWidths.length === 0) {
    throw new ProcessingFailure("verification_failed", "Dimensiones de origen inválidas");
  }

  const variants: ProcessedVariant[] = [];
  for (const targetWidth of targetWidths) {
    const quality = qualityForOutputWidth(targetWidth);
    // "480/960/1600/2560" describe el LADO LARGO (mismo criterio que el pre-shrink de transporte
    // del navegador, Fase 9I sección 13 — "max long edge 4096"), no un ancho literal: mucha
    // fotografía de cosplay es vertical. `fit: "inside"` con width=height=targetWidth define una
    // caja delimitadora cuadrada; sharp encoge preservando proporción hasta que el lado MÁS LARGO
    // quepa en esa caja, sea cual sea el eje. withoutEnlargement evita agrandar si el original ya
    // es más pequeño que el objetivo (no debería ocurrir: targetWidthsForLongEdge ya lo filtra,
    // pero es una segunda barrera real contra el upscaling, no solo una documentada).
    const outputBuffer = await oriented
      .clone()
      .resize({
        width: targetWidth,
        height: targetWidth,
        fit: "inside",
        withoutEnlargement: true,
      })
      .toColorspace("srgb")
      .webp({ quality })
      .toBuffer();
    const outMeta = await sharp(outputBuffer).metadata();
    variants.push({
      variant: targetWidth,
      width: outMeta.width ?? targetWidth,
      height: outMeta.height ?? 0,
      bytes: outputBuffer.length,
      buffer: outputBuffer,
    });
  }

  return { variants, sourceWidth: width, sourceHeight: height };
}
