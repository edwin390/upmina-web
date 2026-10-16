import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sb = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: sb.getSession } } }));

import { decideContentReview, fetchContentReviewPage } from "./content-review-client";
import { ModerationClientError } from "./moderation-client";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const heldRaw = {
  kind: "held_post", id: "p1", postId: "p1", version: 2, createdAt: "2026-10-01T10:00:00Z", text: null,
  author: { username: "a", displayName: null },
  media: [{ assetId: "m1", position: 0, isNew: false, kind: "image", width: 1, height: 1, durationSeconds: null, url: null }],
};
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  sb.getSession.mockResolvedValue({ data: { session: { access_token: "tok" } } });
});
afterEach(() => vi.unstubAllGlobals());

describe("cliente de revisión de contenido", () => {
  it("lista con Bearer, sin caché, con alcance y cursor, y valida la forma de la respuesta", async () => {
    fetchMock.mockResolvedValue(json(200, { items: [heldRaw], nextCursor: "c2", counts: { held: 1, edits: 0 } }));
    const page = await fetchContentReviewPage("held", "c1");
    expect(page).toMatchObject({ nextCursor: "c2", counts: { held: 1, edits: 0 } });
    expect(page.items[0]).toMatchObject({ kind: "held_post", media: [{ assetId: "m1", url: null }] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/content-review?scope=held&cursor=c1");
    expect(init).toMatchObject({ headers: { Authorization: "Bearer tok" }, cache: "no-store" });
  });

  it("sin sesión no hace ninguna petición", async () => {
    sb.getSession.mockResolvedValue({ data: { session: null } });
    await expect(fetchContentReviewPage("edits", null)).rejects.toMatchObject({ status: 401 });
    await expect(decideContentReview({ kind: "held_post", id: "p", decision: "approve", expectedVersion: 1 })).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("una respuesta con forma inesperada se rechaza (502) en vez de pintarse", async () => {
    for (const body of [{ items: "x", counts: {} }, { items: [{ kind: "otro" }], counts: { held: 0, edits: 0 } }, { items: [{ ...heldRaw, version: "2" }], counts: { held: 0, edits: 0 } }]) {
      fetchMock.mockResolvedValue(json(200, body));
      await expect(fetchContentReviewPage("held", null)).rejects.toMatchObject({ status: 502 });
    }
  });

  it("propaga el estado y el código del servidor sin añadir datos", async () => {
    fetchMock.mockResolvedValue(json(403, { error: "Acceso no autorizado", code: "step_up_required" }));
    const err = await fetchContentReviewPage("held", null).catch((e) => e);
    expect(err).toBeInstanceOf(ModerationClientError);
    expect(err).toMatchObject({ status: 403, code: "step_up_required" });
  });

  it("la decisión solo envía tipo, id, decisión y versión: nunca la identidad", async () => {
    fetchMock.mockResolvedValue(json(200, {}));
    await decideContentReview({ kind: "held_post", id: "p1", decision: "approve", expectedVersion: 4 });
    await decideContentReview({ kind: "pending_edit", id: "e1", decision: "reject", expectedVersion: null });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ kind: "held_post", id: "p1", decision: "approve", expectedVersion: 4 });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ kind: "pending_edit", id: "e1", decision: "reject" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/content-review-decision");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", cache: "no-store" });
  });

  it("los errores de decisión conservan el código para la interfaz", async () => {
    fetchMock.mockResolvedValue(json(409, { error: "x", code: "version_conflict" }));
    await expect(decideContentReview({ kind: "pending_edit", id: "e", decision: "approve", expectedVersion: 1 })).rejects.toMatchObject({ status: 409, code: "version_conflict" });
  });
});
