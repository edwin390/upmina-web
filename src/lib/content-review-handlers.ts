import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, authErrorBody, requireCapability } from "./admin-auth.js";
import { decodeFeedCursor, encodeFeedCursor } from "./community-feed-domain.js";
import { loadMediaUrlContext, moderatorMediaUrls } from "./media-delivery-url.js";
import { uuid } from "./moderation-case-parser.js";

// PHASE-3: cola de revisión de contenido (publicaciones retenidas y ediciones pendientes) del panel de Moderación.
// Cada petición exige JWT verificado + capacidad `moderation` + MFA reciente (requireCapability) ANTES de tocar datos.
// La lógica de negocio vive en SQL: la lectura es community_content_review_read y las decisiones llaman, en la misma
// transacción que su auditoría, a las RPC de Fase 2 (community_content_review_decide). Aquí solo se valida, se traduce
// el error y se resuelven las URLs de los medios: los privados SOLO con capability de moderador (corta, por archivo).
// Nunca se hace público un archivo pendiente y no se escribe ninguna URL, token ni texto en logs.

const PAGE_SIZE = 20;
const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/;

const DECISION_ERRORS: Readonly<Record<string, number>> = {
  invalid_argument: 400,
  actor_not_moderator: 403,
  pending_edit_not_found: 404,
  post_not_found: 404,
  version_conflict: 409,
  edit_not_pending: 409,
  post_not_held: 409,
  post_not_editable: 409,
  asset_not_ready: 409,
  post_copyright_protected: 409,
  media_required: 409,
  empty_post: 409,
  too_many_media: 409,
  too_many_videos: 409,
};

function serviceClient(): SupabaseClient {
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Configuration unavailable");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function authorize(req: VercelRequest, res: VercelResponse): Promise<string | null> {
  try {
    return (await requireCapability(req, "moderation")).userId;
  } catch (error) {
    if (error instanceof AdminAuthError) res.status(error.status).json(authErrorBody(error));
    else res.status(500).json({ error: "Error interno", code: "internal_failure" });
    return null;
  }
}

const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Invalid projection");
  return v as Record<string, unknown>;
};
const list = (v: unknown, max: number): unknown[] => {
  if (!Array.isArray(v) || v.length > max) throw new Error("Invalid bound");
  return v;
};
const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || v.length > 5000) throw new Error("Invalid text");
  return v;
};
const int = (v: unknown): number => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error("Invalid integer");
  return v as number;
};
const stamp = (v: unknown): string => {
  if (typeof v !== "string" || !CURSOR_TIMESTAMP.test(v) || Number.isNaN(Date.parse(v)))
    throw new Error("Invalid timestamp");
  return v;
};

interface MediaRef {
  assetId: string;
  position: number;
  isNew: boolean;
}
function mediaRefs(value: unknown): MediaRef[] {
  return list(value, 10).map((v) => {
    const r = record(v);
    if (!uuid(r.assetId) || typeof r.isNew !== "boolean") throw new Error("Invalid media");
    return { assetId: r.assetId, position: int(r.position), isNew: r.isNew };
  });
}
function author(value: unknown) {
  const r = record(value);
  const name = (v: unknown) => (typeof v === "string" && v.length <= 200 ? v : null);
  return { username: name(r.username), displayName: name(r.displayName) };
}

interface AssetRow {
  id: string;
  kind: "image" | "video";
  status: string;
  storage_key: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
}

async function lookupAssets(client: SupabaseClient, ids: string[]): Promise<Map<string, AssetRow>> {
  const map = new Map<string, AssetRow>();
  if (ids.length === 0) return map;
  const result = await client
    .from("media_assets")
    .select("id,domain,status,kind,storage_key,width,height,duration_seconds")
    .in("id", ids);
  if (result.error || !Array.isArray(result.data)) throw new Error("Media lookup failed");
  for (const v of result.data) {
    const r = record(v);
    if (!uuid(r.id) || r.domain !== "community" || map.has(r.id)) throw new Error("Invalid asset");
    if (r.kind !== "image" && r.kind !== "video") continue;
    map.set(r.id, {
      id: r.id,
      kind: r.kind,
      status: String(r.status),
      storage_key: typeof r.storage_key === "string" ? r.storage_key : null,
      width: typeof r.width === "number" ? r.width : null,
      height: typeof r.height === "number" ? r.height : null,
      duration_seconds: typeof r.duration_seconds === "number" ? r.duration_seconds : null,
    });
  }
  return map;
}

