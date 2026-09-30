import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, requireAuthenticated } from "./admin-auth.js";
import { attemptMediaAssetCleanup } from "./cosplay-media-lifecycle.js";
import { checkPostText, COMMUNITY_POST_MAX_MEDIA } from "./community-post-fields.js";
import { publicVariantUrl } from "./r2-client.js";

// Handlers HTTP de publicaciones de Comunidad (Fase 9J-1C): crear/guardar, reordenar media,
// desadjuntar media, borrar (propio) y listar las publicaciones propias. Despachados desde
// api/admin/[action].ts — SIN crear un dispatcher nuevo: el plan Hobby de Vercel ya tiene sus 12
// funciones Serverless agotadas (ver el comentario de ese archivo). Estas acciones NO son
// privilegiadas: cualquier usuario autenticado con perfil de Comunidad gestiona su PROPIO
// contenido, sin cosplay_admin, sin admin_roles y sin MFA — el checkpoint es explícito ("No
// privileged MFA is required for managing one's own content"). Viven aquí (no en
// cosplay-editor-handlers.ts) porque su modelo de autorización es fundamentalmente distinto:
// requireAuthenticated + re-verificación de PROPIEDAD (author_user_id) bajo lock en la RPC, nunca
// admin_roles.
//
// Igual que cosplay-editor-handlers.ts, la mayor parte del trabajo atómico multi-tabla vive en
// las RPC SECURITY DEFINER de la migración 20261004120000 (community_post_save/_reorder_media/
// _detach_media/_delete), que RE-VERIFICAN que el actor es el AUTOR bajo lock: este archivo nunca
// reimplementa esa regla, solo autoriza (autenticación + perfil), valida la FORMA del body y
// traduce una lista CERRADA de errores (nunca expone el error crudo de Postgres/PostgREST).

const GENERIC_ERROR_BODY = { error: "Error interno" };
const BAD_REQUEST_BODY = { error: "Solicitud inválida" };
const PLPGSQL_RAISE_EXCEPTION_CODE = "P0001";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lista CERRADA de códigos de negocio que las RPC pueden lanzar, y cómo se traducen a HTTP.
 *  Cualquier otro error de Postgres/PostgREST es un 500 genérico. */
const RPC_ERROR_MAP: Readonly<Record<string, { status: number; code: string }>> = {
  invalid_argument: { status: 400, code: "validation" },
  no_profile: { status: 422, code: "profile_required" },
  not_owner: { status: 403, code: "forbidden" },
  post_not_found: { status: 404, code: "not_found" },
  media_not_found: { status: 404, code: "not_found" },
  version_conflict: { status: 409, code: "community_version_conflict" },
  too_many_media: { status: 400, code: "too_many_media" },
  duplicate_asset_id: { status: 400, code: "duplicate_asset_id" },
  invalid_positions: { status: 400, code: "invalid_positions" },
  media_missing_existing: { status: 400, code: "media_missing_existing" },
  invalid_asset: { status: 400, code: "invalid_asset" },
  foreign_asset: { status: 403, code: "foreign_asset" },
  asset_not_ready: { status: 400, code: "asset_not_ready" },
  asset_already_attached: { status: 409, code: "asset_already_attached" },
  empty_post: { status: 422, code: "empty_post" },
};

function getServiceRoleClient(): SupabaseClient | null {
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Autenticado normal (sin MFA, sin admin_roles) — devuelve el userId verificado, o responde y
 *  devuelve null. Gestionar el PROPIO contenido de Comunidad nunca fue una operación privilegiada. */
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

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function rpcErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === PLPGSQL_RAISE_EXCEPTION_CODE && typeof message === "string"
    ? message
    : null;
}

function respondRpcError(res: VercelResponse, error: unknown): VercelResponse {
  const message = rpcErrorMessage(error);
  const mapped = message ? RPC_ERROR_MAP[message] : undefined;
  if (mapped)
    return res
      .status(mapped.status)
      .json({ error: BAD_REQUEST_BODY.error, code: mapped.code });
  return res.status(500).json(GENERIC_ERROR_BODY);
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Forma del body de guardado (POST /api/admin/community-post-save)

interface SaveMediaInput {
  assetId: string;
  position: number;
}

function parseMediaInput(raw: unknown): SaveMediaInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isUuid(r.assetId) ||
    typeof r.position !== "number" ||
    !Number.isInteger(r.position)
  ) {
    return null;
  }
  return { assetId: r.assetId, position: r.position };
}

