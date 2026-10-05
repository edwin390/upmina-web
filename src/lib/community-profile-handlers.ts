import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isValidUsernameFormat, normalizeUsername } from "./profile-username.js";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  mapFeedMediaRow,
  mapFeedPostRow,
  COMMUNITY_FEED_PAGE_SIZE,
  type CommunityFeedAuthor,
  type RawFeedMediaRow,
  type RawFeedPostRow,
} from "./community-feed-domain.js";
import { communityPublicMediaUrl } from "./media-delivery-url.js";
import type { CommunityProfilePage, CommunityProfilePublic } from "../types/index.js";

// Handler HTTP de lectura PÚBLICA del perfil de Comunidad (Fase 9J-2B): /@username. Público (sin
// Authorization), igual que community-feed-handlers.ts: filtra status='published' EN EL SERVIDOR
// (community_posts tiene RLS forzado y cero policies) y NUNCA devuelve author_user_id/UUID, email,
// role ni metadata de MFA.
//
// Reutiliza DELIBERADAMENTE community-feed-domain.ts (mapFeedMediaRow/mapFeedPostRow/cursor) en
// vez de inventar una segunda representación de "publicación pública": la galería del perfil usa
// EXACTAMENTE el mismo contrato CommunityFeedPost/CommunityFeedPage que el feed de /community — la
// única diferencia es el filtro adicional por autor. El autor de cada item sigue siendo el mismo
// objeto ya resuelto una sola vez (a diferencia del feed, que agrupa varios autores distintos por
// página, aquí SIEMPRE es el mismo, así que no hace falta el paso de "agrupar por author_user_id").
//
// Despachado desde api/content/[resource].ts (ver ese archivo): mismo dispatcher genérico de
// lecturas públicas que ya usan Cosplay y el feed de Comunidad, sin sumar otra Serverless Function.

const GENERIC_ERROR_BODY = { error: "Error interno" };
const NOT_FOUND_BODY = { error: "Perfil no encontrado" };
const BAD_REQUEST_BODY = { error: "Username inválido" };

const POSTS_SELECT =
  "id, text, created_at, like_count, community_post_media(id, position, media_assets(status, kind, storage_key, width, height, duration_seconds))";

interface RawPostRow extends RawFeedPostRow {
  community_post_media?: RawFeedMediaRow[];
}

interface RawProfileRow {
  user_id: string;
  username: string;
  display_name: string | null;
  bio: string | null;
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
  return communityPublicMediaUrl(storageKey);
}

function firstQueryValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

export async function handleCommunityProfile(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const rawUsername = firstQueryValue(req.query.username);
  if (typeof rawUsername !== "string" || rawUsername.length === 0) {
    return res.status(400).json(BAD_REQUEST_BODY);
  }
  // Búsqueda case-insensitive consistente con las reglas de username existentes
  // (profile-username.ts): se normaliza el valor recibido ANTES de comparar, nunca se compara
  // contra el texto crudo. profiles.username ya se guarda normalizado (mismo invariante que
  // profile-handlers.ts), así que comparar contra el valor normalizado basta.
  const username = normalizeUsername(rawUsername);
  if (!isValidUsernameFormat(username)) return res.status(400).json(BAD_REQUEST_BODY);

  const rawCursor = firstQueryValue(req.query.cursor);
  let cursor: { createdAt: string; id: string } | null = null;
  if (rawCursor) {
    cursor = decodeFeedCursor(rawCursor);
    if (!cursor) return res.status(400).json({ error: "Cursor inválido" });
  }

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  try {
    const { data: profileRow, error: profileError } = await client
      .from("profiles")
      .select("user_id, username, display_name, bio")
      .eq("username", username)
      .maybeSingle();
    if (profileError) return res.status(500).json(GENERIC_ERROR_BODY);
    // Sin distinguir "username con formato inválido pero bien formado" de "no existe": ambos ya
    // devuelven 404 aquí (el 400 de arriba solo cubre un formato que ni siquiera podría existir
    // en la base, ver profiles_username_format) — un username inexistente nunca revela más que
    // "no encontrado".
    if (!profileRow) return res.status(404).json(NOT_FOUND_BODY);
    const profile = profileRow as unknown as RawProfileRow;

    const author: CommunityFeedAuthor = {
      username: profile.username,
      displayName: profile.display_name,
    };

    const { count, error: countError } = await client
      .from("community_posts")
      .select("id", { count: "exact", head: true })
      .eq("author_user_id", profile.user_id)
      .eq("status", "published");
    if (countError) return res.status(500).json(GENERIC_ERROR_BODY);

    // Suma REAL de likeCount de sus publicaciones published (Fase 9J-2C) — nunca una tabla
    // liker/publicación expuesta, solo el agregado. like_count ya viene desnormalizado en cada
    // fila (ver la migración 20261005120000), así que basta con sumar en memoria: a esta escala
    // no justifica una función de agregación SQL aparte.
    const { data: likeRows, error: likeError } = await client
      .from("community_posts")
      .select("like_count")
      .eq("author_user_id", profile.user_id)
      .eq("status", "published");
    if (likeError) return res.status(500).json(GENERIC_ERROR_BODY);
    const totalLikes = ((likeRows ?? []) as unknown as { like_count: number }[]).reduce(
      (sum, row) => sum + row.like_count,
      0,
    );

    let query = client
      .from("community_posts")
      .select(POSTS_SELECT)
      .eq("author_user_id", profile.user_id)
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(COMMUNITY_FEED_PAGE_SIZE + 1);

    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
      );
    }

    const { data, error } = await query;
    if (error || !Array.isArray(data)) return res.status(500).json(GENERIC_ERROR_BODY);

    const rows = data as unknown as RawPostRow[];
    const hasMore = rows.length > COMMUNITY_FEED_PAGE_SIZE;
    const page = rows.slice(0, COMMUNITY_FEED_PAGE_SIZE);

    const items = page.map((row) => {
      const media = (row.community_post_media ?? [])
        .map((m) => mapFeedMediaRow(m, buildImageUrl))
        .filter((m): m is NonNullable<typeof m> => m !== null);
      return mapFeedPostRow(row, author, media);
    });

    const last = page.at(-1);
    const nextCursor =
      hasMore && last ? encodeFeedCursor(last.created_at, last.id) : null;

    const profilePublic: CommunityProfilePublic = {
      username: profile.username,
      displayName: profile.display_name,
      bio: profile.bio,
      postCount: count ?? 0,
      totalLikes,
    };

    const body: CommunityProfilePage = {
      profile: profilePublic,
      posts: { items, nextCursor },
    };
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
    return res.status(200).json(body);
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}
