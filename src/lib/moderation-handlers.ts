import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  mapFeedMediaRow,
  type RawFeedMediaRow,
} from "./community-feed-domain.js";
import { loadMediaUrlContext, moderatorMediaUrls } from "./media-delivery-url.js";
import type { CommunityFeedMediaItem } from "../types/index.js";
import {
  AdminAuthError,
  authErrorBody,
  requireAuthenticated,
  requireCapability,
} from "./admin-auth.js";

// Workflow de moderación (9K-2), sobre la foundation 9K-1. Cuatro rutas:
//
//   POST /api/admin/moderation-report-create   cualquier usuario AUTENTICADO reporta una
//                                               publicación de Community (requireAuthenticated,
//                                               NUNCA requireCapability: reportar no es una
//                                               acción de moderación).
//   GET  /api/admin/moderation-reports         cola de reportes (capacidad `moderation`).
//   GET  /api/admin/moderation-report          detalle de un reporte + preview del contenido
//                                               reportado, si todavía existe (capacidad
//                                               `moderation`).
//   POST /api/admin/moderation-report-status   cambia el estado de un reporte (capacidad
//                                               `moderation`).
//
// La RPC 9K-2 bloquea rol/post/reporte y valida versiones. HTTP verifica JWT y MFA
// reciente; el actor jamás proviene del body. Lecturas de contexto no son snapshots:
// la mutación valida nuevamente las versiones leídas antes de modificar nada.

const GENERIC_ERROR_BODY = { error: "Error interno" };
const INVALID_BODY = { error: "Solicitud inválida" };
const NOT_FOUND_BODY = { error: "No encontrado" };

const REASONS = ["spam", "harassment", "hate_speech", "sexual_content", "other"] as const;
export type ModerationReportReason = (typeof REASONS)[number];

const STATUSES = ["open", "reviewing", "resolved", "dismissed", "actioned"] as const;
export type ModerationReportStatus = (typeof STATUSES)[number];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isReason(value: unknown): value is ModerationReportReason {
  return typeof value === "string" && (REASONS as readonly string[]).includes(value);
}

