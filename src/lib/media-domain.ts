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

// ────────────────────────────────────────────────────────────────────────────────────────────
// Vídeo (Fase 9J-3): lista CERRADA de contenedores soportados — igual que SOURCE_MIME_TYPES, un
// mime fuera de aquí se rechaza en la reserva. SOLO domain='community' puede usar kind='video'
// (ver media-handlers.ts authorizeForDomain/SUPPORTED_VIDEO_DOMAINS); Cosplay sigue siendo
// exclusivamente imagen — esta lista no cambia esa regla por sí sola, es la capa de MIME.
// "video/quicktime" es el mime real que los navegadores/SO declaran para archivos .mov.

export const VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
export type VideoMimeType = (typeof VIDEO_MIME_TYPES)[number];

export function isVideoMimeType(value: unknown): value is VideoMimeType {
  return (
    typeof value === "string" && (VIDEO_MIME_TYPES as readonly string[]).includes(value)
  );
}

export const MEDIA_KINDS = ["image", "video"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export function isMediaKind(value: unknown): value is MediaKind {
  return typeof value === "string" && (MEDIA_KINDS as readonly string[]).includes(value);
}

/** Unión de todo mime de ORIGEN aceptado (imagen o vídeo) — usada por stagingKey/privateObjectKey,
 *  que son agnósticas de kind (solo necesitan la extensión correcta para la clave de R2). */
export type AnySourceMimeType = SourceMimeType | VideoMimeType;

export function isAnySourceMimeType(value: unknown): value is AnySourceMimeType {
  return isSourceMimeType(value) || isVideoMimeType(value);
}

const EXTENSION_FOR_MIME: Record<AnySourceMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
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

/** 60 MiB (60 * 1024 * 1024), el techo del ORIGINAL sin normalizar (imagen). */
export const MAX_SOURCE_BYTES = 60 * 1024 * 1024;
export const MAX_SOURCE_MEGAPIXELS = 100_000_000;
export const MAX_GALLERY_COUNT = 30;

/** 100 MiB (100 * 1024 * 1024): techo del vídeo original (Fase 9J-3, sección 3 del checkpoint —
 *  "Maximum video file size: 100 MB"). Sin transcodificación: el vídeo se sirve TAL CUAL hasta
 *  este tamaño, nunca comprimido server-side. Coincide con media_assets_source_bytes_check /
 *  media_assets_bytes_check de la migración 20261006120000. */
export const MAX_VIDEO_SOURCE_BYTES = 100 * 1024 * 1024;

/** Máximo 1 vídeo por publicación de Comunidad (Fase 9J-3, sección 2 del checkpoint), dentro del
 *  máximo existente de 10 media totales (sin cambios, ver community_post_save). */
export const MAX_COMMUNITY_VIDEOS_PER_POST = 1;

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
  mime: AnySourceMimeType,
): string {
  return `staging/${domain}/${assetId}/original.${EXTENSION_FOR_MIME[mime]}`;
}

export function privateObjectKey(
  domain: string,
  assetId: string,
  mime: AnySourceMimeType,
): string {
  return `objects/${domain}/${assetId}/original.${EXTENSION_FOR_MIME[mime]}`;
}

export function publicVariantKey(domain: string, assetId: string, width: number): string {
  return `${domain}/${assetId}/w${width}.webp`;
}

/** Clave pública del vídeo original (Fase 9J-3): sin variantes de ancho — a diferencia de
 *  publicVariantKey (4 tamaños WebP por imagen), un vídeo tiene UN solo objeto público, con la
 *  MISMA extensión que su mime de origen (nunca .webp). */