interface SavePostInput {
  postId: string | null;
  expectedVersion: number | null;
  text: string | null;
  media: SaveMediaInput[];
}

function parseSavePostInput(
  body: Record<string, unknown> | null,
): { ok: true; value: SavePostInput } | { ok: false } {
  if (!body) return { ok: false };
  const postId = body.postId;
  if (postId !== undefined && postId !== null && !isUuid(postId)) return { ok: false };

  const expectedVersion = body.expectedVersion;
  if (
    postId &&
    (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion))
  ) {
    return { ok: false };
  }
  if (!postId && expectedVersion !== undefined && expectedVersion !== null)
    return { ok: false };

  if (body.text !== null && typeof body.text !== "string") return { ok: false };

  if (!Array.isArray(body.media) || body.media.length > COMMUNITY_POST_MAX_MEDIA) {
    return { ok: false };
  }
  const media: SaveMediaInput[] = [];
  for (const raw of body.media) {
    const item = parseMediaInput(raw);
    if (!item) return { ok: false };
    media.push(item);
  }

  return {
    ok: true,
    value: {
      postId: isUuid(postId) ? postId : null,
      expectedVersion: typeof expectedVersion === "number" ? expectedVersion : null,
      text: (body.text as string | null) ?? null,
      media,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Filas crudas de Postgres → contrato neutral de aplicación (camelCase).

interface RawPostRow {
  id: string;
  author_user_id: string;
  text: string | null;
  status: "published" | "hidden";
  version: number;
  created_at: string;
  updated_at: string;
  /** Contador desnormalizado (Fase 9J-2C) — presente en toda fila de community_posts, incluida
   *  una recién creada (empieza en 0). Ver el comentario de cabecera de la migración
   *  20261005120000. */
  like_count: number;
}

function mapPostRowNeutral(row: RawPostRow) {
  return {
    id: row.id,
    text: row.text,
    status: row.status,
    version: row.version,
    likeCount: row.like_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RawMediaRow {
  id: string;
  asset_id: string;
  position: number;
}

function mapMediaRowNeutral(row: RawMediaRow) {
  return { id: row.id, assetId: row.asset_id, position: row.position };
}

export async function handleCommunityPostSave(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const actorId = await authorizeAuthenticated(req, res);
  if (actorId === null) return res;

  const parsed = parseSavePostInput(parseJsonBody(req));
  if (!parsed.ok) return res.status(400).json(BAD_REQUEST_BODY);
  const input = parsed.value;

  const textCheck = checkPostText(input.text);
  if (!textCheck.ok) {
    return res.status(422).json({ error: "Texto inválido", code: "invalid_text" });
  }

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  try {
    const { data, error } = await client.rpc("community_post_save", {
      p_actor_user_id: actorId,
      p_post_id: input.postId,
      p_expected_version: input.expectedVersion,
      p_text: textCheck.value,
      p_media: input.media.map((m) => ({ asset_id: m.assetId, position: m.position })),
    });
    if (error) return respondRpcError(res, error);

    const result = data as { post: RawPostRow; media: RawMediaRow[] };
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      post: mapPostRowNeutral(result.post),
      media: result.media.map(mapMediaRowNeutral),
    });
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// POST /api/admin/community-post-reorder-media

export async function handleCommunityPostReorderMedia(
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
  const expectedVersion = body?.expectedVersion;
  const positions = body?.positions;
  if (
    !isUuid(postId) ||
    typeof expectedVersion !== "number" ||
    !Number.isInteger(expectedVersion) ||
    !Array.isArray(positions) ||
    positions.length > COMMUNITY_POST_MAX_MEDIA
  ) {
    return res.status(400).json(BAD_REQUEST_BODY);
  }
  const parsedPositions: { media_id: string; position: number }[] = [];
  for (const raw of positions) {
    if (
      !raw ||
      typeof raw !== "object" ||
      !isUuid((raw as Record<string, unknown>).mediaId) ||
      typeof (raw as Record<string, unknown>).position !== "number" ||
      !Number.isInteger((raw as Record<string, unknown>).position)
    ) {
      return res.status(400).json(BAD_REQUEST_BODY);
    }
    parsedPositions.push({
      media_id: (raw as Record<string, unknown>).mediaId as string,
      position: (raw as Record<string, unknown>).position as number,
    });
  }

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  try {
    const { data, error } = await client.rpc("community_post_reorder_media", {
      p_actor_user_id: actorId,
      p_post_id: postId,
      p_expected_version: expectedVersion,
      p_positions: parsedPositions,
    });
    if (error) return respondRpcError(res, error);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(data);
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// POST /api/admin/community-post-detach-media

export async function handleCommunityPostDetachMedia(
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
  const expectedVersion = body?.expectedVersion;
  const mediaId = body?.mediaId;
  if (
    !isUuid(postId) ||
    typeof expectedVersion !== "number" ||
    !Number.isInteger(expectedVersion) ||
    !isUuid(mediaId)
  ) {
    return res.status(400).json(BAD_REQUEST_BODY);
  }

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  try {
    const { data, error } = await client.rpc("community_post_detach_media", {
      p_actor_user_id: actorId,
      p_post_id: postId,
      p_expected_version: expectedVersion,
      p_media_id: mediaId,
    });
    if (error) return respondRpcError(res, error);

    const row = data as { asset_id: string; version: number };
    // Limpieza real de R2 DESPUÉS de confirmar la mutación de DB — misma primitiva reutilizada
    // TAL CUAL de cosplay-media-lifecycle.ts (ya agnóstica de domain, nunca duplicada aquí).
    const cleanup = await attemptMediaAssetCleanup(row.asset_id);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      version: row.version,
      assetId: row.asset_id,
      cleaned: cleanup.cleaned,
    });
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// POST /api/admin/community-post-delete

export async function handleCommunityPostDelete(
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
  const expectedVersion = body?.expectedVersion;
  if (
    !isUuid(postId) ||
    typeof expectedVersion !== "number" ||
    !Number.isInteger(expectedVersion)
  ) {
    return res.status(400).json(BAD_REQUEST_BODY);
  }

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  try {
    const { data, error } = await client.rpc("community_post_delete", {
      p_actor_user_id: actorId,
      p_post_id: postId,
      p_expected_version: expectedVersion,
    });
    if (error) return respondRpcError(res, error);

    const row = data as { deleted_asset_ids: string[] };
    const assetIds = Array.isArray(row.deleted_asset_ids) ? row.deleted_asset_ids : [];
    const cleanupResults = await Promise.all(
      assetIds.map((assetId) => attemptMediaAssetCleanup(assetId)),
    );

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      postId,
      deletedAssets: cleanupResults,
      allCleaned: cleanupResults.every((r) => r.cleaned),
    });
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// GET /api/admin/community-post-list-own — lecturas del propio autor (nunca de otro usuario:
// author_user_id sale SIEMPRE del JWT verificado, nunca de un query param). Sin RPC: una lectura
// simple no necesita atomicidad multi-tabla (mismo criterio que cosplay-post-list-admin).

const OWN_SELECT_WITH_MEDIA =
  "id, text, status, version, created_at, updated_at, like_count, community_post_media(id, asset_id, position, media_assets(id, status, width, height, storage_key))";

interface OwnMediaAssetRow {
  id: string;
  status: string;
  width: number | null;
  height: number | null;
  storage_key: string | null;
}

interface OwnMediaRow {
  id: string;
  asset_id: string;
  position: number;
  media_assets: OwnMediaAssetRow | null;
}

interface OwnPostRow extends RawPostRow {
  community_post_media?: OwnMediaRow[];
}

function mapOwnMediaRow(row: OwnMediaRow) {
  const asset = row.media_assets;
  return {
    ...mapMediaRowNeutral(row),
    assetStatus: asset?.status ?? null,
    width: asset?.width ?? null,
    height: asset?.height ?? null,
    url:
      asset && asset.status === "ready" && asset.storage_key
        ? publicVariantUrl(asset.storage_key)
        : null,
  };
}

export async function handleCommunityPostListOwn(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const actorId = await authorizeAuthenticated(req, res);
  if (actorId === null) return res;

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  try {
    const { data, error } = await client
      .from("community_posts")
      .select(OWN_SELECT_WITH_MEDIA)
      .eq("author_user_id", actorId)
      .order("created_at", { ascending: false });
    if (error || !Array.isArray(data)) return res.status(500).json(GENERIC_ERROR_BODY);

    const rows = data as unknown as OwnPostRow[];
    const items = rows.map((row) => ({
      ...mapPostRowNeutral(row),
      media: (row.community_post_media ?? [])
        .map(mapOwnMediaRow)
        .sort((a, b) => a.position - b.position),
    }));

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ items });
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}
