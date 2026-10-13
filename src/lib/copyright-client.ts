import { supabase } from "@/lib/supabase";
import type { ClaimPayload } from "./copyright-claim";
import type { AppealPayload } from "./copyright-appeal";
import {
  parseActionResult,
  parseClaimDetail,
  parseClaimSummary,
  parseReviewResult,
  parseStrikeApplyResult,
  parseStrikeState,
  type CopyrightActionResult,
  type CopyrightNoticeErrorClass,
  type CopyrightStrikeApplyResult,
  type CopyrightStrikeLevel,
  type CopyrightStrikeState,
  type CopyrightNoticeKind,
  type CopyrightClaimDetail,
  type CopyrightClaimPage,
  type CopyrightClaimScope,
  type CopyrightReviewAction,
  type CopyrightReviewResult,
} from "./copyright-contract";
import { ModerationClientError } from "./moderation-client";

// COPY-1 fase 2A: cliente del formulario PÚBLICO (sin sesión) y de la pestaña de copyright del panel de moderación.

const PUBLIC_ENDPOINT = "/api/admin/copyright-claim-create";

export type ClaimSubmitOutcome =
  | { kind: "received"; reference: string | null }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "invalid" }
  | { kind: "error" };

/** Envía la reclamación. Nunca lanza: un fallo técnico es `error`, nunca «recibida». Sin cookies ni sesión. */
export async function submitCopyrightClaim(
  payload: ClaimPayload,
  honeypot = "",
  signal?: AbortSignal,
): Promise<ClaimSubmitOutcome> {
  try {
    const response = await fetch(PUBLIC_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, website: honeypot }),
      credentials: "omit",
      cache: "no-store",
      signal,
    });
    const body = (await response.json().catch(() => null)) as {
      status?: unknown;
      reference?: unknown;
      retryAfterSeconds?: unknown;
    } | null;
    if (response.status === 429 && body?.status === "rate_limited") {
      const raw = Number(body.retryAfterSeconds);
      return {
        kind: "rate_limited",
        retryAfterSeconds: Number.isFinite(raw)
          ? Math.min(86_400, Math.max(1, Math.ceil(raw)))
          : 60,
      };
    }
    if (response.status === 400) return { kind: "invalid" };
    if (response.status === 201 && body?.status === "received") {
      const reference =
        typeof body.reference === "string" && /^CPY-\d{4}-\d{6}$/.test(body.reference)
          ? body.reference
          : null;
      return { kind: "received", reference };
    }
    return { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) throw new ModerationClientError("Sin sesión", 401);
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ModerationClientError("Sin sesión", 401);
  return { Authorization: `Bearer ${token}` };
}

async function failure(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };
  throw new ModerationClientError(body.error ?? fallback, response.status, body.code);
}

