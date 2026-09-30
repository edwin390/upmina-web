import { useCallback, useRef, useState } from "react";
import {
  abortMediaUpload,
  completeMediaUpload,
  MediaClientError,
  reserveMediaUpload,
  uploadWithProgress,
  type MediaVariantResult,
  type MediaVideoResult,
} from "@/lib/media-client";
import {
  prepareUploadBlob,
  readVideoMetadata,
  type PreparedUpload,
} from "@/lib/media-transport";
import { isMobileUploadDevice } from "@/lib/media-device";
import type { PrivilegedFailure } from "@/lib/privileged-response";

// Cola de subida de medios (Fase 9I-2B): reutilizable por el arnés de desarrollo (harness) de
// esta fase y, más adelante, por el editor ADMIN real de la Fase 9I-3 — es deliberadamente
// genérica (no conoce Cosplay, solo domain="cosplay" como parámetro) para no tener que
// reescribirse en 9I-3. NO es el editor: solo la cola de subida/procesado por archivo.

export type MediaItemStatus =
  "queued" | "preparing" | "uploading" | "uploaded" | "processing" | "ready" | "failed";

/** "image" o "video" (Fase 9J-3), detectado del MIME real del archivo (file.type) — nunca de la
 *  extensión del nombre ni de lo que el picker "accept" sugiera. Un archivo cuyo MIME no empieza
 *  por "image/" ni "video/" nunca entra en la cola (ver detectMediaKind: se rechaza ANTES de
 *  reservar nada, con errorCode "unsupported_type"). */
export type MediaKind = "image" | "video";

export interface MediaQueueItem {
  localId: string;
  /** Solo para mostrarse en ESTE navegador — nunca viaja al servidor ni entra en ninguna clave
   *  de objeto (esas las genera el servidor, ver media-domain.ts stagingKey/publicVariantKey). */
  fileName: string;
  kind: MediaKind;
  sourceBytes: number;
  status: MediaItemStatus;
  transportStrategy: "original" | "pre-shrink" | null;
  transportBytes: number | null;
  /** 0-100, o null antes de conocerse. Nunca se inventa: solo se calcula tras decidir transporte. */
  percentSaved: number | null;
  uploadedBytes: number;
  totalUploadBytes: number;
  assetId: string | null;
  variants: MediaVariantResult[] | null;
  /** Resultado 'ready' de vídeo (Fase 9J-3): null para imagen, o mientras no esté listo. */
  video: MediaVideoResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Clasificación 9G-3 (ver privileged-response.ts) del rechazo, si lo hubo. Solo
   *  "step_up_required" debe iniciar un flujo de MFA — la página que use este hook decide qué
   *  hacer; este hook nunca navega (es genérico, sin dependencia de react-router). */
  privilegedFailure: PrivilegedFailure | null;
}

interface InternalItem {
  file: File;
  aborted: boolean;
}

export interface ConcurrencyOptions {
  prepare: number;
  upload: number;
}

/** Concurrencia inicial (Fase 9I-2, sección 14): puede afinarse tras pruebas reales en
 *  dispositivo — hoy son las cifras congeladas por el checkpoint, no medidas todavía. */
export const DESKTOP_CONCURRENCY: ConcurrencyOptions = { prepare: 2, upload: 3 };
export const MOBILE_CONCURRENCY: ConcurrencyOptions = { prepare: 1, upload: 2 };

function createLimiter(concurrency: number) {
  let active = 0;
  const pending: (() => void)[] = [];
  function schedule() {
    if (active >= concurrency || pending.length === 0) return;
    active += 1;
    const run = pending.shift();
    run?.();
  }
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      pending.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            schedule();
          });
      });
      schedule();
    });
  };
}

function readImageDimensions(
  file: File,
): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== "function") return Promise.resolve(null);
  return createImageBitmap(file)
    .then((bitmap) => {
      const dims = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return dims;
    })
    .catch(() => null);
}

/** "image" o "video" según el MIME REAL del archivo (file.type) — nunca la extensión del nombre.
 *  null = ni uno ni otro (rechazado antes de reservar nada). El servidor sigue siendo la
 *  autoridad final sobre qué mime concreto es válido (media-domain.ts validateReservationInput);
 *  esto solo decide QUÉ RAMA de preparación seguir en el navegador. */
