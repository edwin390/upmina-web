import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, authErrorBody, requireCapability } from "./admin-auth.js";
import { generateUniqueSlug, slugify } from "./cosplay-domain.js";
import { attemptMediaAssetCleanup } from "./cosplay-media-lifecycle.js";

// Handlers HTTP del editor ADMIN de Cosplay (Fase 9I-3, checkpoint 2): crear/guardar/publicar,
// actualizar con concurrencia optimista, reordenar, desadjuntar y borrar en duro. Despachados
// desde api/admin/[action].ts (función 12/12 del plan Hobby) — ninguna acción nueva de este
// archivo suma una Serverless Function.
//
// Toda mutación exige EXACTAMENTE requireCapability(req, "cosplay_admin") — autenticación → rol
// actual → capacidad → MFA reciente, en ese orden (ver admin-auth.ts) — y la mayor parte del
// trabajo atómico multi-tabla vive en las RPC SECURITY DEFINER de la migración 20261002120000
// (cosplay_admin_save_post/_reorder_images/_detach_image/_delete_post), que RE-VERIFICAN que el
// actor sigue siendo ADMIN bajo lock: este archivo nunca reimplementa esas reglas, solo autoriza,
// valida la FORMA del body y traduce una lista CERRADA de errores (nunca expone el error crudo de
// Postgres/PostgREST). Las lecturas ADMIN (list/get) usan el mismo requireCapability — el proyecto
// no tiene precedente de un gate de capacidad SIN MFA para ninguna lectura privilegiada, así que
// no se inventa uno aquí (ver el checkpoint, sección 5).

const GENERIC_ERROR_BODY = { error: "Error interno" };
const BAD_REQUEST_BODY = { error: "Solicitud inválida" };
const NOT_FOUND_BODY = { error: "No encontrado" };
const PLPGSQL_RAISE_EXCEPTION_CODE = "P0001";
const MAX_PHOTOS = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lista CERRADA de códigos de negocio que las RPC pueden lanzar (RAISE EXCEPTION sin SQLSTATE
 *  propio => P0001), y cómo se traducen a HTTP. Cualquier otro error de Postgres/PostgREST es un
 *  500 genérico: nunca se expone un mensaje crudo del proveedor. */
const RPC_ERROR_MAP: Readonly<Record<string, { status: number; code: string }>> = {
  invalid_argument: { status: 400, code: "validation" },
  missing_title_es: { status: 422, code: "missing_title_es" },
  too_many_photos: { status: 400, code: "too_many_photos" },
  duplicate_asset_id: { status: 400, code: "duplicate_asset_id" },
  invalid_positions: { status: 400, code: "invalid_positions" },
  multiple_covers: { status: 422, code: "multiple_covers" },
  images_missing_existing: { status: 400, code: "images_missing_existing" },
  unpublish_not_supported: { status: 400, code: "unpublish_not_supported" },
  post_not_found: { status: 404, code: "not_found" },
  image_not_found: { status: 404, code: "not_found" },
  version_conflict: { status: 409, code: "cosplay_version_conflict" },
  invalid_asset: { status: 400, code: "invalid_asset" },
  foreign_asset: { status: 403, code: "foreign_asset" },
  asset_not_ready: { status: 400, code: "asset_not_ready" },
  asset_already_attached: { status: 409, code: "asset_already_attached" },
  no_ready_images: { status: 422, code: "no_ready_images" },
  no_cover: { status: 422, code: "no_cover" },
  missing_alt_es: { status: 422, code: "missing_alt_es" },
  actor_not_admin: { status: 403, code: "forbidden" },
};