export async function fetchCopyrightClaimPage(
  scope: CopyrightClaimScope,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<CopyrightClaimPage> {
  const headers = await authHeader();
  const params = new URLSearchParams({ scope });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/api/admin/copyright-claims?${params}`, {
    headers,
    cache: "no-store",
    signal,
  });
  if (!response.ok) await failure(response, "No se pudo cargar la cola de copyright");
  const body = (await response.json()) as { claims?: unknown; nextCursor?: unknown };
  if (!Array.isArray(body.claims) || body.claims.length > 25)
    throw new ModerationClientError("Respuesta inválida", 502);
  try {
    return {
      claims: body.claims.map(parseClaimSummary),
      nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : null,
    };
  } catch {
    throw new ModerationClientError("Respuesta inválida", 502);
  }
}

export async function fetchCopyrightClaim(
  id: string,
  signal?: AbortSignal,
): Promise<CopyrightClaimDetail> {
  const headers = await authHeader();
  const response = await fetch(
    `/api/admin/copyright-claim?${new URLSearchParams({ id })}`,
    {
      headers,
      cache: "no-store",
      signal,
    },
  );
  if (!response.ok) await failure(response, "No se pudo cargar la reclamación");
  try {
    return parseClaimDetail(((await response.json()) as { claim?: unknown }).claim);
  } catch {
    throw new ModerationClientError("Respuesta inválida", 502);
  }
}

export async function reviewCopyrightClaim(input: {
  id: string;
  action: CopyrightReviewAction;
  expectedVersion: number;
  note?: string;
}): Promise<CopyrightReviewResult> {
  const headers = await authHeader();
  const response = await fetch("/api/admin/copyright-claim-review", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  if (!response.ok) await failure(response, "No se pudo registrar la revisión");
  try {
    return parseReviewResult(((await response.json()) as { claim?: unknown }).claim);
  } catch {
    throw new ModerationClientError("Respuesta inválida", 502);
  }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Fase 2B — moderación: retirada, reintento de aviso, resolución de la apelación y eliminación manual. Solo cambian lo que el
// servidor autoriza; la interfaz solo refleja las condiciones (la RPC las repite).
async function postAction(
  path: string,
  body: Record<string, unknown>,
  fallback: string,
): Promise<CopyrightActionResult> {
  const headers = await authHeader();
  const response = await fetch(`/api/admin/${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!response.ok) await failure(response, fallback);
  try {
    return parseActionResult(((await response.json()) as { claim?: unknown }).claim);
  } catch {
    throw new ModerationClientError("Respuesta inválida", 502);
  }
}

export const removeCopyrightClaim = (input: {
  id: string;
  expectedVersion: number;
  expectedPostVersion: number;
  confirmReference: string;
  reason: string;
}) => postAction("copyright-claim-remove", input, "No se pudo retirar la publicación");

export const resendCopyrightNotice = (input: { id: string; kind: CopyrightNoticeKind }) =>
  postAction("copyright-claim-notice", input, "No se pudo reenviar el aviso");

export const resolveCopyrightAppeal = (input: {
  id: string;
  expectedVersion: number;
  decision: "accept" | "reject";
  note: string;
}) =>
  postAction("copyright-claim-appeal-resolve", input, "No se pudo resolver la apelación");

export const purgeCopyrightClaim = (input: {
  id: string;
  expectedVersion: number;
  confirmReference: string;
  note: string;
}) => postAction("copyright-claim-purge", input, "No se pudo eliminar la publicación");

// ------------------------------------------------------------------------------------------------------------------------------
// Strikes manuales de Copyright (solo con la reclamación en `purged`): el servidor y la BD repiten todas las condiciones y calculan el
// nivel; el cliente solo envía la decisión explícita, el motivo y (opcional) el nivel que la persona vio al confirmar.
async function postStrike(
  path: string,
  body: Record<string, unknown>,
  fallback: string,
): Promise<unknown> {
  const headers = await authHeader();
  const response = await fetch(`/api/admin/${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!response.ok) await failure(response, fallback);
  try {
    return await response.json();
  } catch {
    throw new ModerationClientError("Respuesta inválida", 502);
  }
}

export async function fetchCopyrightStrikeState(
  id: string,
): Promise<CopyrightStrikeState> {
  const out = (await postStrike(
    "copyright-strike-state",
    { id },
    "No se pudo cargar el strike",
  )) as {
    state?: unknown;
  };
  try {
    return parseStrikeState(out.state);
  } catch {
    throw new ModerationClientError("Respuesta inválida", 502);
  }
}

export async function applyCopyrightStrike(input: {
  id: string;
  reason: string;
  expectedLevel: CopyrightStrikeLevel | null;
}): Promise<CopyrightStrikeApplyResult> {
  const out = (await postStrike(
    "copyright-strike-apply",
    {
      id: input.id,
      reason: input.reason,
      ...(input.expectedLevel ? { expectedLevel: input.expectedLevel } : {}),
    },
    "No se pudo aplicar el strike",
  )) as { strike?: unknown };
  try {
    return parseStrikeApplyResult(out.strike);
  } catch {
    throw new ModerationClientError("Respuesta inválida", 502);
  }
}

export async function resendCopyrightStrikeNotice(
  id: string,
): Promise<{ notice: "sent" | "failed"; noticeError: CopyrightNoticeErrorClass | null }> {
  const out = (await postStrike(
    "copyright-strike-notice",
    { id },
    "No se pudo reenviar el aviso",
  )) as {
    notice?: unknown;
    noticeError?: CopyrightNoticeErrorClass | null;
  };
  if (out.notice !== "sent" && out.notice !== "failed")
    throw new ModerationClientError("Respuesta inválida", 502);
  return { notice: out.notice, noticeError: out.noticeError ?? null };
}

// ------------------------------------------------------------------------------------------------------------------------------
// Fase 2B — autor: estado y presentación de la apelación (sesión del autor + token del enlace). El token nunca va en la URL de la
// petición: viaja en el cuerpo.
export interface AppealContext {
  reference: string;
  state: "open" | "submitted" | "closed" | "expired";
  reason: string;
  removedAt: string;
  appealDeadline: string | null;
  appealStatus: "pending" | "accepted" | "rejected" | null;
}
export type AppealContextOutcome =
  | { kind: "ok"; appeal: AppealContext }
  | { kind: "unauthenticated" }
  | { kind: "not_available" }
  | { kind: "error" };
export type AppealSubmitOutcome =
  | { kind: "submitted"; reference: string }
  | { kind: "unauthenticated" }
  | { kind: "already_submitted" }
  | { kind: "window_closed" }
  | { kind: "not_available" }
  | { kind: "invalid" }
  | { kind: "error" };

async function authorPost(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response | null> {
  let headers: Record<string, string>;
  try {
    headers = await authHeader();
  } catch {
    return null;
  }
  return fetch(`/api/admin/${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal,
  });
}

export async function fetchAppealContext(
  token: string,
  signal?: AbortSignal,
): Promise<AppealContextOutcome> {
  try {
    const response = await authorPost("copyright-appeal-context", { token }, signal);
    if (!response) return { kind: "unauthenticated" };
    if (response.status === 401) return { kind: "unauthenticated" };
    if (response.status === 404) return { kind: "not_available" };
    if (!response.ok) return { kind: "error" };
    const body = (await response.json()) as { appeal?: Record<string, unknown> };
    const a = body.appeal;
    const states = ["open", "submitted", "closed", "expired"];
    if (
      !a ||
      typeof a.reference !== "string" ||
      !states.includes(a.state as string) ||
      typeof a.reason !== "string" ||
      typeof a.removedAt !== "string"
    )
      return { kind: "error" };
    return {
      kind: "ok",
      appeal: {
        reference: a.reference,
        state: a.state as AppealContext["state"],
        reason: a.reason,
        removedAt: a.removedAt,
        appealDeadline: typeof a.appealDeadline === "string" ? a.appealDeadline : null,
        appealStatus:
          a.appealStatus === "pending" ||
          a.appealStatus === "accepted" ||
          a.appealStatus === "rejected"
            ? a.appealStatus
            : null,
      },
    };
  } catch {
    return { kind: "error" };
  }
}

export async function submitAppeal(
  token: string,
  payload: AppealPayload,
  signal?: AbortSignal,
): Promise<AppealSubmitOutcome> {
  try {
    const response = await authorPost(
      "copyright-appeal-submit",
      { token, appeal: payload },
      signal,
    );
    if (!response || response.status === 401) return { kind: "unauthenticated" };
    const body = (await response.json().catch(() => null)) as {
      code?: unknown;
      appeal?: { reference?: unknown };
    } | null;
    if (response.status === 201 && typeof body?.appeal?.reference === "string")
      return { kind: "submitted", reference: body.appeal.reference };
    if (response.status === 409 && body?.code === "appeal_already_submitted")
      return { kind: "already_submitted" };
    if (response.status === 409 && body?.code === "appeal_window_closed")
      return { kind: "window_closed" };
    if (response.status === 404) return { kind: "not_available" };
    if (response.status === 400) return { kind: "invalid" };
    return { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}