function detectMediaKind(file: File): MediaKind | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  return null;
}

function failureFromError(err: unknown): { code: string | null; message: string } {
  if (err instanceof MediaClientError) {
    return { code: err.code ?? null, message: err.message };
  }
  return { code: null, message: "Error inesperado" };
}

export interface UseMediaUploadOptions {
  domain: string;
  concurrency?: ConcurrencyOptions;
}

export function useMediaUpload({ domain, concurrency }: UseMediaUploadOptions) {
  // Se resuelve UNA sola vez por instancia del hook (ref, no state): la concurrencia de un lote de
  // subida ya en curso no debe cambiar a mitad de camino solo porque el viewport se redimensionó.
  // Un `concurrency` explícito del caller siempre gana sobre la detección automática.
  const resolvedConcurrency = useRef(
    concurrency ?? (isMobileUploadDevice() ? MOBILE_CONCURRENCY : DESKTOP_CONCURRENCY),
  ).current;
  const [items, setItems] = useState<MediaQueueItem[]>([]);
  const internal = useRef(new Map<string, InternalItem>());
  const prepLimiter = useRef(createLimiter(resolvedConcurrency.prepare)).current;
  const uploadLimiter = useRef(createLimiter(resolvedConcurrency.upload)).current;

  const patch = useCallback((localId: string, patchValue: Partial<MediaQueueItem>) => {
    setItems((prev) =>
      prev.map((item) => (item.localId === localId ? { ...item, ...patchValue } : item)),
    );
  }, []);

  const runItem = useCallback(
    async (localId: string) => {
      const entry = internal.current.get(localId);
      if (!entry || entry.aborted) return;
      const { file } = entry;

      const kind = detectMediaKind(file);
      if (!kind) {
        patch(localId, {
          status: "failed",
          errorCode: "unsupported_type",
          errorMessage: "Tipo de archivo no compatible",
        });
        return;
      }

      try {
        patch(localId, { status: "preparing" });

        // Vídeo (Fase 9J-3): nunca pasa por el pre-shrink de imagen (createImageBitmap no puede
        // decodificar un vídeo) — sus dimensiones/duración se leen con un <video> oculto, y el
        // "prepared" se construye directamente con strategy "original" (el vídeo se sube TAL CUAL,
        // sin transcodificación, ver media-handlers.ts).
        let prepared: PreparedUpload;
        let durationSeconds: number | null = null;
        if (kind === "video") {
          const meta = await prepLimiter(() => readVideoMetadata(file));
          if (entry.aborted) return;
          durationSeconds = meta?.durationSeconds ?? null;
          prepared = {
            blob: file,
            mime: file.type,
            bytes: file.size,
            strategy: "original",
            width: meta?.width ?? null,
            height: meta?.height ?? null,
          };
        } else {
          const dimensions = await prepLimiter(() => readImageDimensions(file));
          if (entry.aborted) return;
          prepared = await prepLimiter(() => prepareUploadBlob(file, dimensions));
        }
        if (entry.aborted) return;

        const percentSaved =
          prepared.strategy === "pre-shrink"
            ? Math.max(0, Math.round((1 - prepared.bytes / file.size) * 100))
            : null;
        patch(localId, {
          transportStrategy: prepared.strategy,
          transportBytes: prepared.bytes,
          percentSaved,
        });

        await uploadLimiter(async () => {
          if (entry.aborted) return;
          patch(localId, {
            status: "uploading",
            totalUploadBytes: prepared.bytes,
            uploadedBytes: 0,
          });

          const reservation = await reserveMediaUpload({
            domain,
            kind,
            sourceMime: prepared.mime,
            sourceBytes: prepared.bytes,
            sourceWidth: prepared.width ?? undefined,
            sourceHeight: prepared.height ?? undefined,
            sourceDurationSeconds: durationSeconds ?? undefined,
          });
          if (entry.aborted) {
            await abortMediaUpload(reservation.assetId).catch(() => undefined);
            return;
          }
          patch(localId, { assetId: reservation.assetId });

          if (reservation.mode === "single") {
            await uploadWithProgress(
              reservation.uploadUrl,
              prepared.blob,
              prepared.mime,
              (loaded) => patch(localId, { uploadedBytes: loaded }),
            );
            patch(localId, { status: "uploaded" });
            const result = await completeMediaUpload({ assetId: reservation.assetId });
            applyCompleteResult(localId, result);
            return;
          }

          const partSize = reservation.partSize;
          const parts: { partNumber: number; etag: string }[] = [];
          let uploadedSoFar = 0;
          for (const part of reservation.parts) {
            if (entry.aborted) return;
            const start = (part.partNumber - 1) * partSize;
            const end = Math.min(start + partSize, prepared.blob.size);
            const chunk = prepared.blob.slice(start, end);
            const { etag } = await uploadWithProgress(
              part.url,
              chunk,
              prepared.mime,
              (loaded) => patch(localId, { uploadedBytes: uploadedSoFar + loaded }),
            );
            uploadedSoFar += chunk.size;
            patch(localId, { uploadedBytes: uploadedSoFar });
            if (!etag) throw new MediaClientError("R2 no devolvió ETag para una parte");
            parts.push({ partNumber: part.partNumber, etag });
          }
          patch(localId, { status: "uploaded" });
          const result = await completeMediaUpload({
            assetId: reservation.assetId,
            parts,
          });
          applyCompleteResult(localId, result);
        });
      } catch (err) {
        const { code, message } = failureFromError(err);
        const privilegedFailure =
          err instanceof MediaClientError ? err.privilegedFailure : null;
        patch(localId, {
          status: "failed",
          errorCode: code,
          errorMessage: message,
          privilegedFailure,
        });
      }

      function applyCompleteResult(
        id: string,
        result: Awaited<ReturnType<typeof completeMediaUpload>>,
      ) {
        if (result.status === "ready" && result.kind === "video") {
          patch(id, {
            status: "ready",
            video: {
              kind: "video",
              url: result.url,
              width: result.width,
              height: result.height,
              bytes: result.bytes,
              durationSeconds: result.durationSeconds,
            },
          });
        } else if (result.status === "ready") {
          patch(id, { status: "ready", variants: result.variants });
        } else if (result.status === "failed") {
          patch(id, {
            status: "failed",
            errorCode: result.failureCode,
            errorMessage: "El procesado no pudo completarse",
          });
        } else {
          patch(id, { status: "processing" });
        }
      }
    },
    [domain, patch, prepLimiter, uploadLimiter],
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      const newItems: MediaQueueItem[] = list.map((file) => {
        const localId =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        internal.current.set(localId, { file, aborted: false });
        return {
          localId,
          fileName: file.name,
          kind: detectMediaKind(file) ?? "image",
          sourceBytes: file.size,
          status: "queued",
          transportStrategy: null,
          transportBytes: null,
          percentSaved: null,
          uploadedBytes: 0,
          totalUploadBytes: file.size,
          assetId: null,
          variants: null,
          video: null,
          errorCode: null,
          errorMessage: null,
          privilegedFailure: null,
        };
      });
      setItems((prev) => [...prev, ...newItems]);
      for (const item of newItems) void runItem(item.localId);
      return newItems.map((i) => i.localId);
    },
    [runItem],
  );

  const retry = useCallback(
    (localId: string) => {
      const entry = internal.current.get(localId);
      if (!entry) return;
      entry.aborted = false;
      patch(localId, {
        status: "queued",
        errorCode: null,
        errorMessage: null,
        privilegedFailure: null,
        uploadedBytes: 0,
      });
      void runItem(localId);
    },
    [patch, runItem],
  );

  const remove = useCallback((localId: string) => {
    const entry = internal.current.get(localId);
    if (entry) {
      entry.aborted = true;
      const assetId = itemsRefAssetId(localId);
      if (assetId) void abortMediaUpload(assetId).catch(() => undefined);
    }
    internal.current.delete(localId);
    setItems((prev) => prev.filter((item) => item.localId !== localId));
  }, []);

  // Lee el assetId actual sin depender del closure de `items` (evita reconstruir `remove` en cada
  // cambio de estado).
  const itemsRef = useRef<MediaQueueItem[]>([]);
  itemsRef.current = items;
  function itemsRefAssetId(localId: string): string | null {
    return itemsRef.current.find((i) => i.localId === localId)?.assetId ?? null;
  }

  return { items, addFiles, retry, remove };
}
