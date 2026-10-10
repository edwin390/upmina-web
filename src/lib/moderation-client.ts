import {
  parseGroupedDecisionInput,
  parseGroupedDecisionResult,
  type GroupedDecisionInput,
  type GroupedDecisionResult,
} from "./moderation-decision-contract";
import {
  parseStrikeApplyInput,
  parseStrikeRevokeInput,
  parseStrikeApplyResponse,
  parseStrikeRevokeResponse,
  type StrikeApplyResponse,
  type StrikeRevokeResponse,
} from "./moderation-strike-contract";
import { supabase } from "@/lib/supabase";
import type { CommunityFeedMediaItem } from "@/types";
import type { QueryClient } from "@tanstack/react-query";
import { refreshCommunityContent } from "./content-freshness";
import { notifyCommunityVisibility } from "./community-visibility-sync";
import type { ModerationCaseItem, ModerationCasePage } from "./moderation-case-contract";
import {
  parseModerationCasePage,
  parseModerationCaseDetail,
} from "./moderation-case-parser";
export type { ModerationCaseItem, ModerationCasePage } from "./moderation-case-contract";

async function readCases(
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`/api/admin/moderation-cases?${params}`, {
    headers: await authHeader(),
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    const error = await parseErrorBody(response);
    throw new ModerationClientError(
      error.error ?? "No se pudo cargar el caso",
      response.status,
      error.code,
    );
  }
  return response.json();
}

/** R5-G: filtros de la cola. Solo los valores no vacíos viajan; el servidor los valida y filtra. */
export interface ModerationQueueFilters {
  reason?: string;
  hiddenOnly?: boolean;
  author?: string;
  from?: string;
  to?: string;
}

