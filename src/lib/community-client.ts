import { supabase } from "@/lib/supabase";
import {
  classifyPrivilegedFailure,
  type PrivilegedFailure,
} from "@/lib/privileged-response";

// Cliente de publicaciones de Comunidad (Fase 9J-1C): SOLO navegador. Mismo patrón exacto que
// cosplay-admin-client.ts — lee el access token VIGENTE de Supabase en cada llamada (nunca lo
// guarda), lo manda como Bearer, y nunca envía datos del cliente como autoridad: el backend
// (community-post-handlers.ts) vuelve a exigir autenticación + perfil de Comunidad en cada
// request, y las reglas de negocio reales (límite de 10 media, versión, "texto o media"…) viven
// en las RPC de la migración 20261004120000 — este archivo solo transporta datos y traduce la
// forma de la respuesta a camelCase, nunca reimplementa validación de seguridad.
//
// A diferencia de CosplayAdminClientError (privilegiado, MFA posible), estas acciones NUNCA
// disparan step-up: se mantiene privilegedFailure solo por paridad de forma con el resto de
// clientes /admin/*, pero en la práctica un fallo aquí siempre es 401/403/404/409/422 "normal".

export class CommunityClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Código estable devuelto por el backend (ver RPC_ERROR_MAP en community-post-handlers.ts),
     *  p. ej. "community_version_conflict", "profile_required", "empty_post". */
    readonly code?: string,
    readonly privilegedFailure: PrivilegedFailure | null = null,
  ) {
    super(message);
    this.name = "CommunityClientError";
  }
}

async function authHeader(): Promise<string> {
  if (!supabase) throw new CommunityClientError("Supabase no configurado");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new CommunityClientError("Sin sesión", 401);
  return `Bearer ${token}`;
}

async function request<T>(
  action: string,
  init: { method: "GET" | "POST"; body?: unknown; query?: Record<string, string> },
): Promise<T> {
  const auth = await authHeader();

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
    throw new CommunityClientError("Fallo de red");
  }

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
    throw new CommunityClientError(
      body?.error ?? "Error del servidor",
      response.status,
      body?.code,
      privilegedFailure,
    );
  }
  return json as T;
}

// ────────────────────────────────────────────────────────────────────────────────────────────

export interface CommunityPost {
  id: string;
  text: string | null;
  status: "published" | "hidden";
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Recuento REAL de likes (Fase 9J-2C). */
  likeCount: number;
}

export interface CommunityPostMedia {
  id: string;
  assetId: string;
  position: number;
}

export interface CommunityOwnPostMedia extends CommunityPostMedia {
  assetStatus: string | null;
  /** Discriminador de tipo (Fase 9J-3): "image" o "video". */
  kind: "image" | "video";
  width: number | null;
  height: number | null;
  /** SOLO kind="video". null para imagen, o si el navegador de origen no pudo leerla. */
  durationSeconds: number | null;
  /** null mientras el asset no esté 'ready' (aún procesándose). */
  url: string | null;
}

export interface CommunityOwnPost extends CommunityPost {
  media: CommunityOwnPostMedia[];
}

export async function listOwnCommunityPosts(): Promise<{ items: CommunityOwnPost[] }> {
  return request<{ items: CommunityOwnPost[] }>("community-post-list-own", {
    method: "GET",
  });
}

export interface SaveCommunityPostInput {
  postId: string | null;
  expectedVersion: number | null;
  text: string | null;
  media: { assetId: string; position: number }[];
}

export async function saveCommunityPost(
  input: SaveCommunityPostInput,
): Promise<{ post: CommunityPost; media: CommunityPostMedia[] }> {
  return request<{ post: CommunityPost; media: CommunityPostMedia[] }>(
    "community-post-save",
    {
      method: "POST",
      body: input,
    },
  );
}

export async function reorderCommunityPostMedia(input: {
  postId: string;
  expectedVersion: number;
  positions: { mediaId: string; position: number }[];
}): Promise<{ version: number }> {
  return request<{ version: number }>("community-post-reorder-media", {
    method: "POST",
    body: input,
  });
}

export async function detachCommunityPostMedia(input: {
  postId: string;
  expectedVersion: number;
  mediaId: string;
}): Promise<{ version: number; assetId: string; cleaned: boolean }> {
  return request("community-post-detach-media", { method: "POST", body: input });
}

export async function deleteCommunityPost(input: {
  postId: string;
  expectedVersion: number;
}): Promise<{
  postId: string;
  deletedAssets: { assetId: string; cleaned: boolean }[];
  allCleaned: boolean;
}> {
  return request("community-post-delete", { method: "POST", body: input });
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Likes (Fase 9J-2C). Operación de ESTADO idempotente (nunca lectura-luego-escritura desde aquí):
// setCommunityPostLike({postId, liked:true}) garantiza exactamente un like propio; liked:false
// garantiza cero. Cualquier usuario autenticado, incluido el propio autor — sin perfil de
// Comunidad requerido (a diferencia de crear/editar una publicación): dar like no es "gestionar
// contenido propio", así que no reutiliza community_post_save/community-post-fields.

export interface SetCommunityPostLikeResult {
  postId: string;
  likeCount: number;
  likedByMe: boolean;
}

export async function setCommunityPostLike(input: {
  postId: string;
  liked: boolean;
}): Promise<SetCommunityPostLikeResult> {
  return request("community-post-set-like", { method: "POST", body: input });
}

/** ¿Cuáles de estos postId dio like el usuario autenticado ACTUAL? Deliberadamente NUNCA forma
 *  parte de una respuesta pública cacheada (feed/perfil/detalle): esas respuestas son las mismas
 *  para cualquier visitante y se sirven con Cache-Control público — mezclar el estado de UN
 *  usuario ahí arriesgaría que un CDN sirva el "me gusta" de una persona a otra. Esta llamada es
 *  autenticada y sin caché, y el frontend combina su resultado con los datos públicos ya cargados. */
export async function fetchCommunityLikedByMe(postIds: string[]): Promise<{
  likedPostIds: string[];
}> {
  if (postIds.length === 0) return { likedPostIds: [] };
  return request("community-post-liked-by-me", {
    method: "GET",
    query: { postIds: postIds.join(",") },
  });
}
