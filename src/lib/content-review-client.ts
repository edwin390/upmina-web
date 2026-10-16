import { supabase } from "@/lib/supabase";
import { ModerationClientError } from "./moderation-client";

// PHASE-3: cliente de la cola de revisión de contenido (panel de Moderación). Solo refleja lo que el servidor autoriza:
// la decisión real (permisos, versiones, estado) se comprueba en el servidor y en la base de datos.

export type ContentReviewScope = "held" | "edits";
export type ContentReviewKind = "held_post" | "pending_edit";
export type ContentReviewDecision = "approve" | "reject";

export interface ReviewMedia {
  assetId: string;
  position: number;
  isNew: boolean;
  kind: "image" | "video" | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  /** null = sin vista previa disponible (p. ej. el Worker de entrega privada no está configurado). */
  url: string | null;
}
export interface ReviewAuthor {
  username: string | null;
  displayName: string | null;
}
export interface HeldReviewItem {
  kind: "held_post";
  id: string;
  postId: string;
  version: number;
  createdAt: string;
  text: string | null;
  author: ReviewAuthor;
  media: ReviewMedia[];
}
export interface EditReviewItem {
  kind: "pending_edit";
  id: string;
  postId: string;
  version: number;
  baseVersion: number;
  stale: boolean;
  postStatus: string;
  requestedAt: string;
  author: ReviewAuthor;
  published: { text: string | null; media: ReviewMedia[] };
  proposed: { text: string | null; media: ReviewMedia[] };
}
export type ReviewItem = HeldReviewItem | EditReviewItem;
export interface ContentReviewPage {
  items: ReviewItem[];
  nextCursor: string | null;
  counts: { held: number; edits: number };
}

const invalid = () => new ModerationClientError("Respuesta inválida", 502);
const rec = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid();
  return v as Record<string, unknown>;
};
const str = (v: unknown): string => {
  if (typeof v !== "string") throw invalid();
  return v;
};
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : str(v));
const num = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw invalid();
  return v;
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const arr = (v: unknown, max: number): unknown[] => {
  if (!Array.isArray(v) || v.length > max) throw invalid();
  return v;
};

function media(value: unknown): ReviewMedia[] {
  return arr(value, 10).map((v) => {
    const r = rec(v);
    const kind = r.kind === "image" || r.kind === "video" ? r.kind : null;
    if (typeof r.isNew !== "boolean") throw invalid();
    return {
      assetId: str(r.assetId),
      position: num(r.position),
      isNew: r.isNew,
      kind,
      width: numOrNull(r.width),
      height: numOrNull(r.height),
      durationSeconds: numOrNull(r.durationSeconds),
      url: strOrNull(r.url),
    };
  });
}
function author(value: unknown): ReviewAuthor {
  const r = rec(value);
  return { username: strOrNull(r.username), displayName: strOrNull(r.displayName) };
}
function parseItem(value: unknown): ReviewItem {
  const r = rec(value);
  if (r.kind === "held_post")
    return {
      kind: "held_post",
      id: str(r.id),
      postId: str(r.postId),
      version: num(r.version),
      createdAt: str(r.createdAt),
      text: strOrNull(r.text),
      author: author(r.author),
      media: media(r.media),
    };
  if (r.kind === "pending_edit") {
    const published = rec(r.published);
    const proposed = rec(r.proposed);
    return {
      kind: "pending_edit",
      id: str(r.id),
      postId: str(r.postId),
      version: num(r.version),
      baseVersion: num(r.baseVersion),
      stale: r.stale === true,
      postStatus: str(r.postStatus),
      requestedAt: str(r.requestedAt),
      author: author(r.author),
      published: { text: strOrNull(published.text), media: media(published.media) },
      proposed: { text: strOrNull(proposed.text), media: media(proposed.media) },
    };
  }
  throw invalid();
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) throw new ModerationClientError("Sin sesión", 401);
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ModerationClientError("Sin sesión", 401);
  return { Authorization: `Bearer ${token}` };
}

async function failure(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
  throw new ModerationClientError(body.error ?? fallback, response.status, body.code);
}

export async function fetchContentReviewPage(
  scope: ContentReviewScope,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<ContentReviewPage> {
  const headers = await authHeader();
  const params = new URLSearchParams({ scope });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/api/admin/content-review?${params}`, { headers, cache: "no-store", signal });
  if (!response.ok) await failure(response, "No se pudo cargar la cola de revisión");
  const body = rec(await response.json());
  const counts = rec(body.counts);
  return {
    items: arr(body.items, 20).map(parseItem),
    nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : null,
    counts: { held: num(counts.held), edits: num(counts.edits) },
  };
}

export async function decideContentReview(input: {
  kind: ContentReviewKind;
  id: string;
  decision: ContentReviewDecision;
  expectedVersion: number | null;
}): Promise<void> {
  const headers = await authHeader();
  const response = await fetch("/api/admin/content-review-decision", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(
      input.expectedVersion === null
        ? { kind: input.kind, id: input.id, decision: input.decision }
        : input,
    ),
    cache: "no-store",
  });
  if (!response.ok) await failure(response, "No se pudo registrar la decisión");
}
