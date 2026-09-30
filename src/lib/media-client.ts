import { supabase } from "@/lib/supabase";
import {
  classifyPrivilegedFailure,
  type PrivilegedFailure,
} from "@/lib/privileged-response";

// Cliente del pipeline de medios (Fase 9I-2B): SOLO navegador. Igual que fetchAdminAccess
// (admin-access.ts), lee el access token VIGENTE de Supabase en cada llamada (nunca lo guarda) y
// lo manda como Bearer — nunca envía datos del cliente como autoridad (el backend vuelve a
// comprobar ADMIN + cosplay_admin + MFA reciente en cada request, ver media-handlers.ts).

export class MediaClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    /** Clasificación canónica (Fase 9G-3, ver privileged-response.ts) de un rechazo 401/403 —
     *  MISMA semántica que ya usan las secciones de /admin, reutilizada aquí en vez de que este
     *  cliente invente su propia lectura de `code`. Solo "step_up_required" debe iniciar MFA;
     *  "forbidden"/"unauthenticated" nunca lo hacen (MFA no concede capacidad). */
    readonly privilegedFailure: PrivilegedFailure | null = null,
  ) {
    super(message);
    this.name = "MediaClientError";
  }
}

async function authHeader(): Promise<string> {
  if (!supabase) throw new MediaClientError("Supabase no configurado");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new MediaClientError("Sin sesión", 401);
  return `Bearer ${token}`;
}

async function postJson<T>(
  resource: "reserve" | "complete" | "abort",
  body: unknown,
): Promise<T> {
  const auth = await authHeader();
  let response: Response;
  try {
    response = await fetch(`/api/media/${resource}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(body),
    });
  } catch {
    throw new MediaClientError("Fallo de red");
  }

  // Clasifica ANTES de leer el cuerpo con la copia propia más abajo: clone() falla si el body ya
  // se consumió. classifyPrivilegedFailure nunca reintenta ni ejecuta nada, solo lee.
  const privilegedFailure = !response.ok
    ? await classifyPrivilegedFailure(response.clone())
    : null;

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // sin cuerpo o no es JSON: se trata como error genérico más abajo si !response.ok
  }

  if (!response.ok) {
    const errBody = json as { error?: string; code?: string } | null;
    throw new MediaClientError(
      errBody?.error ?? "Error del servidor",
      response.status,
      errBody?.code,
      privilegedFailure,
    );
  }
  return json as T;
}

export interface ReservePart {
  partNumber: number;
  url: string;
}

export type ReserveResponse =
  | { assetId: string; mode: "single"; uploadUrl: string; expiresInSeconds: number }
  | {
      assetId: string;
      mode: "multipart";
      uploadId: string;
      partSize: number;
      parts: ReservePart[];
      expiresInSeconds: number;
    };

export function reserveMediaUpload(input: {
  domain: string;
  /** "image" (por defecto si se omite) o "video" (Fase 9J-3, solo domain="community"). */
  kind?: "image" | "video";
  sourceMime: string;
  sourceBytes: number;
  sourceWidth?: number;
  sourceHeight?: number;
  /** SOLO vídeo, opcional, nunca boundary de seguridad — ver media-domain.ts. */
  sourceDurationSeconds?: number;
}): Promise<ReserveResponse> {
  return postJson<ReserveResponse>("reserve", input);
}

export interface MediaVariantResult {
  variant: number;
  width: number;
  height: number;
  bytes: number;
  url: string;
}

/** Resultado 'ready' de un vídeo (Fase 9J-3): un único objeto público, sin variantes — a
 *  diferencia de imagen (hasta 4 tamaños WebP). */
export interface MediaVideoResult {
  kind: "video";
  url: string;
  width: number;
  height: number;
  bytes: number;
  durationSeconds: number | null;
}

export type CompleteResponse =
  | { assetId: string; status: "ready"; kind: "image"; variants: MediaVariantResult[] }
  | ({ assetId: string; status: "ready" } & MediaVideoResult)
  | { assetId: string; status: "processing" | "verifying" }
  | { assetId: string; status: "failed"; failureCode: string };

export function completeMediaUpload(input: {
  assetId: string;
  parts?: { partNumber: number; etag: string }[];
}): Promise<CompleteResponse> {
  return postJson<CompleteResponse>("complete", input);
}

export function abortMediaUpload(
  assetId: string,
): Promise<{ assetId: string; status: "deleted" }> {
  return postJson<{ assetId: string; status: "deleted" }>("abort", { assetId });
}

/** Sube `blob` con PUT a una URL presignada de R2, reportando progreso REAL de subida (XHR, no
 *  fetch: fetch no expone progreso de subida de forma fiable — sección 19 del checkpoint).
 *  Devuelve el ETag de la respuesta (necesario para completar un multipart). */
export function uploadWithProgress(
  url: string,
  blob: Blob,
  contentType: string,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<{ etag: string | null }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ etag: xhr.getResponseHeader("ETag") });
      } else {
        reject(new MediaClientError("La subida a R2 falló", xhr.status));
      }
    };
    xhr.onerror = () => reject(new MediaClientError("Error de red durante la subida"));
    xhr.send(blob);
  });
}
