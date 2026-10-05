import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  isValidSlugFormat,
  mapImageRow,
  mapPostRowToDetail,
  mapPostRowToSummary,
} from "./cosplay-domain.js";
import { cosplayPublicMediaUrl } from "./media-delivery-url.js";
import type {
  CosplayPostImageRow,
  CosplayPostListPage,
  CosplayPostRow,
} from "../types/index.js";

// Handlers HTTP de solo lectura de Cosplay (Fase 9I-1): listado paginado y detalle por slug.
// Público (sin Authorization): filtran status='published' y solo imágenes con media_assets
// status='ready' EN EL SERVIDOR, nunca en el cliente (cosplay_posts/cosplay_post_images/
// media_assets tienen RLS forzado y cero policies — la única forma de leerlas es aquí, con
// service_role). Un borrador o una imagen todavía reservada/borrándose no pueden filtrar por
// ningún camino: ni una petición autenticada revela más que una anónima, porque no existe
// ninguna versión "para ADMIN" de estos dos handlers (9I-1 no tiene editor todavía).
//
// Despachados desde api/content/[resource].ts (ver ese archivo): no son Serverless Functions
// propias, para no sumar al límite de 12 del plan Hobby de Vercel.

const GENERIC_ERROR_BODY = { error: "Error interno" };
const PAGE_SIZE = 24;
const SELECT_WITH_IMAGES =
  "*, cosplay_post_images(id, position, is_cover, decorative, alt_es, alt_en, alt_de, caption_es, caption_en, caption_de, media_assets(id, status, width, height, storage_key))";

/** URL pública real (Fase 9I-3, sección 3): reutiliza EXACTAMENTE el mismo constructor de URL que
 *  el pipeline de medios (r2-client.ts), nunca un segundo sistema de construcción de URLs. En
 *  Production, publicVariantUrl (vía getR2DevConfig) lanza SIEMPRE — no existe infraestructura de
 *  R2 de Production todavía — y ese throw se propaga hasta el try/catch del handler, que responde
 *  el mismo error 500 genérico que cualquier otro fallo. Nunca se sirve un placeholder ni una URL
 *  de original privado: solo la variante pública canónica ya normalizada. */
function buildImageUrl(storageKey: string): string {
  return cosplayPublicMediaUrl(storageKey);
}

function getServiceRoleClient() {
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function imagesFromRow(
  row: CosplayPostRow & { cosplay_post_images?: CosplayPostImageRow[] },
) {
  return (row.cosplay_post_images ?? [])
    .map((imageRow) => mapImageRow(imageRow, buildImageUrl))
    .filter((image): image is NonNullable<typeof image> => image !== null);
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Cursor de paginación: opaco para el cliente (base64url de "publishedAt|id"), nunca expone
// nombres de columna ni permite construir consultas arbitrarias. Solo describe UNA posición en
// el orden (published_at desc, id desc) que ya usa el índice cosplay_posts_published_listing.

function encodeCursor(publishedAt: string, id: string): string {
  return Buffer.from(`${publishedAt}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string): { publishedAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sepIndex = decoded.lastIndexOf("|");
    if (sepIndex <= 0 || sepIndex === decoded.length - 1) return null;
    const publishedAt = decoded.slice(0, sepIndex);
    const id = decoded.slice(sepIndex + 1);
    if (Number.isNaN(Date.parse(publishedAt)) || id.length === 0) return null;
    return { publishedAt, id };
  } catch {
    return null;
  }
}

export async function handleCosplayList(
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
  let cursor: { publishedAt: string; id: string } | null = null;
  if (cursorParam) {
    cursor = decodeCursor(cursorParam);
    if (!cursor) return res.status(400).json({ error: "Cursor inválido" });
  }

  try {
    let query = client
      .from("cosplay_posts")
      .select(SELECT_WITH_IMAGES)
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(PAGE_SIZE + 1);

    if (cursor) {
      query = query.or(
        `published_at.lt.${cursor.publishedAt},and(published_at.eq.${cursor.publishedAt},id.lt.${cursor.id})`,
      );
    }

    const { data, error } = await query;
    if (error || !Array.isArray(data)) return res.status(500).json(GENERIC_ERROR_BODY);

    const rows = data as unknown as (CosplayPostRow & {
      cosplay_post_images?: CosplayPostImageRow[];
    })[];
    const hasMore = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);

    const items = page
      .map((row) => mapPostRowToSummary(row, imagesFromRow(row)))
      .filter((item): item is NonNullable<typeof item> => item !== null);

    const last = page.at(-1);
    const nextCursor =
      hasMore && last?.published_at ? encodeCursor(last.published_at, last.id) : null;

    const body: CosplayPostListPage = { items, nextCursor };
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json(body);
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

export async function handleCosplayPost(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const rawSlug = req.query.slug;
  const slug = Array.isArray(rawSlug) ? rawSlug[0] : rawSlug;
  if (!slug || !isValidSlugFormat(slug)) {
    return res.status(404).json({ error: "No encontrado" });
  }

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  try {
    const { data, error } = await client
      .from("cosplay_posts")
      .select(SELECT_WITH_IMAGES)
      .eq("slug", slug)
      .eq("status", "published")
      .maybeSingle();

    if (error) return res.status(500).json(GENERIC_ERROR_BODY);
    // Sin fila (no existe, o existe pero es un borrador): la misma respuesta 404 en ambos casos
    // — nunca se distingue "no existe" de "existe pero no está publicado" (los borradores no
    // deben ser ni siquiera detectables por su slug).
    if (!data) return res.status(404).json({ error: "No encontrado" });

    const row = data as unknown as CosplayPostRow & {
      cosplay_post_images?: CosplayPostImageRow[];
    };
    const detail = mapPostRowToDetail(row, imagesFromRow(row));
    if (!detail) return res.status(404).json({ error: "No encontrado" });

    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json(detail);
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}
