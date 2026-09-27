// Dominio del pipeline de medios (Fase 9I-2B): funciones PURAS, sin I/O — nada aquí llama a R2,
// Supabase ni al navegador. Compartido entre los handlers de servidor (media-handlers.ts), el
// procesador (media-processing.ts) y sus tests. Genérico a propósito (recibe `domain` como
// parámetro, no hardcodea "cosplay") para que la Fase 9J (Community) pueda reutilizarlo sin
// duplicar esta lógica, igual que media_assets ya es una tabla genérica desde 9I-1.

// ────────────────────────────────────────────────────────────────────────────────────────────
// Tipos de origen aceptados (Fase 9I-2, sección 12): la lista es CERRADA — un mime fuera de aquí
// se rechaza en la reserva, antes de emitir ninguna URL de subida.

export const SOURCE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/avif",
] as const;
export type SourceMimeType = (typeof SOURCE_MIME_TYPES)[number];

export function isSourceMimeType(value: unknown): value is SourceMimeType {
  return (
    typeof value === "string" && (SOURCE_MIME_TYPES as readonly string[]).includes(value)
  );
}

const EXTENSION_FOR_MIME: Record<SourceMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
};

/** Formatos que el spike de transporte (Fase 9I) decidió NUNCA reducir en el navegador: HEIC/HEIF
 *  (sin decodificador fiable en <canvas>) y AVIF de origen (mismo motivo). Se suben tal cual. */
export const NO_CLIENT_PRESHRINK_MIME_TYPES: ReadonlySet<SourceMimeType> = new Set([
  "image/heic",
  "image/heif",
  "image/avif",
]);

// ────────────────────────────────────────────────────────────────────────────────────────────
// Límites V1 (Fase 9I-2, sección 11). Coinciden EXACTAMENTE con los CHECK de
// 20261001120000_cosplay_media_pipeline.sql — si uno cambia, el otro debe cambiar con él.

/** 60 MiB (60 * 1024 * 1024), el techo del ORIGINAL sin normalizar. */
export const MAX_SOURCE_BYTES = 60 * 1024 * 1024;
export const MAX_SOURCE_MEGAPIXELS = 100_000_000;
export const MAX_GALLERY_COUNT = 30;

// ────────────────────────────────────────────────────────────────────────────────────────────
// Transporte: umbral de multipart y tamaño de parte (Fase 9I-2, secciones 16/17).

export const MULTIPART_THRESHOLD_BYTES = 16 * 1024 * 1024;
export const MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024;

export function usesMultipart(sourceBytes: number): boolean {
  return sourceBytes >= MULTIPART_THRESHOLD_BYTES;
}