function isStatus(value: unknown): value is ModerationReportStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function getServiceClient() {
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase no configurado");
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
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

function rpcBusinessError(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === "P0001" && typeof message === "string" ? message : null;
}

/** Autoriza con la capacidad `moderation` (moderator/developer/admin) y devuelve el userId
 *  verificado, o responde y devuelve null. Mismo patrón que authorizeTeamAdmin. */
async function authorizeModerator(
  req: VercelRequest,
  res: VercelResponse,
): Promise<string | null> {
  try {
    const { userId } = await requireCapability(req, "moderation");
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

export interface ModerationReportSummary {
  id: string;
  version: number;
  postId: string;
  reason: ModerationReportReason;
  status: ModerationReportStatus;
  createdAt: string;
  /** Solo presente si la publicación reportada todavía existe. */
  postPreview: {
    text: string | null;
    status: string;
    authorUsername: string | null;
    version: number;
    updatedAt: string;
  } | null;
}

const LIST_COLUMNS = "id, post_id, reason, status, created_at, version";
const LIST_LIMIT = 50;

interface ReportRow {
  id: unknown;
  post_id: unknown;
  reason: unknown;
  status: unknown;
  created_at: unknown;
  version: unknown;
}

function isReportRow(row: unknown): row is ReportRow {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return (
    isUuid(r.id) &&
    isUuid(r.post_id) &&
    isReason(r.reason) &&
    isStatus(r.status) &&
    typeof r.created_at === "string" &&
    Number.isInteger(r.version) &&
    Number(r.version) >= 1
  );
}

/** Preview del contenido reportado (texto truncado + username del autor), leído aparte porque
 *  community_post_reports.post_id NO tiene FK (debe sobrevivir al borrado de la publicación) —
 *  así que PostgREST no puede embeberlo automáticamente. Ausente (null) si la publicación ya no
 *  existe: eso NO es un error, es exactamente lo que puede pasar tras un borrado del autor. */
async function fetchPostPreviews(
  client: ReturnType<typeof getServiceClient>,
  postIds: string[],
  fullText = false,
): Promise<Map<string, NonNullable<ModerationReportSummary["postPreview"]>>> {
  const preview = new Map<string, NonNullable<ModerationReportSummary["postPreview"]>>();
  if (postIds.length === 0) return preview;

  const { data: posts, error } = await client
    .from("community_posts")
    .select("id, text, status, author_user_id, version, updated_at")
    .in("id", postIds);
  if (error || !Array.isArray(posts)) throw new Error("Post context unavailable");

  const authorIds = Array.from(
    new Set(
      posts
        .map((p) => (p as { author_user_id?: unknown }).author_user_id)
        .filter((v): v is string => typeof v === "string"),
    ),
  );
  const usernames = new Map<string, string>();
  if (authorIds.length > 0) {
    const { data: profiles, error: profileError } = await client
      .from("profiles")
      .select("user_id, username")
      .in("user_id", authorIds);
    if (profileError) throw new Error("Author context unavailable");
    for (const p of profiles ?? []) {
      const row = p as { user_id?: unknown; username?: unknown };
      if (typeof row.user_id === "string" && typeof row.username === "string") {
        usernames.set(row.user_id, row.username);
      }
    }
  }

  const MAX_PREVIEW_CHARS = 280;
  for (const p of posts) {
    const row = p as {
      id?: unknown;
      text?: unknown;
      status?: unknown;
      author_user_id?: unknown;
      version?: unknown;
      updated_at?: unknown;
    };
    if (typeof row.id !== "string") continue;
    const text =
      typeof row.text === "string"
        ? fullText
          ? row.text
          : row.text.slice(0, MAX_PREVIEW_CHARS)
        : null;
    if (
      (row.status !== "published" &&
        row.status !== "hidden_pending_review" &&
        row.status !== "hidden") ||
      !Number.isInteger(row.version) ||
      Number(row.version) < 1 ||
      typeof row.updated_at !== "string"
    )
      throw new Error("Invalid post context");
    const status = row.status;
    const authorUsername =
      typeof row.author_user_id === "string"
        ? (usernames.get(row.author_user_id) ?? null)
        : null;
    preview.set(row.id, {
      text,
      status,
      authorUsername,
      version: Number(row.version),
      updatedAt: row.updated_at,
    });
  }
  return preview;
}

// Active queue first; closed reports remain discoverable through the history tab.
export async function handleModerationReports(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }
  if ((await authorizeModerator(req, res)) === null) return res;

  const scope = req.query.scope ?? "active";
  const cursorRaw = req.query.cursor;
  if (
    (scope !== "active" && scope !== "closed") ||
    (cursorRaw !== undefined && (typeof cursorRaw !== "string" || cursorRaw.length > 256))
  )
    return res.status(400).json(INVALID_BODY);
  const cursor = typeof cursorRaw === "string" ? decodeFeedCursor(cursorRaw) : null;
  if (
    cursorRaw !== undefined &&
    (!cursor ||
      !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(cursor.createdAt))
  )
    return res.status(400).json(INVALID_BODY);

  try {
    const client = getServiceClient();
    let query = client
      .from("community_post_reports")
      .select(LIST_COLUMNS)
      .in(
        "status",
        scope === "active" ? ["open", "reviewing"] : ["resolved", "dismissed"],
      )
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    if (cursor)
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
      );
    const { data, error } = await query.limit(LIST_LIMIT + 1);
    if (error || !Array.isArray(data)) {
      return res.status(500).json(GENERIC_ERROR_BODY);
    }

    const rows: ReportRow[] = [];
    for (const row of data.slice(0, LIST_LIMIT)) {
      if (!isReportRow(row)) return res.status(500).json(GENERIC_ERROR_BODY);
      rows.push(row);
    }

    const previews = await fetchPostPreviews(
      client,
      Array.from(new Set(rows.map((r) => r.post_id as string))),
    );

    const reports: ModerationReportSummary[] = rows.map((row) => ({
      id: row.id as string,
      version: row.version as number,
      postId: row.post_id as string,
      reason: row.reason as ModerationReportReason,
      status: row.status as ModerationReportStatus,
      createdAt: row.created_at as string,
      postPreview: previews.get(row.post_id as string) ?? null,
    }));

    res.setHeader("Cache-Control", "no-store");
    const last = rows.at(-1);
    return res.status(200).json({
      reports,
      nextCursor:
        data.length > LIST_LIMIT && last
          ? encodeFeedCursor(last.created_at as string, last.id as string)
          : null,
    });
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

export interface ModerationReportDetail extends ModerationReportSummary {
  detail: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  updatedAt: string;
  media: CommunityFeedMediaItem[];
  audit: {
    id: string;
    actor_user_id: string | null;
    action: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }[];
}

const DETAIL_COLUMNS =
  "id, post_id, reason, detail, status, resolved_by, resolution_note, created_at, updated_at, version";

// GET /api/admin/moderation-report?id=<uuid> — detalle de un reporte + preview del contenido.
export async function handleModerationReport(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }
  const actorUserId = await authorizeModerator(req, res);
  if (actorUserId === null) return res;

  const idParam = req.query.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  if (!isUuid(id)) {
    return res.status(400).json(INVALID_BODY);
  }

  try {
    const client = getServiceClient();
    const { data, error } = await client
      .from("community_post_reports")
      .select(DETAIL_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json(GENERIC_ERROR_BODY);
    if (!data) return res.status(404).json(NOT_FOUND_BODY);

    const row = data as Record<string, unknown>;
    if (!isReportRow(row)) return res.status(500).json(GENERIC_ERROR_BODY);
    if (typeof row.updated_at !== "string")
      return res.status(500).json(GENERIC_ERROR_BODY);

    const previews = await fetchPostPreviews(client, [row.post_id as string], true);
    const { data: attachments, error: mediaError } = await client
      .from("community_post_media")
      .select(
        "id, position, media_assets(status, kind, storage_key, width, height, duration_seconds)",
      )
      .eq("post_id", row.post_id)
      .order("position", { ascending: true })
      .limit(10);
    if (mediaError || !Array.isArray(attachments))
      return res.status(500).json(GENERIC_ERROR_BODY);
    const { data: audit, error: auditError } = await client.rpc(
      "community_moderation_audit",
      { p_actor_user_id: actorUserId, p_report_id: id },
    );
    if (auditError) {
      const code = rpcBusinessError(auditError);
      if (code === "actor_not_moderator" || code === "report_not_found")
        return res
          .status(code === "actor_not_moderator" ? 403 : 404)
          .json({ error: "No se pudo cargar el reporte", code });
      return res.status(500).json(GENERIC_ERROR_BODY);
    }
    if (!Array.isArray(audit)) return res.status(500).json(GENERIC_ERROR_BODY);

    // R4-D2: URL por estado real del post (consulta server-side; nunca el estado del cliente).
    const { data: postRow, error: postError } = await client
      .from("community_posts")
      .select("status, purge_after")
      .eq("id", row.post_id)
      .maybeSingle();
    if (postError) return res.status(500).json(GENERIC_ERROR_BODY);
    const rawAttachments = attachments as unknown as RawFeedMediaRow[];
    const purgeAfter =
      postRow && typeof postRow.purge_after === "string"
        ? Date.parse(postRow.purge_after)
        : null;
    const mediaUrls = postRow
      ? await moderatorMediaUrls(await loadMediaUrlContext(), {
          status: String(postRow.status),
          purgeAfterMs:
            purgeAfter !== null && Number.isFinite(purgeAfter) ? purgeAfter : null,
          nowMs: Date.now(),
          storageKeys: rawAttachments.flatMap((m) =>
            m.media_assets?.storage_key ? [m.media_assets.storage_key] : [],
          ),
        })
      : new Map<string, string>();

    const detail: ModerationReportDetail = {
      id: row.id as string,
      version: row.version as number,
      postId: row.post_id as string,
      reason: row.reason as ModerationReportReason,
      status: row.status as ModerationReportStatus,
      createdAt: row.created_at as string,
      postPreview: previews.get(row.post_id as string) ?? null,
      detail: typeof row.detail === "string" ? row.detail : null,
      resolvedBy: typeof row.resolved_by === "string" ? row.resolved_by : null,
      resolutionNote:
        typeof row.resolution_note === "string" ? row.resolution_note : null,
      updatedAt: row.updated_at,
      media: rawAttachments
        .filter(
          (m) => m.media_assets?.storage_key && mediaUrls.has(m.media_assets.storage_key),
        )
        .map((m) => mapFeedMediaRow(m, (key) => mediaUrls.get(key)!))
        .filter((m): m is CommunityFeedMediaItem => m !== null),
      audit,
    };

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ report: detail });
  } catch {
    return res.status(500).json(GENERIC_ERROR_BODY);
  }
}

/** Rechazos de negocio conocidos de community_moderation_action (lista CERRADA). Cualquier
 *  otro error de la RPC es infraestructura: 500 genérico. */
// R4-A: all individual mutations (including legacy restore) are retired.
export async function handleModerationReportStatus(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }
  if ((await authorizeModerator(req, res)) === null) return res;
  return res.status(410).json({
    error: "Esta acción de moderación ya no está disponible",
    code: "individual_moderation_retired",
  });
}

