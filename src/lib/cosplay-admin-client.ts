import type { PrivilegedSessionIdentity } from "@/lib/privileged-session";
import { supabase } from "@/lib/supabase";
import {
  classifyPrivilegedFailure,
  type PrivilegedFailure,
} from "@/lib/privileged-response";

// Cliente del editor ADMIN de Cosplay (Fase 9I-3, checkpoint 3): SOLO navegador. Mismo patrón
// exacto que media-client.ts — lee el access token VIGENTE de Supabase en cada llamada (nunca lo
// guarda), lo manda como Bearer, y nunca envía datos del cliente como autoridad: el backend
// (cosplay-editor-handlers.ts) vuelve a exigir cosplay_admin + MFA reciente en cada request, y las
// reglas de negocio reales (límite de 20, adjuntar, versión, publicar…) viven en las RPC de la
// migración 20261002120000 — este archivo solo transporta datos y traduce la forma de la
// respuesta a camelCase, nunca reimplementa validación de seguridad.

export class CosplayAdminClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Código estable devuelto por el backend (ver RPC_ERROR_MAP en cosplay-editor-handlers.ts),
     *  p. ej. "cosplay_version_conflict", "missing_alt_es", "asset_not_ready". */
    readonly code?: string,
    /** Clasificación canónica 9G-3 (ver privileged-response.ts) — MISMA semántica que media-client
     *  y el resto de /admin. Solo "step_up_required" debe iniciar MFA. */
    readonly privilegedFailure: PrivilegedFailure | null = null,
  ) {
    super(message);
    this.name = "CosplayAdminClientError";
  }
}

async function authHeader(identity?: PrivilegedSessionIdentity): Promise<string> {
  if (!supabase) throw new CosplayAdminClientError("Supabase no configurado");
  const { data, error } = await supabase.auth.getSession();
  if (
    identity &&
    (error ||
      !identity.isActive() ||
      !identity.userId ||
      data.session?.user.id !== identity.userId)
  )
    throw new CosplayAdminClientError(
      "Sesión no válida",
      401,
      undefined,
      "unauthenticated",
    );
  const token = data.session?.access_token;
  if (!token) throw new CosplayAdminClientError("Sin sesión", 401);
  return `Bearer ${token}`;
}

async function request<T>(
  action: string,
  init: { method: "GET" | "POST"; body?: unknown; query?: Record<string, string> },
  identity?: PrivilegedSessionIdentity,
): Promise<T> {
  const auth = await authHeader(identity);
  if (identity && !identity.isActive())
    throw new CosplayAdminClientError(
      "Sesión no válida",
      401,
      undefined,
      "unauthenticated",
    );
  const query = init.query ? `?${new URLSearchParams(init.query).toString()}` : "";

  let response: Response;
  try {
    response = await fetch(`/api/admin/${action}${query}`, {
      method: init.method,
      headers: {
        Authorization: auth,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new CosplayAdminClientError("Fallo de red");
  }

  // Clasifica ANTES de leer el cuerpo con la copia propia más abajo (clone() falla si el body ya
  // se consumió) — misma disciplina que media-client.ts.
  const privilegedFailure = !response.ok
    ? await classifyPrivilegedFailure(response.clone())
    : null;

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // sin cuerpo o no es JSON: error genérico más abajo si !response.ok
  }

  if (!response.ok) {
    const body = json as { error?: string; code?: string } | null;
    throw new CosplayAdminClientError(
      body?.error ?? "Error del servidor",
      response.status,
      body?.code,
      privilegedFailure,
    );
  }
  return json as T;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Tipos: cosplay-editor-handlers.ts YA devuelve el contrato neutral de aplicación (camelCase,
// un solo campo por dato editorial — ver types/index.ts) — este cliente no vuelve a traducir
// nada, solo tipa lo que llega por cable. El almacenamiento *_es/_en/_de de Postgres es un
// detalle interno del servidor que nunca llega hasta aquí.

export interface CosplayEditorPost {
  id: string;
  slug: string;
  status: "draft" | "published";
  title: string;
  description: string | null;
  characterName: string | null;
  series: string | null;
  event: string | null;
  shotOn: string | null;
  photographerCredit: string | null;
  version: number;
  publishedAt: string | null;
}

export interface CosplayEditorSavedImage {
  id: string;
  assetId: string;
  position: number;
  isCover: boolean;
  decorative: boolean;
  alt: string | null;
  caption: string | null;
}

export interface CosplayAdminImage extends CosplayEditorSavedImage {
  assetStatus: string | null;
  width: number | null;
  height: number | null;
  /** null mientras el asset no esté 'ready' (aún procesándose). */
  url: string | null;
}

export interface CosplayAdminPostDetail extends CosplayEditorPost {
  images: CosplayAdminImage[];
}

export async function getCosplayPostAdmin(
  postId: string,
  ownDraft = false,
  identity?: PrivilegedSessionIdentity,
): Promise<CosplayAdminPostDetail> {
  return request<CosplayAdminPostDetail>(
    "cosplay-post-get-admin",
    {
      method: "GET",
      query: { postId, ...(ownDraft ? { scope: "own-draft" } : {}) },
    },
    identity,
  );
}

export interface CosplayOwnDraft {
  id: string;
  title: string;
  updatedAt: string;
}

export async function listOwnCosplayDrafts(): Promise<{ items: CosplayOwnDraft[] }> {
  return request("cosplay-post-list-admin", {
    method: "GET",
    query: { scope: "own-drafts" },
  });
}

export interface CosplayEditorImageInput {
  assetId: string;
  position: number;
  isCover: boolean;
  decorative: boolean;
  alt: string | null;
  caption: string | null;
}

export interface SaveCosplayPostInput {
  postId: string | null;
  expectedVersion: number | null;
  status: "draft" | "published";
  title: string;
  description: string | null;
  characterName: string | null;
  series: string | null;
  event: string | null;
  shotOn: string | null;
  photographerCredit: string | null;
  images: CosplayEditorImageInput[];
}

export async function saveCosplayPost(
  input: SaveCosplayPostInput,
  identity?: PrivilegedSessionIdentity,
): Promise<{ post: CosplayEditorPost; images: CosplayEditorSavedImage[] }> {
  return request<{ post: CosplayEditorPost; images: CosplayEditorSavedImage[] }>(
    "cosplay-post-save",
    { method: "POST", body: input },
    identity,
  );
}

export async function reorderCosplayImages(input: {
  postId: string;
  expectedVersion: number;
  positions: { imageId: string; position: number }[];
}): Promise<{ version: number }> {
  return request<{ version: number }>("cosplay-post-reorder", {
    method: "POST",
    body: input,
  });
}

export async function detachCosplayMedia(
  input: {
    postId: string;
    expectedVersion: number;
    imageId: string;
  },
  identity?: PrivilegedSessionIdentity,
): Promise<{ version: number; assetId: string; cleaned: boolean }> {
  return request<{ version: number; assetId: string; cleaned: boolean }>(
    "cosplay-media-detach",
    { method: "POST", body: input },
    identity,
  );
}

export async function deleteCosplayPost(
  input: {
    postId: string;
    expectedVersion: number;
  },
  identity?: PrivilegedSessionIdentity,
): Promise<{
  postId: string;
  deletedAssets: { assetId: string; cleaned: boolean }[];
  allCleaned: boolean;
}> {
  return request("cosplay-post-delete", { method: "POST", body: input }, identity);
}
