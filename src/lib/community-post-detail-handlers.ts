import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  mapFeedMediaRow,
  mapFeedPostRow,
  type RawFeedMediaRow,
} from "./community-feed-domain.js";
import { publicVariantUrl } from "./r2-client.js";
import type { CommunityFeedPost } from "../types/index.js";

// Handler HTTP de lectura PÚBLICA de UNA publicación de Comunidad (Fase 9J-2B.1): /community/post/
// :postId. Público (sin Authorization), mismo criterio fail-closed que community-feed-handlers.ts
// y community-profile-handlers.ts: filtra status='published' EN EL SERVIDOR (community_posts
// tiene RLS forzado y cero policies), y una publicación borrada/oculta/inexistente responde
// exactamente el mismo 404 — nunca revela cuál de los tres casos ocurrió.
//
// Reutiliza DELIBERADAMENTE community-feed-domain.ts (mapFeedMediaRow/mapFeedPostRow) — la
// respuesta es un CommunityFeedPost, el MISMO contrato que ya usan el feed y el perfil público:
// nunca una tercera representación incompatible de "publicación pública".
//
// Despachado desde api/content/[resource].ts: mismo dispatcher genérico de lecturas públicas que
// ya usan Cosplay, el feed y el perfil de Comunidad, sin sumar otra Serverless Function.

const GENERIC_ERROR_BODY = { error: "Error interno" };
const NOT_FOUND_BODY = { error: "No encontrado" };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const POST_SELECT =
  "id, author_user_id, text, created_at, like_count, community_post_media(id, position, media_assets(status, kind, storage_key, width, height, duration_seconds))";

interface RawPostRow {
  id: string;
  author_user_id: string;
  text: string | null;
  created_at: string;
  like_count: number;
  community_post_media?: RawFeedMediaRow[];
}

interface RawProfileRow {
  username: string;
  display_name: string | null;
}

function getServiceRoleClient(): SupabaseClient | null {
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function buildImageUrl(storageKey: string): string {
  return publicVariantUrl(storageKey);
}

function firstQueryValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

export async function handleCommunityPostDetail(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const postId = firstQueryValue(req.query.postId);
  if (typeof postId !== "string" || !UUID_PATTERN.test(postId)) {
    return res.status(404).json(NOT_FOUND_BODY);
  }

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  try {
    const { data, error } = await client
      .from("community_posts")
      .select(POST_SELECT)
      .eq("id", postId)
      .eq("status", "published")
      .maybeSingle();
    if (error) return res.status(500).json(GENERIC_ERROR_BODY);
    if (!data) return res.status(404).json(NOT_FOUND_BODY);
    const row = data as unknown as RawPostRow;

    const { data: profileRow, error: profileError } = await client
      .from("profiles")
      .select("username, display_name")
      .eq("user_id", row.author_user_id)
      .maybeSingle();
    if (profileError) return res.status(500).json(GENERIC_ERROR_BODY);
    // Fail-closed (mismo criterio que el feed/perfil): sin identidad pública verificable, la
    // publicación nunca se sirve, en vez de arriesgar un hueco de datos.
    if (!profileRow) return res.status(404).json(NOT_FOUND_BODY);
    const profile = profileRow as unknown as RawProfileRow;

    const media = (row.community_post_media ?? [])
      .map((m) => mapFeedMediaRow(m, buildImageUrl))
      .filter((m): m is NonNullable<typeof m> => m !== null);

    const post: CommunityFeedPost = mapFeedPostRow(
      row,
      { username: profile.username, displayName: profile.display_name },
      media,
    );

    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
    return res.status(200).json({ post });
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}