function getServiceRoleClient(): SupabaseClient | null {
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Autoriza con cosplay_admin (capacidad + MFA reciente, ver admin-auth.ts) y devuelve el userId
 *  verificado, o responde y devuelve null. */
async function authorizeCosplayAdmin(
  req: VercelRequest,
  res: VercelResponse,
): Promise<string | null> {
  try {
    const { userId } = await requireCapability(req, "cosplay_admin");
    return userId;
  } catch (err) {
    if (err instanceof AdminAuthError) {
      res.status(err.status).json(authErrorBody(err));
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

/** Traduce un error de RPC a una respuesta pública. Todo lo no reconocido es 500 genérico —
 *  nunca se expone el mensaje/código crudo de Postgres. */
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
// Forma del body de guardado/publicación (POST /api/admin/cosplay-post-save)

interface SaveImageInput {
  assetId: string;
  position: number;
  isCover: boolean;
  decorative: boolean;
  altEs: string | null;
  altEn: string | null;
  altDe: string | null;
  captionEs: string | null;
  captionEn: string | null;
  captionDe: string | null;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function parseImageInput(raw: unknown): SaveImageInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isUuid(r.assetId) ||
    typeof r.position !== "number" ||
    !Number.isInteger(r.position)
  ) {
    return null;
  }
  const altEs = optionalString(r.altEs);
  const altEn = optionalString(r.altEn);
  const altDe = optionalString(r.altDe);
  const captionEs = optionalString(r.captionEs);
  const captionEn = optionalString(r.captionEn);
  const captionDe = optionalString(r.captionDe);
  if (
    altEs === undefined ||
    altEn === undefined ||
    altDe === undefined ||
    captionEs === undefined ||
    captionEn === undefined ||
    captionDe === undefined
  ) {
    return null;
  }
  return {
    assetId: r.assetId,
    position: r.position,
    isCover: r.isCover === true,
    decorative: r.decorative === true,
    altEs,
    altEn,
    altDe,
    captionEs,
    captionEn,
    captionDe,
  };
}

interface SavePostInput {
  postId: string | null;
  expectedVersion: number | null;
  status: "draft" | "published";
  titleEs: string;
  titleEn: string | null;
  titleDe: string | null;
  descriptionEs: string | null;
  descriptionEn: string | null;
  descriptionDe: string | null;
  characterName: string | null;
  series: string | null;
  event: string | null;
  shotOn: string | null;
  photographerCredit: string | null;
  images: SaveImageInput[];
}

function parseSavePostInput(body: Record<string, unknown> | null): SavePostInput | null {
  if (!body) return null;
  const postId = body.postId;
  if (postId !== undefined && postId !== null && !isUuid(postId)) return null;

  const expectedVersion = body.expectedVersion;
  if (
    postId &&
    (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion))
  ) {
    return null;
  }
  if (!postId && expectedVersion !== undefined && expectedVersion !== null) return null;

  if (body.status !== "draft" && body.status !== "published") return null;
  if (typeof body.titleEs !== "string" || body.titleEs.trim().length === 0) return null;

  const titleEn = optionalString(body.titleEn);
  const titleDe = optionalString(body.titleDe);
  const descriptionEs = optionalString(body.descriptionEs);
  const descriptionEn = optionalString(body.descriptionEn);
  const descriptionDe = optionalString(body.descriptionDe);
  const characterName = optionalString(body.characterName);
  const series = optionalString(body.series);
  const event = optionalString(body.event);
  const shotOn = optionalString(body.shotOn);
  const photographerCredit = optionalString(body.photographerCredit);
  if (
    titleEn === undefined ||
    titleDe === undefined ||
    descriptionEs === undefined ||
    descriptionEn === undefined ||
    descriptionDe === undefined ||
    characterName === undefined ||
    series === undefined ||
    event === undefined ||
    shotOn === undefined ||
    photographerCredit === undefined
  ) {
    return null;
  }

  if (!Array.isArray(body.images) || body.images.length > MAX_PHOTOS) return null;
  const images: SaveImageInput[] = [];
  for (const raw of body.images) {
    const image = parseImageInput(raw);
    if (!image) return null;
    images.push(image);
  }

  return {
    postId: isUuid(postId) ? postId : null,
    expectedVersion: typeof expectedVersion === "number" ? expectedVersion : null,
    status: body.status,
    titleEs: body.titleEs,
    titleEn,
    titleDe,
    descriptionEs,
    descriptionEn,
    descriptionDe,
    characterName,
    series,
    event,
    shotOn,
    photographerCredit,
    images,
  };
}

/** Slug candidato: para una publicación nueva o mientras siga en borrador, se deriva del título
 *  ES y se resuelve contra los slugs YA existentes (excluyendo la propia fila al actualizar). Si
 *  la publicación ya está publicada, la RPC ignora este valor (slug inmutable) — se calcula igual
 *  porque el handler no conoce el estado actual sin una consulta adicional, y es inofensivo. */
async function resolveSlugCandidate(
  client: SupabaseClient,
  titleEs: string,
  excludePostId: string | null,
): Promise<string | null> {
  let query = client.from("cosplay_posts").select("slug");
  if (excludePostId) query = query.neq("id", excludePostId);
  const { data, error } = await query;
  if (error || !Array.isArray(data)) return null;
  const existing = new Set((data as { slug: string }[]).map((r) => r.slug));
  return generateUniqueSlug(slugify(titleEs), existing);
}

export async function handleCosplayPostSave(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const actorId = await authorizeCosplayAdmin(req, res);
  if (actorId === null) return res;

  const input = parseSavePostInput(parseJsonBody(req));
  if (!input) return res.status(400).json(BAD_REQUEST_BODY);

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  const slugCandidate = await resolveSlugCandidate(client, input.titleEs, input.postId);
  if (slugCandidate === null) return res.status(500).json(GENERIC_ERROR_BODY);

  try {
    const { data, error } = await client.rpc("cosplay_admin_save_post", {
      p_actor_user_id: actorId,
      p_post_id: input.postId,
      p_expected_version: input.expectedVersion,
      p_status: input.status,
      p_slug: slugCandidate,
      p_title_es: input.titleEs,
      p_title_en: input.titleEn,
      p_title_de: input.titleDe,
      p_description_es: input.descriptionEs,
      p_description_en: input.descriptionEn,
      p_description_de: input.descriptionDe,
      p_character_name: input.characterName,
      p_series: input.series,
      p_event: input.event,
      p_shot_on: input.shotOn,
      p_photographer_credit: input.photographerCredit,
      p_images: input.images.map((image) => ({
        asset_id: image.assetId,
        position: image.position,
        is_cover: image.isCover,
        decorative: image.decorative,
        alt_es: image.altEs,
        alt_en: image.altEn,
        alt_de: image.altDe,
        caption_es: image.captionEs,
        caption_en: image.captionEn,
        caption_de: image.captionDe,
      })),
    });
    if (error) return respondRpcError(res, error);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(data);
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// POST /api/admin/cosplay-post-reorder

export async function handleCosplayPostReorder(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const actorId = await authorizeCosplayAdmin(req, res);
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
    positions.length > MAX_PHOTOS
  ) {
    return res.status(400).json(BAD_REQUEST_BODY);
  }
  const parsedPositions: { image_id: string; position: number }[] = [];
  for (const raw of positions) {
    if (
      !raw ||
      typeof raw !== "object" ||
      !isUuid((raw as Record<string, unknown>).imageId) ||
      typeof (raw as Record<string, unknown>).position !== "number" ||
      !Number.isInteger((raw as Record<string, unknown>).position)
    ) {
      return res.status(400).json(BAD_REQUEST_BODY);
    }
    parsedPositions.push({
      image_id: (raw as Record<string, unknown>).imageId as string,
      position: (raw as Record<string, unknown>).position as number,
    });
  }

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  try {
    const { data, error } = await client.rpc("cosplay_admin_reorder_images", {
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
// POST /api/admin/cosplay-media-detach

export async function handleCosplayMediaDetach(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const actorId = await authorizeCosplayAdmin(req, res);
  if (actorId === null) return res;

  const body = parseJsonBody(req);
  const postId = body?.postId;
  const expectedVersion = body?.expectedVersion;
  const imageId = body?.imageId;
  if (
    !isUuid(postId) ||
    typeof expectedVersion !== "number" ||
    !Number.isInteger(expectedVersion) ||
    !isUuid(imageId)
  ) {
    return res.status(400).json(BAD_REQUEST_BODY);
  }

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  try {
    const { data, error } = await client.rpc("cosplay_admin_detach_image", {
      p_actor_user_id: actorId,
      p_post_id: postId,
      p_expected_version: expectedVersion,
      p_image_id: imageId,
    });
    if (error) return respondRpcError(res, error);

    const row = data as { asset_id: string; version: number };
    // Limpieza real de R2 DESPUÉS de confirmar la mutación de DB (la relación de galería ya está
    // borrada y el asset ya está 'deleting' pase lo que pase aquí abajo): si esto falla, el asset
    // queda en 'deleting' — recuperable por un reintento posterior — y se reporta honestamente.
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
// POST /api/admin/cosplay-post-delete

export async function handleCosplayPostDelete(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const actorId = await authorizeCosplayAdmin(req, res);
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
    const { data, error } = await client.rpc("cosplay_admin_delete_post", {
      p_actor_user_id: actorId,
      p_post_id: postId,
      p_expected_version: expectedVersion,
    });
    if (error) return respondRpcError(res, error);

    const row = data as { deleted_asset_ids: string[] };
    const assetIds = Array.isArray(row.deleted_asset_ids) ? row.deleted_asset_ids : [];
    // La publicación YA está borrada (transacción confirmada, auditoría escrita): la limpieza de
    // R2 es best-effort a partir de aquí. Un fallo parcial deja los assets afectados en
    // 'deleting' (recuperable) y se reporta honestamente, nunca como éxito completo.
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
// Lecturas ADMIN (sección 14 del checkpoint): listar publicaciones gestionables (draft +
// published) y cargar una publicación completa para editar. NUNCA expuestas por las rutas
// públicas (/api/content/*, que solo filtran status='published' — ver cosplay-handlers.ts).

const ADMIN_SELECT_WITH_IMAGES =
  "*, cosplay_post_images(id, asset_id, position, is_cover, decorative, alt_es, alt_en, alt_de, caption_es, caption_en, caption_de, media_assets(id, status, width, height, storage_key))";

export async function handleCosplayPostListAdmin(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const actorId = await authorizeCosplayAdmin(req, res);
  if (actorId === null) return res;

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  try {
    const { data, error } = await client
      .from("cosplay_posts")
      .select("id, slug, status, title_es, version, published_at, updated_at")
      .order("updated_at", { ascending: false });
    if (error || !Array.isArray(data)) return res.status(500).json(GENERIC_ERROR_BODY);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ items: data });
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

export async function handleCosplayPostGetAdmin(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }

  const actorId = await authorizeCosplayAdmin(req, res);
  if (actorId === null) return res;

  const rawId = req.query.postId;
  const postId = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!isUuid(postId)) return res.status(400).json(BAD_REQUEST_BODY);

  const client = getServiceRoleClient();
  if (!client) return res.status(500).json(GENERIC_ERROR_BODY);

  try {
    const { data, error } = await client
      .from("cosplay_posts")
      .select(ADMIN_SELECT_WITH_IMAGES)
      .eq("id", postId)
      .maybeSingle();
    if (error) return res.status(500).json(GENERIC_ERROR_BODY);
    if (!data) return res.status(404).json(NOT_FOUND_BODY);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(data);
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}
