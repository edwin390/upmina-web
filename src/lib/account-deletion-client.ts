import { supabase } from "@/lib/supabase";

// DEL-3: cliente de los endpoints de eliminación de cuenta (DEL-2). Cada llamada envía SOLO el Bearer vigente; el servidor decide todo
// (identidad, cuenta privilegiada, token, caducidad). Ninguna función lanza: devuelve un resultado cerrado. El token viaja únicamente en
// el cuerpo de un POST (nunca en la URL ni en cabeceras propias) y nada de aquí lo registra ni lo guarda.

const BASE = "/api/admin/";

export type DeletionRequestOutcome =
  | { kind: "sent" }
  | { kind: "rate_limited" }
  | { kind: "privileged" }
  | { kind: "already_deleting" }
  | { kind: "unauthenticated" }
  | { kind: "mail_failed" }
  | { kind: "unavailable" }
  | { kind: "error" };

export type DeletionPreviewState = "valid" | "expired" | "invalid" | "already_deleting";
export type DeletionPreviewOutcome =
  | { kind: "ok"; state: DeletionPreviewState }
  | { kind: "unauthenticated" }
  | { kind: "error" };

export type DeletionConfirmOutcome =
  | { kind: "accepted" }
  | { kind: "already_deleting" }
  | { kind: "invalid_token" }
  | { kind: "expired" }
  | { kind: "privileged" }
  | { kind: "unauthenticated" }
  /** El servidor respondió con un error: NO se sabe que la cuenta siga activa ni que se haya eliminado. */
  | { kind: "error" }
  /** Sin respuesta utilizable (red, timeout, cuerpo ilegible en un 2xx): el resultado es DESCONOCIDO. */
  | { kind: "ambiguous" };

async function bearer(): Promise<string | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

