import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  decodeFeedCursor,
  decodePopularCursor,
  encodeFeedCursor,
  encodePopularCursor,
  mapFeedMediaRow,
  mapFeedPostRow,
  popularWindowStart,
  COMMUNITY_FEED_PAGE_SIZE,
  type CommunityFeedAuthor,
  type CommunityFeedPage,
  type PopularCursor,
  type RawFeedMediaRow,
  type RawFeedPostRow,
} from "./community-feed-domain.js";
import { communityPublicMediaUrl } from "./media-delivery-url.js";

// Handler HTTP de lectura PÚBLICA del feed de Comunidad (Fase 9J-2A, ampliado en 9J-2C con el modo
// "Populares"): listado paginado de publicaciones published. Público (sin Authorization): filtra
// status='published' EN EL SERVIDOR, nunca en el cliente (community_posts tiene RLS forzado y
// cero policies — la única forma de leerla es aquí, con service_role, igual que
// cosplay-handlers.ts para cosplay_posts). No hay flujo de moderación con aprobación en este
// checkpoint: toda publicación 'published' es pública de inmediato, tal como exige el producto
// congelado (ver el comentario de handleCommunityPostSave en community-post-handlers.ts — la RPC
// ya crea las filas como 'published' desde el primer guardado).
//
// ?mode=recent (por defecto, sin cambios de 9J-2A) o ?mode=popular (Fase 9J-2C: últimos 7 días,
// like_count DESC, created_at DESC, id DESC — nunca una métrica de "engagement" inventada, ver el
// comentario de community_posts_popular en la migración 20261005120000). Un `mode` desconocido se
// trata como "recent" (nunca 400: mantiene el comportamiento previo a este checkpoint para
// cualquier llamador que no envíe `mode`).
//
// Despachado desde api/content/[resource].ts (ver ese archivo): mismo dispatcher genérico de
// lecturas públicas que ya usa Cosplay, sin sumar otra Serverless Function.

const GENERIC_ERROR_BODY = { error: "Error interno" };

const POSTS_SELECT =
  "id, author_user_id, text, created_at, like_count, community_post_media(id, position, media_assets(status, kind, storage_key, width, height, duration_seconds))";

interface RawPostWithMedia extends RawFeedPostRow {
  author_user_id: string;
  community_post_media?: RawFeedMediaRow[];
}