/** Rechazos de negocio conocidos de community_post_report_submit (lista CERRADA). */
const CREATE_KNOWN_ERRORS: Record<string, number> = {
  unauthenticated: 401,
  self_report: 403,
  post_not_reportable: 409,
  case_cycle_inconsistent: 409,
  invalid_reason: 400,
  post_not_found: 404,
  detail_too_long: 400,
};

// POST /api/admin/moderation-report-create — { postId, reason, detail? }. Cualquier usuario
// AUTENTICADO (nunca requireCapability: reportar contenido no es una acción de moderación).
export async function handleModerationReportCreate(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido" });
  }

  let reporterUserId: string;
  try {
    ({ userId: reporterUserId } = await requireAuthenticated(req));
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return res.status(err.status).json(authErrorBody(err));
    }
    return res.status(500).json({ ...GENERIC_ERROR_BODY, code: "internal_failure" });
  }

  const body = parseJsonBody(req);
  if (!body) return res.status(400).json(INVALID_BODY);

  const { postId, reason, detail } = body;
  if (!isUuid(postId)) {
    return res.status(400).json(INVALID_BODY);
  }
  if (!isReason(reason))
    return res.status(400).json({ ...INVALID_BODY, code: "invalid_reason" });
  if (detail !== undefined && detail !== null && typeof detail !== "string") {
    return res.status(400).json({ ...INVALID_BODY, code: "invalid_context" });
  }
  if (typeof detail === "string" && Array.from(detail).length > 1000)
    return res.status(400).json({ ...INVALID_BODY, code: "detail_too_long" });

  try {
    const client = getServiceClient();
    const { data, error } = await client.rpc("community_post_report_submit", {
      p_reporter_user_id: reporterUserId,
      p_post_id: postId,
      p_reason: reason,
      p_detail: typeof detail === "string" ? detail : null,
    });
    if (error) {
      const businessError = rpcBusinessError(error);
      if (businessError && Object.hasOwn(CREATE_KNOWN_ERRORS, businessError)) {
        return res
          .status(CREATE_KNOWN_ERRORS[businessError]!)
          .json({ error: "No se pudo crear el reporte", code: businessError });
      }
      return res.status(500).json({ ...GENERIC_ERROR_BODY, code: "internal_failure" });
    }

    const row = data && typeof data === "object" && !Array.isArray(data) ? data : null;
    if (
      !row ||
      !isUuid(row.reportId) ||
      !isUuid(row.caseId) ||
      !isUuid(row.cycleId) ||
      !isStatus(row.reportStatus) ||
      !Number.isInteger(row.caseVersion) ||
      row.caseVersion < 1 ||
      !Number.isInteger(row.postVersion) ||
      row.postVersion < 1 ||
      !Number.isInteger(row.distinctReporterCount) ||
      row.distinctReporterCount < 1 ||
      typeof row.alreadyReported !== "boolean" ||
      typeof row.visibilityChanged !== "boolean" ||
      !["published", "hidden_pending_review"].includes(row.postStatus)
    ) {
      return res.status(500).json({ ...GENERIC_ERROR_BODY, code: "internal_failure" });
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(row.alreadyReported ? 200 : 201).json({
      reportId: row.reportId,
      reportStatus: row.reportStatus,
      caseId: row.caseId,
      cycleId: row.cycleId,
      caseVersion: row.caseVersion,
      distinctReporterCount: row.distinctReporterCount,
      alreadyReported: row.alreadyReported,
      visibilityChanged: row.visibilityChanged,
      postStatus: row.postStatus,
      postVersion: row.postVersion,
    });
  } catch {
    return res.status(500).json({ ...GENERIC_ERROR_BODY, code: "internal_failure" });
  }
}
