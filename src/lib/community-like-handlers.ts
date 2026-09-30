import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, requireAuthenticated } from "./admin-auth.js";

// Handlers HTTP de likes de Comunidad (Fase 9J-2C): dar/quitar like a una publicación propia
// (set-like) y consultar cuáles de una lista de publicaciones ya tiene like el usuario actual
// (liked-by-me). Despachados desde api/admin/[action].ts — mismo motivo que
// community-post-handlers.ts: el plan Hobby de Vercel ya tiene sus 12 funciones Serverless
// agotadas, así que estas acciones viven en el dispatcher "admin" genérico existente aunque no
// sean privilegiadas (cada acción autoriza la suya propia).
//
// Dar like NUNCA exige perfil de Comunidad (a diferencia de crear/editar una publicación,
// community_post_save): cualquier usuario AUTENTICADO puede dar like a cualquier publicación
// published, incluida la suya propia — el checkpoint lo exige explícitamente. Sin MFA, sin rol.
//
// La mutación real (una-fila-por-usuario-y-post, fail-closed si la publicación no es 'published')
// vive en la RPC SECURITY DEFINER community_post_set_like (migración 20261005120000): este
// archivo solo autoriza (requireAuthenticated) y traduce forma/errores, nunca reimplementa esa
// regla — mismo patrón que community-post-handlers.ts frente a community_post_save/_delete.
//
// liked-by-me es deliberadamente una llamada AUTENTICADA Y SIN CACHÉ, separada de las lecturas
// públicas (feed/perfil/detalle, que sí llevan Cache-Control público): mezclar el "me gusta" de un
// usuario concreto dentro de una respuesta cacheada arriesgaría que un CDN sirva el estado de una
// persona a otra. El frontend combina esta respuesta con los datos públicos ya cargados.

const GENERIC_ERROR_BODY = { error: "Error interno" };
const BAD_REQUEST_BODY = { error: "Solicitud inválida" };
const PLPGSQL_RAISE_EXCEPTION_CODE = "P0001";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Tope defensivo: más que suficiente para una página de feed/perfil (20) más margen, sin
 *  permitir una consulta arbitrariamente grande. */
const MAX_LIKED_BY_ME_IDS = 100;

function getServiceRoleClient(): SupabaseClient | null {
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function authorizeAuthenticated(
  req: VercelRequest,
  res: VercelResponse,
): Promise<string | null> {
  try {
    const { userId } = await requireAuthenticated(req);
    return userId;
  } catch (err) {
    if (err instanceof AdminAuthError) {
      res.status(err.status).json({ error: err.message });
    } else {
      res.status(500).json(GENERIC_ERROR_BODY);
    }
    return null;
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function parseJsonBody(req: VercelRequest): Record<string, unknown> | null {
  const raw = req.body;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function firstQueryValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// POST /api/admin/community-post-set-like

export async function handleCommunityPostSetLike(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const actorId = await authorizeAuthenticated(req, res);
  if (actorId === null) return res;

  const body = parseJsonBody(req);
  const postId = body?.postId;
  const liked = body?.liked;
  if (!isUuid(postId) || typeof liked !== "boolean") {
    return res.status(400).json(BAD_REQUEST_BODY);
  }

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  try {
    const { data, error } = await client.rpc("community_post_set_like", {
      p_actor_user_id: actorId,
      p_post_id: postId,
      p_liked: liked,
    });
    if (error) {
      const message =
        error && typeof error === "object"
          ? (error as { code?: unknown; message?: unknown })
          : null;
      if (
        message?.code === PLPGSQL_RAISE_EXCEPTION_CODE &&
        message.message === "post_not_found"
      ) {
        return res.status(404).json({ error: "No encontrado", code: "not_found" });
      }
      if (
        message?.code === PLPGSQL_RAISE_EXCEPTION_CODE &&
        message.message === "invalid_argument"
      ) {
        return res.status(400).json(BAD_REQUEST_BODY);
      }
      return res.status(500).json(GENERIC_ERROR_BODY);
    }

    const result = data as { postId: string; likeCount: number; likedByMe: boolean };
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(result);
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// GET /api/admin/community-post-liked-by-me?postIds=a,b,c — autenticado, sin caché. Devuelve solo
// el subconjunto de postIds que el usuario ACTUAL dio like; nunca revela nada sobre otros
// usuarios ni sobre postId inexistentes/ajenos (una fila inexistente simplemente no aparece en el
// resultado, igual que si nunca hubiera tenido like).

export async function handleCommunityPostLikedByMe(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const actorId = await authorizeAuthenticated(req, res);
  if (actorId === null) return res;

  const raw = firstQueryValue(req.query.postIds);
  if (typeof raw !== "string" || raw.length === 0) {
    return res.status(200).json({ likedPostIds: [] });
  }

  const postIds = [...new Set(raw.split(","))].filter(isUuid);
  if (postIds.length === 0) return res.status(200).json({ likedPostIds: [] });
  if (postIds.length > MAX_LIKED_BY_ME_IDS) return res.status(400).json(BAD_REQUEST_BODY);

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  try {
    const { data, error } = await client
      .from("community_post_likes")
      .select("post_id")
      .eq("user_id", actorId)
      .in("post_id", postIds);
    if (error || !Array.isArray(data)) return res.status(500).json(GENERIC_ERROR_BODY);

    const likedPostIds = (data as unknown as { post_id: string }[]).map(
      (row) => row.post_id,
    );
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ likedPostIds });
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}