/** URL por archivo. `publicState` = los que ya forman parte de la versión PÚBLICA (URL pública); los demás (retenidos o
 *  nuevos de una edición) llevan capability `moderator`. Sin URL disponible (modo legado sin Worker) → null, nunca una
 *  URL pública. */
async function resolveUrls(
  assets: Map<string, AssetRow>,
  publicIds: Set<string>,
  privateIds: Set<string>,
): Promise<Map<string, string>> {
  const context = await loadMediaUrlContext();
  const keyOf = (id: string) => {
    const a = assets.get(id);
    return a && a.status === "ready" && a.storage_key ? a.storage_key : null;
  };
  const pick = (ids: Set<string>) => [...ids].flatMap((id) => (keyOf(id) ? [keyOf(id)!] : []));
  const nowMs = Date.now();
  const urls = new Map<string, string>();
  for (const [status, keys] of [
    ["published", pick(publicIds)],
    ["held_for_review", pick(privateIds)],
  ] as const) {
    if (keys.length === 0) continue;
    const byKey = await moderatorMediaUrls(context, { status, purgeAfterMs: null, nowMs, storageKeys: keys });
    for (const [key, url] of byKey) urls.set(key, url);
  }
  return urls;
}

function outMedia(refs: MediaRef[], assets: Map<string, AssetRow>, urls: Map<string, string>) {
  return refs
    .sort((a, b) => a.position - b.position)
    .map((m) => {
      const a = assets.get(m.assetId);
      const key = a && a.status === "ready" ? a.storage_key : null;
      return {
        assetId: m.assetId,
        position: m.position,
        isNew: m.isNew,
        kind: a?.kind ?? null,
        width: a?.width ?? null,
        height: a?.height ?? null,
        durationSeconds: a?.kind === "video" ? a.duration_seconds : null,
        url: key ? (urls.get(key) ?? null) : null,
      };
    });
}

