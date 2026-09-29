import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  mapFeedMediaRow,
  mapFeedPostRow,
  COMMUNITY_FEED_PAGE_SIZE,
  type CommunityFeedAuthor,
  type CommunityFeedPage,
  type RawFeedMediaRow,
  type RawFeedPostRow,
} from "./community-feed-domain.js";
import { publicVariantUrl } from "./r2-client.js";

// Handler HTTP de lectura PÚBLICA del feed de Comunidad (Fase 9J-2A): listado paginado de
// publicaciones published, más recientes primero. Público (sin Authorization): filtra
// status='published' EN EL SERVIDOR, nunca en el cliente (community_posts tiene RLS forzado y
// cero policies — la única forma de leerla es aquí, con service_role, igual que
// cosplay-handlers.ts para cosplay_posts). No hay flujo de moderación con aprobación en este
// checkpoint: toda publicación 'published' es pública de inmediato, tal como exige el producto
// congelado (ver el comentario de handleCommunityPostSave en community-post-handlers.ts — la RPC
// ya crea las filas como 'published' desde el primer guardado).
//
// Despachado desde api/content/[resource].ts (ver ese archivo): mismo dispatcher genérico de
// lecturas públicas que ya usa Cosplay, sin sumar otra Serverless Function.

const GENERIC_ERROR_BODY = { error: "Error interno" };

const POSTS_SELECT =
  "id, author_user_id, text, created_at, community_post_media(id, position, media_assets(status, storage_key, width, height))";

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
  return publicVariantUrl(storageKey);
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

  const rawCursor = req.query.cursor;
  const cursorParam = Array.isArray(rawCursor) ? rawCursor[0] : rawCursor;
  let cursor: { createdAt: string; id: string } | null = null;
  if (cursorParam) {
    cursor = decodeFeedCursor(cursorParam);
    if (!cursor) return res.status(400).json({ error: "Cursor inválido" });
  }

  try {
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

    // Perfiles del autor en una consulta aparte (community_posts no tiene una FK directa hacia
    // profiles que PostgREST pueda embeber — ambas tablas referencian auth.users por separado, ver
    // el comentario de arriba). Sin filas → feed vacío: no tiene sentido consultar profiles con un
    // `.in()` vacío.
    const authorIds = [...new Set(page.map((row) => row.author_user_id))];
    const profileMap = new Map<string, CommunityFeedAuthor>();
    if (authorIds.length > 0) {
      const { data: profileRows, error: profileError } = await client
        .from("profiles")
        .select("user_id, username, display_name")
        .in("user_id", authorIds);
      if (profileError) return res.status(500).json(GENERIC_ERROR_BODY);
      for (const p of (profileRows ?? []) as unknown as RawProfileRow[]) {
        profileMap.set(p.user_id, { username: p.username, displayName: p.display_name });
      }
    }

    // Un autor sin perfil resoluble no debería ocurrir (profiles.user_id y
    // community_posts.author_user_id comparten el mismo ON DELETE CASCADE sobre auth.users: si la
    // cuenta desaparece, ambas filas desaparecen juntas), pero fail-closed: una publicación sin
    // identidad pública verificable nunca se sirve en vez de arriesgar un hueco de datos.
    const items = page.flatMap((row) => {
      const author = profileMap.get(row.author_user_id);
      if (!author) return [];
      const media = (row.community_post_media ?? [])
        .map((m) => mapFeedMediaRow(m, buildImageUrl))
        .filter((m): m is NonNullable<typeof m> => m !== null);
      return [mapFeedPostRow(row, author, media)];
    });

    const last = page.at(-1);
    const nextCursor =
      hasMore && last ? encodeFeedCursor(last.created_at, last.id) : null;

    const body: CommunityFeedPage = { items, nextCursor };
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
    return res.status(200).json(body);
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}
