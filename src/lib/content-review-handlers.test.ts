// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON de respuesta sin tipo estático */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAuthError } from "./admin-auth";
import { encodeFeedCursor } from "./community-feed-domain";
import { handleContentReviewDecision, handleContentReviewList } from "./content-review-handlers";

const fake = vi.hoisted(() => ({
  capability: vi.fn(),
  rpc: vi.fn(),
  assets: [] as Record<string, unknown>[],
  loadContext: vi.fn(),
  moderatorUrls: vi.fn(),
}));
vi.mock("./admin-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./admin-auth")>()),
  requireCapability: fake.capability,
}));
vi.mock("./media-delivery-url.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media-delivery-url")>()),
  loadMediaUrlContext: fake.loadContext,
  moderatorMediaUrls: fake.moderatorUrls,
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: fake.rpc,
    from: () => ({ select: () => ({ in: async () => ({ data: fake.assets, error: null }) }) }),
  }),
}));

const MOD = "99999999-9999-4999-8999-999999999991";
const POST = "11111111-1111-4111-8111-111111111111";
const EDIT = "22222222-2222-4222-8222-222222222222";
const A1 = "33333333-3333-4333-8333-333333333331";
const A2 = "33333333-3333-4333-8333-333333333332";
const A3 = "33333333-3333-4333-8333-333333333333";
const key = (id: string) => `community/${id}/w960.webp`;
const asset = (id: string, extra: Record<string, unknown> = {}) => ({
  id, domain: "community", status: "ready", kind: "image", storage_key: key(id), width: 480, height: 320, duration_seconds: null, ...extra,
});

function call(handler: typeof handleContentReviewList, req: Partial<VercelRequest>) {
  const headers: Record<string, string> = {};
  const out = { status: 0, body: undefined as unknown, headers };
  const res = {
    setHeader: (k: string, v: string) => ((headers[k] = v), res),
    status: (n: number) => ((out.status = n), res),
    json: (b: unknown) => ((out.body = b), res),
  } as unknown as VercelResponse;
  return handler({ method: "GET", query: {}, headers: {}, ...req } as VercelRequest, res).then(() => out);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("VITE_SUPABASE_URL", "https://dev.example.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-only-placeholder");
  fake.assets = [];
  fake.capability.mockResolvedValue({ userId: MOD });
  fake.loadContext.mockResolvedValue({ base: "https://media.example", signing: {} });
  fake.moderatorUrls.mockImplementation(async (_c: unknown, input: { status: string; storageKeys: string[] }) =>
    new Map(input.storageKeys.map((k) => [k, `https://media.example/${k}${input.status === "published" ? "" : "?cap=SECRET"}`])),
  );
});

afterEach(() => vi.unstubAllEnvs());