export function multipartPartCount(sourceBytes: number): number {
  return Math.max(1, Math.ceil(sourceBytes / MULTIPART_PART_SIZE_BYTES));
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Variantes canónicas (Fase 9I-2, sección 23): anchos y calidad JPEG→WebP congelados.

export const VARIANT_WIDTHS = [480, 960, 1600, 2560] as const;
export type VariantWidth = (typeof VARIANT_WIDTHS)[number];

const VARIANT_QUALITY: Record<VariantWidth, number> = {
  480: 80,
  960: 80,
  1600: 82,
  2560: 85,
};

/** Calidad WebP para un ancho de salida. Si `width` no es uno de los 4 anchos nominales (el caso
 *  "original más pequeño que 480px", que produce una única variante a su tamaño nativo), usa la
 *  calidad más alta (85) como valor seguro por defecto — nunca se degrada la única copia pública
 *  disponible de una imagen ya pequeña. */
export function qualityForOutputWidth(width: number): number {
  const nominal = VARIANT_WIDTHS.find((w) => w === width);
  return nominal ? VARIANT_QUALITY[nominal] : 85;
}

/** Anchos objetivo a generar para un original cuyo lado largo mide `longEdge` px: los anchos de
 *  VARIANT_WIDTHS que no lo superan (nunca se hace upscaling). Si `longEdge` es menor que el más
 *  pequeño (480), se genera UNA sola variante al tamaño nativo del original — siempre existe al
 *  menos una variante pública, nunca cero. Nunca lanza; `longEdge` no finito o ≤0 también produce
 *  una lista vacía tratada por quien llama como "nada que generar" (no debería ocurrir: se valida
 *  antes en validateReservationInput/el procesador). */
export function targetWidthsForLongEdge(longEdge: number): number[] {
  if (!Number.isFinite(longEdge) || longEdge <= 0) return [];
  const eligible = VARIANT_WIDTHS.filter((w) => w <= longEdge);
  return eligible.length > 0 ? [...eligible] : [Math.round(longEdge)];
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Claves de objeto R2 (Fase 9I-2, sección 9/15): SIEMPRE generadas por el servidor, nunca a
// partir del nombre de archivo del cliente ni de ningún identificador personal.

export function stagingKey(
  domain: string,
  assetId: string,
  mime: SourceMimeType,
): string {
  return `staging/${domain}/${assetId}/original.${EXTENSION_FOR_MIME[mime]}`;
}

export function privateObjectKey(
  domain: string,
  assetId: string,
  mime: SourceMimeType,
): string {
  return `objects/${domain}/${assetId}/original.${EXTENSION_FOR_MIME[mime]}`;
}

export function publicVariantKey(domain: string, assetId: string, width: number): string {
  return `${domain}/${assetId}/w${width}.webp`;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Validación de la reserva (Fase 9I-2, sección 10/11): lo único que el cliente puede declarar.
// Nunca se confía en una clave de objeto, propiedad del asset o URL pública que el cliente envíe
// (esas nunca son parte de este tipo de entrada).

export interface ReservationInput {
  sourceMime: unknown;
  sourceBytes: unknown;
  sourceWidth?: unknown;
  sourceHeight?: unknown;
}

export interface ValidReservation {
  sourceMime: SourceMimeType;
  sourceBytes: number;
  sourceWidth: number | null;
  sourceHeight: number | null;
}

export type ReservationValidationError =
  | "invalid_mime"
  | "invalid_bytes"
  | "too_large"
  | "invalid_dimensions"
  | "too_many_pixels";

export function validateReservationInput(
  input: ReservationInput,
):
  | { ok: true; value: ValidReservation }
  | { ok: false; error: ReservationValidationError } {
  if (!isSourceMimeType(input.sourceMime)) return { ok: false, error: "invalid_mime" };

  const bytes = input.sourceBytes;
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return { ok: false, error: "invalid_bytes" };
  }
  if (bytes > MAX_SOURCE_BYTES) return { ok: false, error: "too_large" };

  let sourceWidth: number | null = null;
  let sourceHeight: number | null = null;
  const hasWidth = input.sourceWidth !== undefined && input.sourceWidth !== null;
  const hasHeight = input.sourceHeight !== undefined && input.sourceHeight !== null;
  if (hasWidth || hasHeight) {
    if (
      typeof input.sourceWidth !== "number" ||
      typeof input.sourceHeight !== "number" ||
      !Number.isFinite(input.sourceWidth) ||
      !Number.isFinite(input.sourceHeight) ||
      input.sourceWidth <= 0 ||
      input.sourceHeight <= 0
    ) {
      return { ok: false, error: "invalid_dimensions" };
    }
    if (input.sourceWidth * input.sourceHeight > MAX_SOURCE_MEGAPIXELS) {
      return { ok: false, error: "too_many_pixels" };
    }
    sourceWidth = input.sourceWidth;
    sourceHeight = input.sourceHeight;
  }

  return {
    ok: true,
    value: {
      sourceMime: input.sourceMime,
      sourceBytes: bytes,
      sourceWidth,
      sourceHeight,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Códigos de fallo (Fase 9I-2, sección 24/35): deben coincidir EXACTAMENTE con
// media_assets_failure_code_check de la migración.

export const FAILURE_CODES = [
  "mime_mismatch",
  "too_large",
  "too_many_pixels",
  "heic_unsupported_profile",
  "upload_incomplete",
  "verification_failed",
  "processing_failed",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

// ────────────────────────────────────────────────────────────────────────────────────────────
// Máquina de estados servidor-autoritativa (Fase 9I-2, sección 20). "uploading" es deliberadamente
// un estado SOLO de cliente (ver la migración): no aparece aquí porque el servidor nunca lo
// observa. `failed` puede reintentarse volviendo a `uploaded` (nueva verificación) sin crear una
// reserva nueva, o cerrarse con `deleting` (limpieza).

export const MEDIA_ASSET_STATUSES = [
  "reserved",
  "uploaded",
  "verifying",
  "processing",
  "ready",
  "failed",
  "deleting",
] as const;
export type MediaAssetStatus = (typeof MEDIA_ASSET_STATUSES)[number];

const ALLOWED_TRANSITIONS: Readonly<
  Record<MediaAssetStatus, readonly MediaAssetStatus[]>
> = {
  reserved: ["uploaded", "deleting"],
  uploaded: ["verifying", "failed", "deleting"],
  verifying: ["processing", "failed", "deleting"],
  processing: ["ready", "failed", "deleting"],
  ready: ["deleting"],
  failed: ["uploaded", "deleting"],
  deleting: [],
};

/** ¿Es válida la transición `from` → `to`? Idéntica en servidor y en tests: ninguna otra ruta de
 *  código decide esto por su cuenta. `from === to` nunca es válido (una transición real cambia de
 *  estado; una operación idempotente se corta ANTES de llamar a esto, comprobando el estado
 *  actual). */
export function canTransition(from: MediaAssetStatus, to: MediaAssetStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