async function post(action: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const token = await bearer();
  if (!token) return { kind: "no-session" as const };
  try {
    const response = await fetch(`${BASE}${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    const json = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    return { kind: "response" as const, status: response.status, body: json };
  } catch {
    return { kind: "network" as const };
  }
}

export async function requestAccountDeletion(
  signal?: AbortSignal,
): Promise<DeletionRequestOutcome> {
  const r = await post("account-deletion-request", {}, signal);
  if (r.kind === "no-session") return { kind: "unauthenticated" };
  if (r.kind === "network") return { kind: "error" };
  const code = typeof r.body?.code === "string" ? r.body.code : null;
  if (r.status === 200 && r.body?.ok === true) return { kind: "sent" };
  if (r.status === 401) return { kind: "unauthenticated" };
  if (r.status === 403 && code === "privileged_account") return { kind: "privileged" };
  if (r.status === 409 && code === "already_deleting")
    return { kind: "already_deleting" };
  if (r.status === 429) return { kind: "rate_limited" };
  if (r.status === 502) return { kind: "mail_failed" };
  if (r.status === 503) return { kind: "unavailable" };
  return { kind: "error" };
}

const PREVIEW_STATES: readonly string[] = [
  "valid",
  "expired",
  "invalid",
  "already_deleting",
];

export async function previewAccountDeletion(
  token: string,
  signal?: AbortSignal,
): Promise<DeletionPreviewOutcome> {
  const r = await post("account-deletion-preview", { token }, signal);
  if (r.kind === "no-session") return { kind: "unauthenticated" };
  if (r.kind === "network") return { kind: "error" };
  if (r.status === 401) return { kind: "unauthenticated" };
  const state = r.body?.state;
  if (r.status === 200 && typeof state === "string" && PREVIEW_STATES.includes(state))
    return { kind: "ok", state: state as DeletionPreviewState };
  return { kind: "error" };
}

/** Confirmación IRREVERSIBLE. Solo se llama desde la acción final explícita de la persona (nunca al montar ni al validar). */
export async function confirmAccountDeletion(
  token: string,
): Promise<DeletionConfirmOutcome> {
  const r = await post("account-deletion-confirm", { token, confirm: true });
  if (r.kind === "no-session") return { kind: "unauthenticated" };
  if (r.kind === "network") return { kind: "ambiguous" };
  const code = typeof r.body?.code === "string" ? r.body.code : null;
  if (r.status === 202 && r.body?.status === "accepted") return { kind: "accepted" };
  if (r.status === 200 && r.body?.status === "already_deleting")
    return { kind: "already_deleting" };
  if (r.status === 401) return { kind: "unauthenticated" };
  if (r.status === 410) return { kind: "expired" };
  if (r.status === 403 && code === "privileged_account") return { kind: "privileged" };
  if (r.status === 400) return { kind: "invalid_token" };
  // Un 5xx (el servidor pudo consumir el token y fallar después) o un 2xx que no reconocemos (proxy, cuerpo vacío) no demuestran nada:
  // el resultado es DESCONOCIDO, nunca «no ocurrió».
  if (r.status >= 500 || (r.status >= 200 && r.status < 300))
    return { kind: "ambiguous" };
  return { kind: "error" };
}

// ---- Developer ---------------------------------------------------------------------------------------------------------------------

export interface DeletionAlert {
  requestId: string;
  status:
    | "access_blocked"
    | "cleanup_in_progress"
    | "cleanup_retry_pending"
    | "cleanup_manual_required";
  failedStage: string | null;
  errorCode: string | null;
  lastAttemptAt: string | null;
  lastErrorAt: string | null;
  nextRetryAt: string | null;
  totalAttempts: number;
  consecutiveFailures: number;
  manualRequired: boolean;
  stalled: boolean;
  pendingStages: string[];
}

const STATUSES = [
  "access_blocked",
  "cleanup_in_progress",
  "cleanup_retry_pending",
  "cleanup_manual_required",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const optString = (v: unknown) => (typeof v === "string" ? v : null);

/** Parser estricto: una fila incoherente invalida la lista entera (nunca se muestra a medias). Descarta cualquier otro campo. */
export function parseDeletionAlerts(value: unknown): DeletionAlert[] | null {
  const list = (value as { alerts?: unknown } | null)?.alerts;
  if (!Array.isArray(list)) return null;
  const out: DeletionAlert[] = [];
  for (const raw of list as Array<Record<string, unknown>>) {
    if (
      !raw ||
      typeof raw.requestId !== "string" ||
      !UUID.test(raw.requestId) ||
      typeof raw.status !== "string" ||
      !STATUSES.includes(raw.status) ||
      typeof raw.totalAttempts !== "number" ||
      typeof raw.consecutiveFailures !== "number" ||
      typeof raw.manualRequired !== "boolean" ||
      typeof raw.stalled !== "boolean" ||
      !Array.isArray(raw.pendingStages) ||
      !raw.pendingStages.every((s) => typeof s === "string")
    )
      return null;
    out.push({
      requestId: raw.requestId,
      status: raw.status as DeletionAlert["status"],
      failedStage: optString(raw.failedStage),
      errorCode: optString(raw.errorCode),
      lastAttemptAt: optString(raw.lastAttemptAt),
      lastErrorAt: optString(raw.lastErrorAt),
      nextRetryAt: optString(raw.nextRetryAt),
      totalAttempts: raw.totalAttempts,
      consecutiveFailures: raw.consecutiveFailures,
      manualRequired: raw.manualRequired,
      stalled: raw.stalled,
      pendingStages: raw.pendingStages as string[],
    });
  }
  return out;
}

// ---- Avisos finales (DEL-4b) -------------------------------------------------------------------------------------------------------

/** Aviso final que requiere intervención. El backend NO envía correo ni id de cuenta; el id de solicitud solo sirve para la acción. */
export interface DeletionNoticeAlert {
  requestId: string;
  status: "pending" | "sending" | "abandoned";
  attempts: number;
  errorCode: string | null;
  nextAttemptAt: string | null;
  createdAt: string | null;
  purgeBy: string | null;
  retryable: boolean;
  blockedReason:
    "abandoned" | "lease_active" | "attempts_exhausted" | "window_expired" | null;
}

const NOTICE_STATUSES = ["pending", "sending", "abandoned"];
const NOTICE_REASONS = [
  "abandoned",
  "lease_active",
  "attempts_exhausted",
  "window_expired",
];

/** Parser estricto e independiente del de limpieza: un aviso incoherente descarta solo la lista de avisos. Sin `notices` ⇒ []. */
export function parseDeletionNotices(value: unknown): DeletionNoticeAlert[] {
  const list = (value as { notices?: unknown } | null)?.notices;
  if (!Array.isArray(list)) return [];
  const out: DeletionNoticeAlert[] = [];
  for (const raw of list as Array<Record<string, unknown>>) {
    if (
      !raw ||
      typeof raw.requestId !== "string" ||
      !UUID.test(raw.requestId) ||
      typeof raw.status !== "string" ||
      !NOTICE_STATUSES.includes(raw.status) ||
      typeof raw.attempts !== "number" ||
      typeof raw.retryable !== "boolean" ||
      (raw.blockedReason !== null &&
        raw.blockedReason !== undefined &&
        !NOTICE_REASONS.includes(String(raw.blockedReason)))
    )
      return [];
    out.push({
      requestId: raw.requestId,
      status: raw.status as DeletionNoticeAlert["status"],
      attempts: raw.attempts,
      errorCode: optString(raw.errorCode),
      nextAttemptAt: optString(raw.nextAttemptAt),
      createdAt: optString(raw.createdAt),
      purgeBy: optString(raw.purgeBy),
      retryable: raw.retryable,
      blockedReason: (raw.blockedReason ?? null) as DeletionNoticeAlert["blockedReason"],
    });
  }
  return out;
}

export type AlertKind = "manual" | "retry" | "stalled" | "running";
export function alertKind(a: DeletionAlert): AlertKind {
  if (a.manualRequired || a.status === "cleanup_manual_required") return "manual";
  if (a.stalled) return "stalled";
  if (a.status === "cleanup_retry_pending") return "retry";
  return "running";
}
/** El reintento solo tiene sentido cuando el backend lo admite: fallo en espera de reintento, intervención manual o estancada. */
export function canRetry(a: DeletionAlert): boolean {
  return (
    a.status === "cleanup_retry_pending" ||
    a.status === "cleanup_manual_required" ||
    // Estancada = bloqueada sin empezar > 15 min o limpieza con el lease caducado: el backend la reanuda (no restaura nada).
    (a.stalled && (a.status === "access_blocked" || a.status === "cleanup_in_progress"))
  );
}

export type AlertsOutcome =
  | { kind: "ok"; alerts: DeletionAlert[]; notices: DeletionNoticeAlert[] }
  | { kind: "failure"; response: Response }
  | { kind: "error" };

export async function fetchDeletionAlerts(signal?: AbortSignal): Promise<AlertsOutcome> {
  const token = await bearer();
  if (!token) return { kind: "error" };
  try {
    const response = await fetch(`${BASE}account-deletion-alerts`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal,
    });
    if (!response.ok) return { kind: "failure", response };
    const body: unknown = await response.json().catch(() => null);
    const alerts = parseDeletionAlerts(body);
    return alerts
      ? { kind: "ok", alerts, notices: parseDeletionNotices(body) }
      : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

export type RetryOutcome =
  | { kind: "requested" }
  | { kind: "not_applicable" }
  | { kind: "not_found" }
  | { kind: "forbidden"; response: Response }
  | { kind: "failure"; response: Response }
  | { kind: "error" };

export const retryAccountDeletion = (requestId: string) =>
  postRetry("account-deletion-retry", requestId);
/** DEL-4b: adelanta un aviso final elegible (el ejecutor lo envía; aquí no se envía nada). */
export const retryDeletionNotice = (requestId: string) =>
  postRetry("account-deletion-notice-retry", requestId);

async function postRetry(action: string, requestId: string): Promise<RetryOutcome> {
  const token = await bearer();
  if (!token) return { kind: "error" };
  try {
    const response = await fetch(`${BASE}${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId }),
      cache: "no-store",
    });
    if (response.ok) return { kind: "requested" };
    if (response.status === 409) return { kind: "not_applicable" };
    if (response.status === 404) return { kind: "not_found" };
    if (response.status === 401 || response.status === 403)
      return { kind: "forbidden", response };
    return { kind: "failure", response };
  } catch {
    return { kind: "error" };
  }
}