interface RawProfileRow {
  user_id: string;
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

/** URL pública real: reutiliza EXACTAMENTE el mismo constructor de URL que el pipeline de medios
 *  (r2-client.ts), nunca un segundo sistema. Nunca se sirve una clave de storage cruda ni un
 *  original privado: solo la variante pública canónica ya normalizada. */
function buildImageUrl(storageKey: string): string {
  return communityPublicMediaUrl(storageKey);
}

/** Perfiles del autor en una consulta aparte (community_posts no tiene una FK directa hacia
 *  profiles que PostgREST pueda embeber — ambas tablas referencian auth.users por separado, ver
 *  el comentario de cabecera). Sin filas → feed vacío: no tiene sentido consultar profiles con un
 *  `.in()` vacío. Compartido entre "recent" y "popular": la resolución de autor es idéntica. */
async function resolveAuthors(
  client: SupabaseClient,
  rows: RawPostWithMedia[],
): Promise<Map<string, CommunityFeedAuthor> | null> {
  const authorIds = [...new Set(rows.map((row) => row.author_user_id))];
  const profileMap = new Map<string, CommunityFeedAuthor>();
  if (authorIds.length === 0) return profileMap;

  const { data: profileRows, error } = await client
    .from("profiles")
    .select("user_id, username, display_name")
    .in("user_id", authorIds);
  if (error) return null;
  for (const p of (profileRows ?? []) as unknown as RawProfileRow[]) {
    profileMap.set(p.user_id, { username: p.username, displayName: p.display_name });
  }
  return profileMap;
}

/** Un autor sin perfil resoluble no debería ocurrir (profiles.user_id y
 *  community_posts.author_user_id comparten el mismo ON DELETE CASCADE sobre auth.users: si la
 *  cuenta desaparece, ambas filas desaparecen juntas), pero fail-closed: una publicación sin
 *  identidad pública verificable nunca se sirve en vez de arriesgar un hueco de datos. */
function mapRowsToItems(
  rows: RawPostWithMedia[],
  profileMap: Map<string, CommunityFeedAuthor>,
) {
  return rows.flatMap((row) => {
    const author = profileMap.get(row.author_user_id);
    if (!author) return [];
    const media = (row.community_post_media ?? [])
      .map((m) => mapFeedMediaRow(m, buildImageUrl))
      .filter((m): m is NonNullable<typeof m> => m !== null);
    return [mapFeedPostRow(row, author, media)];
  });
}

async function handleRecentFeed(
  client: SupabaseClient,
  cursorParam: string | undefined,
  res: VercelResponse,
): Promise<VercelResponse> {
  let cursor: { createdAt: string; id: string } | null = null;
  if (cursorParam) {
    cursor = decodeFeedCursor(cursorParam);
    if (!cursor) return res.status(400).json({ error: "Cursor inválido" });
  }

  let query = client
    .from("community_posts")
    .select(POSTS_SELECT)
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

  const rows = data as unknown as RawPostWithMedia[];
  const hasMore = rows.length > COMMUNITY_FEED_PAGE_SIZE;
  const page = rows.slice(0, COMMUNITY_FEED_PAGE_SIZE);

  const profileMap = await resolveAuthors(client, page);
  if (profileMap === null) return res.status(500).json(GENERIC_ERROR_BODY);
  const items = mapRowsToItems(page, profileMap);

  const last = page.at(-1);
  const nextCursor = hasMore && last ? encodeFeedCursor(last.created_at, last.id) : null;

  const body: CommunityFeedPage = { items, nextCursor };
  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
  return res.status(200).json(body);
}

/** "Populares" (Fase 9J-2C): últimos 7 días + like_count DESC + created_at DESC + id DESC (ver el
 *  comentario de cabecera). Sin post con like todavía dentro de la ventana, la pestaña muestra los
 *  elegibles con 0 likes usando el MISMO desempate determinista — nunca un tab vacío por diseño
 *  durante el crecimiento inicial de Comunidad (congelado en el checkpoint). El corte de 7 días se
 *  calcula con el reloj del SERVIDOR en la primera página y viaja DENTRO del cursor opaco para las
 *  siguientes, así que nunca se desplaza a mitad de un recorrido paginado. */
async function handlePopularFeed(
  client: SupabaseClient,
  cursorParam: string | undefined,
  res: VercelResponse,
): Promise<VercelResponse> {
  let cursor: PopularCursor | null = null;
  if (cursorParam) {
    cursor = decodePopularCursor(cursorParam);
    if (!cursor) return res.status(400).json({ error: "Cursor inválido" });
  }
  const windowStart = cursor ? cursor.windowStart : popularWindowStart();

  let query = client
    .from("community_posts")
    .select(POSTS_SELECT)
    .eq("status", "published")
    .gte("created_at", windowStart)
    .order("like_count", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(COMMUNITY_FEED_PAGE_SIZE + 1);

  if (cursor) {
    query = query.or(
      `like_count.lt.${cursor.likeCount},` +
        `and(like_count.eq.${cursor.likeCount},created_at.lt.${cursor.createdAt}),` +
        `and(like_count.eq.${cursor.likeCount},created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
    );
  }

  const { data, error } = await query;
  if (error || !Array.isArray(data)) return res.status(500).json(GENERIC_ERROR_BODY);

  const rows = data as unknown as RawPostWithMedia[];
  const hasMore = rows.length > COMMUNITY_FEED_PAGE_SIZE;
  const page = rows.slice(0, COMMUNITY_FEED_PAGE_SIZE);

  const profileMap = await resolveAuthors(client, page);
  if (profileMap === null) return res.status(500).json(GENERIC_ERROR_BODY);
  const items = mapRowsToItems(page, profileMap);

  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? encodePopularCursor({
          likeCount: last.like_count,
          createdAt: last.created_at,
          id: last.id,
          windowStart,
        })
      : null;

  const body: CommunityFeedPage = { items, nextCursor };
  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
  return res.status(200).json(body);
}

export async function handleCommunityFeed(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  const rawMode = req.query.mode;
  const mode = Array.isArray(rawMode) ? rawMode[0] : rawMode;
  const rawCursor = req.query.cursor;
  const cursorParam = Array.isArray(rawCursor) ? rawCursor[0] : rawCursor;

  try {
    if (mode === "popular") return await handlePopularFeed(client, cursorParam, res);
    return await handleRecentFeed(client, cursorParam, res);
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}