describe("acceso", () => {
  it("acepta el parámetro action de la ruta dinámica de Vercel", async () => {
    fake.rpc.mockResolvedValue({ data: { items: [], next: null, counts: { held: 0, edits: 0 } }, error: null });
    const r = await call(handleContentReviewList, { query: { action: "content-review", scope: "held" } });
    expect(r.status).toBe(200);
    expect(r.headers["Cache-Control"]).toBe("private, no-store");
  });
  it("sin sesión → 401 y no se toca la base de datos", async () => {
    fake.capability.mockRejectedValue(new AdminAuthError("No autenticado", 401));
    const r = await call(handleContentReviewList, { query: { scope: "held" } });
    expect(r.status).toBe(401);
    expect(fake.rpc).not.toHaveBeenCalled();
    expect((await call(handleContentReviewDecision, { method: "POST", body: {} })).status).toBe(401);
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("usuario sin capacidad de moderación → 403 en lectura y decisión, sin tocar la base de datos", async () => {
    fake.capability.mockRejectedValue(new AdminAuthError("Acceso denegado", 403));
    expect((await call(handleContentReviewList, { query: { scope: "edits" } })).status).toBe(403);
    expect(
      (await call(handleContentReviewDecision, { method: "POST", body: { kind: "held_post", id: POST, decision: "approve", expectedVersion: 1 } })).status,
    ).toBe(403);
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("la base de datos también comprueba al moderador (defensa en profundidad)", async () => {
    fake.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "actor_not_moderator" } });
    expect((await call(handleContentReviewList, { query: { scope: "held" } })).status).toBe(403);
  });

  it("métodos no permitidos", async () => {
    const a = await call(handleContentReviewList, { method: "POST" });
    const b = await call(handleContentReviewDecision, { method: "GET" });
    expect([a.status, b.status]).toEqual([405, 405]);
  });
});

describe("lectura", () => {
  it("valida scope, id, cursor y parámetros desconocidos", async () => {
    for (const query of ([
      {}, { scope: "otro" }, { scope: "held", id: "no-uuid" }, { scope: "held", cursor: "###" },
      { scope: "held", extra: "1" }, { scope: "held", id: POST, cursor: encodeFeedCursor("2026-10-01T10:00:00Z", POST) },
    ] as Record<string, string>[]))
      expect((await call(handleContentReviewList, { query })).status).toBe(400);
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("retenidas: sus archivos solo reciben capability de moderador (nunca URL pública), sin cachés públicas ni logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.assets = [asset(A1)];
    fake.rpc.mockResolvedValue({
      error: null,
      data: {
        items: [{ kind: "held_post", id: POST, postId: POST, version: 1, createdAt: "2026-10-01T10:00:00+00:00", text: "hola",
          author: { username: "autora", displayName: "Autora" }, media: [{ id: EDIT, assetId: A1, position: 0, isNew: false }] }],
        next: { createdAt: "2026-10-01T10:00:00+00:00", id: POST },
        counts: { held: 3, edits: 1 },
      },
    });
    const r = await call(handleContentReviewList, { query: { scope: "held" } });
    expect(r.status).toBe(200);
    expect(r.headers["Cache-Control"]).toBe("private, no-store");
    expect(fake.rpc).toHaveBeenCalledWith("community_content_review_read", expect.objectContaining({
      p_actor_user_id: MOD, p_scope: "held", p_limit: 20, p_before_created: null, p_item_id: null,
    }));
    expect(fake.moderatorUrls).toHaveBeenCalledTimes(1);
    expect(fake.moderatorUrls.mock.calls[0][1]).toMatchObject({ status: "held_for_review", storageKeys: [key(A1)] });
    const body = r.body as any;
    expect(body.counts).toEqual({ held: 3, edits: 1 });
    expect(body.items[0]).toMatchObject({ kind: "held_post", text: "hola", author: { username: "autora" } });
    expect(body.items[0].media[0]).toMatchObject({ assetId: A1, kind: "image", url: expect.stringContaining("cap=SECRET") });
    expect(typeof body.nextCursor).toBe("string");
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
  });

  it("sin URL disponible (modo legado) el archivo se devuelve sin url, nunca con una URL pública", async () => {
    fake.assets = [asset(A1)];
    fake.moderatorUrls.mockResolvedValue(new Map());
    fake.rpc.mockResolvedValue({
      error: null,
      data: { items: [{ kind: "held_post", id: POST, postId: POST, version: 1, createdAt: "2026-10-01T10:00:00+00:00", text: null,
        author: { username: null, displayName: null }, media: [{ id: EDIT, assetId: A1, position: 0, isNew: false }] }], next: null, counts: { held: 1, edits: 0 } },
    });
    const body = (await call(handleContentReviewList, { query: { scope: "held" } })).body as any;
    expect(body.items[0].media[0].url).toBeNull();
    expect(body.nextCursor).toBeNull();
  });

  it("ediciones: lo publicado y lo conservado usan su URL ya pública; solo lo nuevo lleva capability", async () => {
    fake.assets = [asset(A1), asset(A2), asset(A3, { kind: "video", duration_seconds: 12 })];
    fake.rpc.mockResolvedValue({
      error: null,
      data: {
        items: [{ kind: "pending_edit", id: EDIT, editId: EDIT, postId: POST, version: 2, baseVersion: 2, stale: false, postStatus: "published",
          requestedAt: "2026-10-02T10:00:00+00:00", author: { username: "autora", displayName: null },
          published: { text: "antes", media: [{ assetId: A1, position: 0, isNew: false }, { assetId: A2, position: 1, isNew: false }] },
          proposed: { text: "después", media: [{ assetId: A1, position: 0, isNew: false }, { assetId: A3, position: 1, isNew: true }] } }],
        next: null, counts: { held: 0, edits: 1 },
      },
    });
    const body = (await call(handleContentReviewList, { query: { scope: "edits" } })).body as any;
    const byStatus = Object.fromEntries(fake.moderatorUrls.mock.calls.map((c) => [c[1].status, c[1].storageKeys.sort()]));
    expect(byStatus).toEqual({ published: [key(A1), key(A2)].sort(), held_for_review: [key(A3)] });
    const it0 = body.items[0];
    expect(it0.published.media.every((m: any) => !String(m.url).includes("cap="))).toBe(true);
    expect(it0.proposed.media.find((m: any) => m.isNew).url).toContain("cap=");
    expect(it0.proposed.media.find((m: any) => m.isNew)).toMatchObject({ kind: "video", durationSeconds: 12 });
    expect(it0).toMatchObject({ stale: false, version: 2, baseVersion: 2, postStatus: "published" });
  });

  it("pasa cursor e id al RPC y falla de forma genérica ante una respuesta inválida", async () => {
    const cursor = encodeFeedCursor("2026-10-01T10:00:00+00:00", POST);
    fake.rpc.mockResolvedValue({ error: null, data: { items: [], next: null, counts: { held: 0, edits: 0 } } });
    expect((await call(handleContentReviewList, { query: { scope: "edits", cursor } })).status).toBe(200);
    expect(fake.rpc.mock.calls[0][1]).toMatchObject({ p_before_created: "2026-10-01T10:00:00+00:00", p_before_id: POST });
    await call(handleContentReviewList, { query: { scope: "edits", id: EDIT } });
    expect(fake.rpc.mock.calls[1][1]).toMatchObject({ p_item_id: EDIT });
    fake.rpc.mockResolvedValue({ error: null, data: { items: "mal", counts: {} } });
    const bad = await call(handleContentReviewList, { query: { scope: "held" } });
    expect(bad.status).toBe(500);
    expect(JSON.stringify(bad.body)).not.toContain("mal");
  });
});

describe("decisiones", () => {
  const ok = { kind: "held_post", id: POST, decision: "approve", expectedVersion: 1 };
  it("valida el cuerpo: tipo, decisión, id, versión y que no se acepte identidad enviada por el cliente", async () => {
    for (const body of [
      {}, { ...ok, kind: "otro" }, { ...ok, decision: "borrar" }, { ...ok, id: "x" }, { ...ok, expectedVersion: 0 },
      { ...ok, expectedVersion: 1.5 }, { ...ok, expectedVersion: undefined },
      { kind: "pending_edit", id: EDIT, decision: "approve" }, { ...ok, actorUserId: MOD }, { ...ok, userId: MOD },
    ])
      expect((await call(handleContentReviewDecision, { method: "POST", body })).status).toBe(400);
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("aprueba y rechaza usando la identidad del JWT; rechazar una edición no exige versión", async () => {
    fake.rpc.mockImplementation(async (_n: string, a: Record<string, unknown>) => ({
      error: null, data: { decision: a.p_decision, kind: a.p_kind, postId: POST, result: { secreto: "no-se-devuelve" } },
    }));
    const a = await call(handleContentReviewDecision, { method: "POST", body: JSON.stringify(ok) });
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ decision: "approve", kind: "held_post", postId: POST });
    const b = await call(handleContentReviewDecision, { method: "POST", body: { kind: "pending_edit", id: EDIT, decision: "reject" } });
    expect(b.status).toBe(200);
    expect(fake.rpc).toHaveBeenNthCalledWith(1, "community_content_review_decide", {
      p_actor_user_id: MOD, p_kind: "held_post", p_target_id: POST, p_expected_version: 1, p_decision: "approve",
    });
    expect(fake.rpc.mock.calls[1][1]).toMatchObject({ p_actor_user_id: MOD, p_expected_version: null });
  });

  it.each([
    ["version_conflict", 409], ["edit_not_pending", 409], ["post_not_held", 409], ["asset_not_ready", 409],
    ["post_copyright_protected", 409], ["post_not_editable", 409], ["pending_edit_not_found", 404], ["actor_not_moderator", 403],
  ])("traduce %s a HTTP %i con un mensaje genérico", async (message, status) => {
    fake.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message } });
    const r = await call(handleContentReviewDecision, { method: "POST", body: ok });
    expect(r.status).toBe(status);
    expect(r.body).toEqual({ error: "No se pudo completar la revisión", code: message });
  });

  it("un error desconocido de la base de datos nunca se filtra al cliente", async () => {
    fake.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "relation secret_table does not exist" } });
    const r = await call(handleContentReviewDecision, { method: "POST", body: ok });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("secret_table");
  });
});