/** GET ?scope=held|edits[&cursor=…][&id=…] → cola paginada (20) o un único elemento con su detalle. */
export async function handleContentReviewList(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }
  const actor = await authorize(req, res);
  if (!actor) return res;

  const scope = req.query.scope;
  const rawCursor = req.query.cursor;
  const itemId = req.query.id;
  const cursor =
    typeof rawCursor === "string" && rawCursor.length <= 256 ? decodeFeedCursor(rawCursor) : null;
  if (
    (scope !== "held" && scope !== "edits") ||
    (rawCursor !== undefined && (!cursor || !uuid(cursor.id) || !CURSOR_TIMESTAMP.test(cursor.createdAt))) ||
    (itemId !== undefined && (!uuid(itemId) || rawCursor !== undefined)) ||
    Object.keys(req.query).some((k) => !["action", "scope", "cursor", "id"].includes(k))
  )
    return res.status(400).json({ error: "Solicitud inválida", code: "validation" });

  try {
    const client = serviceClient();
    const { data, error } = await client.rpc("community_content_review_read", {
      p_actor_user_id: actor,
      p_scope: scope,
      p_before_created: cursor?.createdAt ?? null,
      p_before_id: cursor?.id ?? null,
      p_limit: PAGE_SIZE,
      p_item_id: typeof itemId === "string" ? itemId : null,
    });
    if (error) {
      if (error.code === "P0001" && error.message === "actor_not_moderator")
        return res.status(403).json({ error: "Acceso no autorizado", code: error.message });
      throw new Error("Read failed");
    }
    const body = record(data);
    const raw = list(body.items, PAGE_SIZE).map(record);
    const counts = record(body.counts);

    const ids = new Set<string>();
    const publicIds = new Set<string>();
    const privateIds = new Set<string>();
    const collect = (refs: MediaRef[], isPublic: (m: MediaRef) => boolean) =>
      refs.forEach((m) => {
        ids.add(m.assetId);
        (isPublic(m) ? publicIds : privateIds).add(m.assetId);
      });
    const parsed = raw.map((r) => {
      if (scope === "held") {
        const media = mediaRefs(r.media);
        collect(media, () => false);
        return { r, media };
      }
      const published = mediaRefs(record(r.published).media);
      const proposed = mediaRefs(record(r.proposed).media);
      collect(published, () => true);
      collect(proposed, (m) => !m.isNew);
      return { r, published, proposed };
    });
    const assets = await lookupAssets(client, [...ids]);
    const urls = await resolveUrls(assets, publicIds, privateIds);

    const items = parsed.map((p) => {
      const base = { id: String(p.r.id), postId: String(p.r.postId), version: int(p.r.version), author: author(p.r.author) };
      if (!uuid(base.id) || !uuid(base.postId)) throw new Error("Invalid id");
      if (scope === "held")
        return {
          kind: "held_post" as const,
          ...base,
          createdAt: stamp(p.r.createdAt),
          text: text(p.r.text),
          media: outMedia(p.media!, assets, urls),
        };
      return {
        kind: "pending_edit" as const,
        ...base,
        baseVersion: int(p.r.baseVersion),
        stale: p.r.stale === true,
        postStatus: String(p.r.postStatus),
        requestedAt: stamp(p.r.requestedAt),
        published: { text: text(record(p.r.published).text), media: outMedia(p.published!, assets, urls) },
        proposed: { text: text(record(p.r.proposed).text), media: outMedia(p.proposed!, assets, urls) },
      };
    });
    const next = body.next === null || body.next === undefined ? null : record(body.next);
    return res.status(200).json({
      items,
      nextCursor: next ? encodeFeedCursor(stamp(next.createdAt), String(next.id)) : null,
      counts: { held: int(counts.held), edits: int(counts.edits) },
    });
  } catch {
    return res.status(500).json({ error: "Error interno", code: "internal_failure" });
  }
}

/** POST { kind: "held_post"|"pending_edit", id, decision: "approve"|"reject", expectedVersion } */
export async function handleContentReviewDecision(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }
  const actor = await authorize(req, res);
  if (!actor) return res;

  let input: { kind: string; id: string; decision: string; expectedVersion: number | null };
  try {
    const body = record(typeof req.body === "string" ? JSON.parse(req.body) : req.body);
    const { kind, id, decision, expectedVersion } = body;
    if (
      (kind !== "held_post" && kind !== "pending_edit") ||
      (decision !== "approve" && decision !== "reject") ||
      !uuid(id) ||
      Object.keys(body).some((k) => !["kind", "id", "decision", "expectedVersion"].includes(k))
    )
      throw new Error("invalid");
    let version: number | null = null;
    if (expectedVersion !== undefined && expectedVersion !== null) {
      if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 1) throw new Error("invalid");
      version = expectedVersion as number;
    }
    if (version === null && (kind === "held_post" || decision === "approve")) throw new Error("invalid");
    input = { kind, id, decision, expectedVersion: version };
  } catch {
    return res.status(400).json({ error: "Solicitud inválida", code: "validation" });
  }

  try {
    const { data, error } = await serviceClient().rpc("community_content_review_decide", {
      p_actor_user_id: actor,
      p_kind: input.kind,
      p_target_id: input.id,
      p_expected_version: input.expectedVersion,
      p_decision: input.decision,
    });
    if (error) {
      if (error.code === "P0001" && Object.prototype.hasOwnProperty.call(DECISION_ERRORS, error.message))
        return res
          .status(DECISION_ERRORS[error.message]!)
          .json({ error: "No se pudo completar la revisión", code: error.message });
      throw new Error("Decision failed");
    }
    const r = record(data);
    if (!uuid(r.postId) || r.decision !== input.decision || r.kind !== input.kind)
      return res.status(500).json({ error: "Respuesta inválida", code: "invalid_response" });
    return res.status(200).json({ decision: r.decision, kind: r.kind, postId: r.postId });
  } catch {
    return res.status(500).json({ error: "Error interno", code: "internal_failure" });
  }
}
