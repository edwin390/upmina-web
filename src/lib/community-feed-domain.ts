import type {
  CommunityFeedAuthor,
  CommunityFeedMediaItem,
  CommunityFeedPage,
  CommunityFeedPost,
} from "../types/index.js";

// Dominio del feed PÚBLICO de Comunidad (Fase 9J-2A): funciones PURAS, sin I/O, compartidas por
// el handler de servidor (community-feed-handlers.ts) y sus tests. Mismo patrón que
// cosplay-domain.ts: nada aquí llama a Supabase ni construye URLs reales (eso lo decide quien
// llama, vía `buildUrl`), así que se prueba sin fakes ni red. El contrato público (los tipos
// importados arriba) vive en types/index.ts, compartido con el frontend — igual que
// CosplayPostListPage.

const PAGE_SIZE = 20;
export const COMMUNITY_FEED_PAGE_SIZE = PAGE_SIZE;

export type {
  CommunityFeedAuthor,
  CommunityFeedMediaItem,
  CommunityFeedPage,
  CommunityFeedPost,
};

// ────────────────────────────────────────────────────────────────────────────────────────────
// Media: un asset reservado/procesándose/borrándose nunca debe aparecer en un feed público, aunque
// el filtro SQL ya lo excluya (defensa en profundidad — mismo criterio que mapImageRow en
// cosplay-domain.ts). Nunca expone storage_key ni ninguna clave de R2: solo la URL ya construida.

interface RawFeedMediaAsset {
  status: string;
  storage_key: string | null;
  width: number | null;
  height: number | null;
}

export interface RawFeedMediaRow {
  id: string;
  position: number;
  media_assets: RawFeedMediaAsset | null;
}

export function mapFeedMediaRow(
  row: RawFeedMediaRow,
  buildUrl: (storageKey: string) => string,
): CommunityFeedMediaItem | null {
  const asset = row.media_assets;
  if (!asset || asset.status !== "ready") return null;
  if (!asset.storage_key || !asset.width || !asset.height) return null;

  return {
    id: row.id,
    position: row.position,
    kind: "image",
    url: buildUrl(asset.storage_key),
    width: asset.width,
    height: asset.height,
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Publicación: el autor SIEMPRE llega ya resuelto (el handler junta profiles por separado, porque
// community_posts no tiene una FK directa hacia profiles que PostgREST pueda embeber — ambas
// referencian auth.users por separado). Nunca se expone author_user_id (UUID) como identidad
// pública: solo username/displayName.

export interface RawFeedPostRow {
  id: string;
  text: string | null;
  created_at: string;
}

export function mapFeedPostRow(
  row: RawFeedPostRow,
  author: CommunityFeedAuthor,
  media: CommunityFeedMediaItem[],
): CommunityFeedPost {
  return {
    id: row.id,
    text: row.text,
    createdAt: row.created_at,
    author,
    media: [...media].sort((a, b) => a.position - b.position),
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Cursor de paginación: opaco para el cliente (base64url de "createdAt|id"), mismo patrón exacto
// que cosplay-handlers.ts (encodeCursor/decodeCursor) — describe una posición en el orden
// (created_at desc, id desc), que ya usa el índice de la migración de 9J-1C.

export function encodeFeedCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

export function decodeFeedCursor(raw: string): { createdAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sepIndex = decoded.lastIndexOf("|");
    if (sepIndex <= 0 || sepIndex === decoded.length - 1) return null;
    const createdAt = decoded.slice(0, sepIndex);
    const id = decoded.slice(sepIndex + 1);
    if (Number.isNaN(Date.parse(createdAt)) || id.length === 0) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