/** R5-H: total de casos únicos pendientes (agregado en servidor; no depende de la página). */
export async function fetchModerationPendingCount(signal?: AbortSignal): Promise<number> {
  try {
    const body = (await readCases(
      new URLSearchParams({ summary: "pending" }),
      signal,
    )) as {
      pending?: unknown;
    } | null;
    const n = body?.pending;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new Error("bad");
    return n;
  } catch (error) {
    if (
      error instanceof ModerationClientError ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw error;
    throw new ModerationClientError("No se pudo cargar el caso", 500, "invalid_response");
  }
}

export const hasQueueFilters = (f: ModerationQueueFilters) =>
  Boolean(f.reason || f.hiddenOnly || f.author || f.from || f.to);

export function fetchModerationCasePage(
  scope: "active" | "closed",
  cursor: string | null,
  signal?: AbortSignal,
  filters: ModerationQueueFilters = {},
): Promise<ModerationCasePage> {
  const params = new URLSearchParams({ scope });
  if (cursor) params.set("cursor", cursor);
  if (filters.reason) params.set("reason", filters.reason);
  if (filters.hiddenOnly) params.set("hiddenOnly", "1");
  if (filters.author?.trim())
    params.set("author", filters.author.trim().replace(/^@/, ""));
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return readCasePage(params, signal);
}

async function readCasePage(
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<ModerationCasePage> {
  try {
    return parseModerationCasePage(await readCases(params, signal));
  } catch (error) {
    if (
      error instanceof ModerationClientError ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw error;
    throw new ModerationClientError("No se pudo cargar el caso", 500, "invalid_response");
  }
}

export async function fetchModerationCase(
  cycleId: string,
  signal?: AbortSignal,
): Promise<ModerationCaseItem> {
  try {
    return parseModerationCaseDetail(
      await readCases(new URLSearchParams({ cycleId }), signal),
    );
  } catch (error) {
    if (
      error instanceof ModerationClientError ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw error;
    throw new ModerationClientError("No se pudo cargar el caso", 500, "invalid_response");
  }
}

// Cliente del workflow de moderación (9K-2): GET /api/admin/moderation-reports (cola), GET
// /api/admin/moderation-report?id= (detalle) y POST /api/admin/moderation-report-status (cambiar
// estado). Mismo patrón que cosplay-admin-client.ts: el access token VIGENTE de Supabase se lee
// en cada llamada, nunca se persiste; el servidor es la única autoridad (este cliente no decide
// nada, solo tipa lo que llega por cable).

export type ModerationReportReason =
  "spam" | "harassment" | "hate_speech" | "sexual_content" | "other";
export type ModerationReportStatus =
  "open" | "reviewing" | "resolved" | "dismissed" | "actioned";

export interface CommunityReportSubmission {
  reportId: string;
  reportStatus: ModerationReportStatus;
  caseId: string;
  cycleId: string;
  caseVersion: number;
  distinctReporterCount: number;
  alreadyReported: boolean;
  visibilityChanged: boolean;
  postStatus: "published" | "hidden_pending_review";
  postVersion: number;
}

/** Report creation is not a privileged moderation action and does not require MFA. */
export async function submitCommunityReport(
  client: QueryClient,
  postId: string,
  reason: ModerationReportReason,
  detail?: string,
): Promise<CommunityReportSubmission> {
  const response = await fetch("/api/admin/moderation-report-create", {
    method: "POST",
    headers: { ...(await authHeader()), "Content-Type": "application/json" },
    body: JSON.stringify({ postId, reason, detail }),
    cache: "no-store",
  });
  if (!response.ok) {
    const error = await parseErrorBody(response);
    throw new ModerationClientError(
      error.error ?? "No se pudo crear el reporte",
      response.status,
      error.code,
    );
  }
  const result: CommunityReportSubmission = await response.json();
  if (result.visibilityChanged) {
    notifyCommunityVisibility(client, postId);
    // A failed refresh cannot turn an already committed report into a failed submission.
    await refreshCommunityContent(client, undefined, postId).catch(() => undefined);
  }
  return result;
}

export interface ModerationPostPreview {
  text: string | null;
  status: string;
  authorUsername: string | null;
  version: number;
  updatedAt: string;
}

export interface ModerationReportSummary {
  id: string;
  version: number;
  postId: string;
  reason: ModerationReportReason;
  status: ModerationReportStatus;
  createdAt: string;
  postPreview: ModerationPostPreview | null;
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

export class ModerationClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ModerationClientError";
  }
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) throw new ModerationClientError("Sin sesión", 401);
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ModerationClientError("Sin sesión", 401);
  return { Authorization: `Bearer ${token}` };
}

async function parseErrorBody(
  response: Response,
): Promise<{ error?: string; code?: string }> {
  return response.json().catch(() => ({}) as { error?: string; code?: string });
}

export async function fetchModerationReports(
  signal?: AbortSignal,
): Promise<ModerationReportSummary[]> {
  return (await fetchModerationReportPage("active", null, signal)).reports;
}

export async function fetchModerationReportPage(
  scope: "active" | "closed",
  cursor: string | null,
  signal?: AbortSignal,
): Promise<{ reports: ModerationReportSummary[]; nextCursor: string | null }> {
  const headers = await authHeader();
  const params = new URLSearchParams({ scope });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/api/admin/moderation-reports?${params}`, {
    headers,
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    const body = await parseErrorBody(response);
    throw new ModerationClientError(
      body.error ?? "No se pudo cargar la cola de moderación",
      response.status,
      body.code,
    );
  }
  const body = (await response.json()) as {
    reports: ModerationReportSummary[];
    nextCursor?: string | null;
  };
  return { reports: body.reports, nextCursor: body.nextCursor ?? null };
}

export async function fetchModerationReport(
  id: string,
  signal?: AbortSignal,
): Promise<ModerationReportDetail> {
  const headers = await authHeader();
  const response = await fetch(
    `/api/admin/moderation-report?id=${encodeURIComponent(id)}`,
    { headers, cache: "no-store", signal },
  );
  if (!response.ok) {
    const body = await parseErrorBody(response);
    throw new ModerationClientError(
      body.error ?? "No se pudo cargar el reporte",
      response.status,
      body.code,
    );
  }
  const body = (await response.json()) as { report: ModerationReportDetail };
  return body.report;
}

export async function updateModerationReportStatus(input: {
  reportId: string;
  status: ModerationReportStatus;
  note?: string | null;
  expectedReportVersion: number;
  expectedPostVersion: number | null;
  action?: "hide" | "restore" | "reviewing" | "resolve" | "dismiss";
}): Promise<{
  id: string;
  status: ModerationReportStatus;
  version: number;
  updatedAt: string;
}> {
  const headers = await authHeader();
  const response = await fetch("/api/admin/moderation-report-status", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await parseErrorBody(response);
    throw new ModerationClientError(
      body.error ?? "No se pudo actualizar el reporte",
      response.status,
      body.code,
    );
  }
  return response.json();
}

/** No automatic retry. Freshness follows the confirmed authoritative response only. */
export async function decideModerationCase(
  client: QueryClient,
  input: GroupedDecisionInput,
): Promise<GroupedDecisionResult> {
  const normalized = parseGroupedDecisionInput(input);
  const response = await fetch("/api/admin/moderation-case-decision", {
    method: "POST",
    headers: { ...(await authHeader()), "Content-Type": "application/json" },
    body: JSON.stringify(normalized),
    cache: "no-store",
  });
  if (!response.ok) {
    const error = await parseErrorBody(response);
    throw new ModerationClientError(
      error.error ?? "No se pudo completar la moderación",
      response.status,
      error.code,
    );
  }
  let result: GroupedDecisionResult;
  try {
    const raw: unknown = await response.json();
    result = parseGroupedDecisionResult(raw, normalized);
  } catch {
    throw new ModerationClientError(
      "No se pudo confirmar la respuesta",
      500,
      "invalid_response",
    );
  }
  if (result.visibilityChanged) {
    notifyCommunityVisibility(client, result.postId);
    await refreshCommunityContent(client, undefined, result.postId).catch(
      () => undefined,
    );
  }
  return result;
}

// R5-E: strikes. Misma frontera privilegiada que la decisión (backend: requireCapability + MFA
// reciente). Sin reintentos automáticos: el llamador decide y la UI refresca el estado desde el
// servidor tras el resultado (nunca sintetiza el estado final con la respuesta de la mutación).
export async function applyModerationStrike(input: {
  decisionId: string;
  reason: string;
  expectedLevel: number | null;
}): Promise<StrikeApplyResponse> {
  const parsed = parseStrikeApplyInput(input);
  if (!parsed.ok) throw new ModerationClientError("Solicitud inválida", 400, parsed.code);
  const response = await fetch("/api/admin/moderation-strike-apply", {
    method: "POST",
    headers: { ...(await authHeader()), "Content-Type": "application/json" },
    body: JSON.stringify(parsed.value),
    cache: "no-store",
  });
  if (!response.ok) {
    const error = await parseErrorBody(response);
    throw new ModerationClientError(
      error.error ?? "No se pudo aplicar el strike",
      response.status,
      error.code,
    );
  }
  try {
    return parseStrikeApplyResponse(await response.json());
  } catch {
    throw new ModerationClientError(
      "No se pudo confirmar la respuesta",
      500,
      "invalid_response",
    );
  }
}

export async function revokeModerationStrike(input: {
  strikeId: string;
  reason: string;
}): Promise<StrikeRevokeResponse> {
  const parsed = parseStrikeRevokeInput(input);
  if (!parsed.ok) throw new ModerationClientError("Solicitud inválida", 400, parsed.code);
  const response = await fetch("/api/admin/moderation-strike-revoke", {
    method: "POST",
    headers: { ...(await authHeader()), "Content-Type": "application/json" },
    body: JSON.stringify(parsed.value),
    cache: "no-store",
  });
  if (!response.ok) {
    const error = await parseErrorBody(response);
    throw new ModerationClientError(
      error.error ?? "No se pudo revocar el strike",
      response.status,
      error.code,
    );
  }
  try {
    return parseStrikeRevokeResponse(await response.json());
  } catch {
    throw new ModerationClientError(
      "No se pudo confirmar la respuesta",
      500,
      "invalid_response",
    );
  }
}
