import { NO_CLIENT_PRESHRINK_MIME_TYPES, type SourceMimeType } from "./media-domain";

// Optimización de transporte en el navegador (Fase 9I-2, sección 13): política congelada en el
// spike de la Fase 9I. SOLO navegador (createImageBitmap/canvas): nunca se importa desde
// api/ ni desde ningún handler de servidor.

export const PRESHRINK_BYTES_THRESHOLD = 2.5 * 1024 * 1024;
export const PRESHRINK_LONG_EDGE_THRESHOLD = 2560;
export const PRESHRINK_MAX_LONG_EDGE = 4096;
export const PRESHRINK_JPEG_QUALITY = 0.9;

export type TransportStrategy = "original" | "pre-shrink";

export interface TransportDecisionInput {
  mime: string;
  bytes: number;
  /** Lado largo en píxeles, o null si todavía no se conoce (p. ej. el navegador no pudo leer las
   *  dimensiones antes de decidir). Sin dimensiones conocidas, la decisión es SIEMPRE "original"
   *  — nunca se reduce una imagen sin saber cuánto mide. */
  longEdge: number | null;
  /** ¿Están disponibles las APIs de navegador necesarias (createImageBitmap + canvas)? */
  browserCapable: boolean;
}

/** Política exacta de la Fase 9I (sección 13 del checkpoint 9I-2): HEIC/HEIF/AVIF de origen NUNCA
 *  se reducen en el navegador (sin decodificador fiable en <canvas> para esos formatos); el resto
 *  se reduce SOLO si bytes>2.5MB Y lado_largo>2560px Y el navegador puede hacerlo. La velocidad de
 *  red NUNCA es un factor de esta decisión (nunca se degrada calidad porque la conexión sea
 *  lenta). */
export function decideTransportStrategy(
  input: TransportDecisionInput,
): TransportStrategy {
  if (NO_CLIENT_PRESHRINK_MIME_TYPES.has(input.mime as SourceMimeType)) return "original";
  if (!input.browserCapable) return "original";
  if (input.longEdge === null) return "original";
  if (
    input.bytes > PRESHRINK_BYTES_THRESHOLD &&
    input.longEdge > PRESHRINK_LONG_EDGE_THRESHOLD
  ) {
    return "pre-shrink";
  }
  return "original";
}

export function isBrowserPreShrinkCapable(): boolean {
  return (
    typeof createImageBitmap === "function" &&
    typeof document !== "undefined" &&
    typeof document.createElement === "function"
  );
}

export interface PreShrinkResult {
  blob: Blob;
  width: number;
  height: number;
}

/** Reduce `file` a un lado largo máximo de 4096px, codificado como JPEG q0.90, preservando
 *  proporción y SIN agrandar (si ya es más pequeño, scale queda en 1 y las dimensiones no
 *  cambian). Lanza si cualquier paso del navegador falla — quien llama decide el fallback (ver
 *  prepareUploadBlob: UN solo intento, nunca reintenta el pre-shrink). */
export async function preShrinkImage(file: Blob): Promise<PreShrinkResult> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(
      1,
      PRESHRINK_MAX_LONG_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
    const targetHeight = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Contexto 2D de canvas no disponible");
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", PRESHRINK_JPEG_QUALITY),
    );
    if (!blob) throw new Error("canvas.toBlob no produjo ningún blob");

    return { blob, width: targetWidth, height: targetHeight };
  } finally {
    bitmap.close();
  }
}

/** Lee width/height/duración de un vídeo con un <video> oculto apuntando a un blob: URL local —
 *  nunca sube ni transcodifica nada, solo lee metadata que el navegador ya decodificó (Fase 9J-3,
 *  sección 10 del checkpoint: metadata de UX, nunca boundary de seguridad). null si el navegador
 *  no puede leerla (el servidor exige estas dimensiones para reservar un vídeo — ver
 *  media-domain.ts — así que un null aquí termina en un error de reserva claro, nunca en datos
 *  inventados). Vive aquí (no en useMediaUpload.ts) por el mismo motivo que preShrinkImage: es
 *  lectura de DOM/navegador pura, mockeable en tests igual que el resto de este módulo. */
export function readVideoMetadata(
  file: File,
): Promise<{ width: number; height: number; durationSeconds: number | null } | null> {
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    let settled = false;
    function cleanup() {
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    }
    video.onloadedmetadata = () => {
      if (settled) return;
      settled = true;
      const { videoWidth, videoHeight, duration } = video;
      cleanup();
      if (videoWidth > 0 && videoHeight > 0) {
        resolve({
          width: videoWidth,
          height: videoHeight,
          durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
        });
      } else {
        resolve(null);
      }
    };
    video.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    };
    video.src = url;
  });
}

export interface PreparedUpload {
  blob: Blob;
  mime: string;
  bytes: number;
  strategy: TransportStrategy;
  width: number | null;
  height: number | null;
}

/** Orquesta la decisión + el pre-shrink real, con el fallback exacto de la sección 13: si el
 *  pre-shrink fue la estrategia elegida pero falla en tiempo de ejecución, se sube el original
 *  SIN un segundo intento — un fallo de canvas/decodificación nunca bloquea la subida. `deps` es
 *  solo para tests (inyectar un preShrink que falla, o forzar browserCapable sin depender de que
 *  jsdom implemente canvas real). */
export async function prepareUploadBlob(
  file: File,
  dimensions: { width: number; height: number } | null,
  deps: { preShrink?: typeof preShrinkImage; browserCapable?: boolean } = {},
): Promise<PreparedUpload> {
  const preShrink = deps.preShrink ?? preShrinkImage;
  const browserCapable = deps.browserCapable ?? isBrowserPreShrinkCapable();
  const longEdge = dimensions ? Math.max(dimensions.width, dimensions.height) : null;

  const strategy = decideTransportStrategy({
    mime: file.type,
    bytes: file.size,
    longEdge,
    browserCapable,
  });

  if (strategy === "original") {
    return {
      blob: file,
      mime: file.type,
      bytes: file.size,
      strategy: "original",
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    };
  }

  try {
    const shrunk = await preShrink(file);
    return {
      blob: shrunk.blob,
      mime: "image/jpeg",
      bytes: shrunk.blob.size,
      strategy: "pre-shrink",
      width: shrunk.width,
      height: shrunk.height,
    };
  } catch {
    return {
      blob: file,
      mime: file.type,
      bytes: file.size,
      strategy: "original",
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    };
  }
}
