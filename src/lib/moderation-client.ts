import {
  parseGroupedDecisionInput,
  parseGroupedDecisionResult,
  type GroupedDecisionInput,
  type GroupedDecisionResult,
} from "./moderation-decision-contract";
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

export async function fetchModerationCasePage(
  scope: "active" | "closed",
  cursor: string | null,
  signal?: AbortSignal,
): Promise<ModerationCasePage> {
  const params = new URLSearchParams({ scope });
  if (cursor) params.set("cursor", cursor);
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