export function publicVideoKey(
  domain: string,
  assetId: string,
  mime: VideoMimeType,
): string {
  return `${domain}/${assetId}/original.${EXTENSION_FOR_MIME[mime]}`;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Validación de la reserva (Fase 9I-2, sección 10/11): lo único que el cliente puede declarar.
// Nunca se confía en una clave de objeto, propiedad del asset o URL pública que el cliente envíe
// (esas nunca son parte de este tipo de entrada).

export interface ReservationInput {
  /** "image" (por defecto si se omite, para no romper a Cosplay — que nunca envía kind) o
   *  "video" (Fase 9J-3, solo domain='community'). */
  kind?: unknown;
  sourceMime: unknown;
  sourceBytes: unknown;
  sourceWidth?: unknown;
  sourceHeight?: unknown;
  /** SOLO vídeo, opcional, nunca boundary de seguridad (sección 10 del checkpoint 9J-3) — ver
   *  media_assets.duration_seconds. */
  sourceDurationSeconds?: unknown;
}

export interface ValidReservation {
  kind: MediaKind;
  sourceMime: AnySourceMimeType;
  sourceBytes: number;
  sourceWidth: number | null;
  sourceHeight: number | null;
  sourceDurationSeconds: number | null;
}

export type ReservationValidationError =
  | "invalid_kind"
  | "invalid_mime"
  | "invalid_bytes"
  | "too_large"
  | "invalid_dimensions"
  | "too_many_pixels"
  | "invalid_duration";

/** Valida la reserva de un asset de imagen O vídeo (Fase 9J-3 amplió esta función, antes
 *  solo-imagen, en vez de crear una segunda función paralela — un mismo punto de validación para
 *  ambos kind, cada uno con su propia lista de mimes/techo de bytes). `kind` ausente se trata como
 *  "image" (compatibilidad hacia atrás: Cosplay y el flujo de imagen de Comunidad nunca lo
 *  enviaban antes de 9J-3). Las dimensiones son OPCIONALES para imagen (sin cambio de
 *  comportamiento) pero OBLIGATORIAS para vídeo: el servidor nunca decodifica el vídeo (sección 6
 *  del checkpoint: sin FFmpeg/transcodificación), así que width/height solo pueden venir del
 *  navegador de origen en el momento de la reserva — sin ellas, un vídeo 'ready' no podría cumplir
 *  el invariante existente "campos canónicos juntos o ninguno" (media_assets_canonical_fields_together). */
export function validateReservationInput(
  input: ReservationInput,
):
  | { ok: true; value: ValidReservation }
  | { ok: false; error: ReservationValidationError } {
  const kind: MediaKind =
    input.kind === undefined || input.kind === null ? "image" : (input.kind as MediaKind);
  if (!isMediaKind(kind)) return { ok: false, error: "invalid_kind" };

  if (kind === "video") {
    if (!isVideoMimeType(input.sourceMime)) return { ok: false, error: "invalid_mime" };
  } else if (!isSourceMimeType(input.sourceMime)) {
    return { ok: false, error: "invalid_mime" };
  }

  const bytes = input.sourceBytes;
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return { ok: false, error: "invalid_bytes" };
  }
  const maxBytes = kind === "video" ? MAX_VIDEO_SOURCE_BYTES : MAX_SOURCE_BYTES;
  if (bytes > maxBytes) return { ok: false, error: "too_large" };

  let sourceWidth: number | null = null;
  let sourceHeight: number | null = null;
  const hasWidth = input.sourceWidth !== undefined && input.sourceWidth !== null;
  const hasHeight = input.sourceHeight !== undefined && input.sourceHeight !== null;
  if (kind === "video" && (!hasWidth || !hasHeight)) {
    return { ok: false, error: "invalid_dimensions" };
  }
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
    if (
      kind === "image" &&
      input.sourceWidth * input.sourceHeight > MAX_SOURCE_MEGAPIXELS
    ) {
      return { ok: false, error: "too_many_pixels" };
    }
    sourceWidth = input.sourceWidth;
    sourceHeight = input.sourceHeight;
  }

  let sourceDurationSeconds: number | null = null;
  const hasDuration =
    input.sourceDurationSeconds !== undefined && input.sourceDurationSeconds !== null;
  if (hasDuration) {
    if (
      typeof input.sourceDurationSeconds !== "number" ||
      !Number.isFinite(input.sourceDurationSeconds) ||
      input.sourceDurationSeconds <= 0
    ) {
      return { ok: false, error: "invalid_duration" };
    }
    sourceDurationSeconds = input.sourceDurationSeconds;
  }

  return {
    ok: true,
    value: {
      kind,
      sourceMime: input.sourceMime as AnySourceMimeType,
      sourceBytes: bytes,
      sourceWidth,
      sourceHeight,
      sourceDurationSeconds,
    },
  };
}

/** Código de error de un resultado ya evaluado de validateReservationInput, o null si fue válido.
 *  Tipo de retorno explícito: el llamador no depende de que el compilador conserve el
 *  estrechamiento del discriminante `ok` más allá de esta función (mismo patrón que
 *  instagramProductType en public-snapshot-resources.ts). Estrechamiento por existencia de la
 *  propiedad `error` (no por el valor booleano de `ok`): más robusto frente a la compilación
 *  aislada por función de Vercel (@vercel/node), que no conservó el estrechamiento por `ok`. */
export function reservationValidationError(
  result: ReturnType<typeof validateReservationInput>,
): ReservationValidationError | null {
  if ("error" in result) return result.error;
  return null;
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
