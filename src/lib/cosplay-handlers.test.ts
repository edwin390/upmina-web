import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cosplayDb, fakeCreateClient, resetCosplayDb } from "./cosplay-supabase-fake";

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => fakeCreateClient(...args),
}));

const { handleCosplayList, handleCosplayPost } = await import("./cosplay-handlers");

function mockRes() {
  const state: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return res;
    },
  };
  return { res: res as unknown as VercelResponse, state };
}

function req(method: string, query: Record<string, string> = {}): VercelRequest {
  return { method, query } as unknown as VercelRequest;
}

// Fila cruda tal como la devolvería PostgREST con el `select` embebido de cosplay-handlers.ts.
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    slug: "kirito-sao",
    status: "published",
    title_es: "Kirito",
    title_en: null,
    title_de: null,
    description_es: "Del anime Sword Art Online.",
    description_en: null,
    description_de: null,
    character_name: "Kirito",
    series: "Sword Art Online",
    event: null,
    shot_on: "2026-03-01",
    photographer_credit: null,
    published_at: "2026-03-02T10:00:00.000Z",
    version: 1,
    cosplay_post_images: [readyImageRow()],
    ...overrides,
  };
}

function readyImageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "img-1",
    position: 0,
    is_cover: true,
    decorative: false,
    alt_es: "Kirito con espada",
    alt_en: null,
    alt_de: null,
    caption_es: null,
    caption_en: null,
    caption_de: null,
    media_assets: {
      id: "asset-1",
      status: "ready",
      width: 1600,
      height: 2400,
      storage_key: "cosplay/asset-1/w1600.webp",
    },
    ...overrides,
  };
}

beforeEach(() => {
  resetCosplayDb();
  vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("handleCosplayList", () => {
  it("método distinto de GET → 405 con Allow: GET", async () => {
    const { res, state } = mockRes();
    await handleCosplayList(req("POST"), res);
    expect(state.status).toBe(405);
    expect(state.headers.Allow).toBe("GET");
  });

  it("sin Supabase configurado → 500 genérico", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    const { res, state } = mockRes();
    await handleCosplayList(req("GET"), res);
    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
  });

  it("solo devuelve publicaciones published; los borradores nunca aparecen", async () => {
    cosplayDb.rows = [
      row({ id: "p1", slug: "publicada", published_at: "2026-03-02T10:00:00.000Z" }),
      row({ id: "p2", slug: "borrador", status: "draft", published_at: null }),
    ];
    const { res, state } = mockRes();
    await handleCosplayList(req("GET"), res);
    expect(state.status).toBe(200);
    const body = state.body as { items: { slug: string }[] };
    expect(body.items.map((i) => i.slug)).toEqual(["publicada"]);
  });

  it("excluye imágenes no ready: cover null y photoCount 0 si ninguna está lista", async () => {
    cosplayDb.rows = [
      row({
        cosplay_post_images: [
          readyImageRow({
            media_assets: {
              id: "a",
              status: "reserved",
              width: 1,
              height: 1,
              storage_key: "k",
            },
          }),
        ],
      }),
    ];
    const { res, state } = mockRes();
    await handleCosplayList(req("GET"), res);
    const body = state.body as { items: { cover: unknown; photoCount: number }[] };
    expect(body.items[0]).toMatchObject({ cover: null, photoCount: 0 });
  });

  it("Cache-Control público con s-maxage", async () => {
    cosplayDb.rows = [row()];
    const { res, state } = mockRes();
    await handleCosplayList(req("GET"), res);
    expect(state.headers["Cache-Control"]).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
  });

  it("paginación: 30 publicadas → primera página de 24 con nextCursor, segunda con las 6 restantes y sin cursor", async () => {
    cosplayDb.rows = Array.from({ length: 30 }, (_, i) =>
      row({
        id: `p${String(i).padStart(2, "0")}`,
        slug: `post-${i}`,
        published_at: new Date(2026, 0, 1 + i).toISOString(),
      }),
    );

    const { res: res1, state: state1 } = mockRes();
    await handleCosplayList(req("GET"), res1);
    expect(state1.status).toBe(200);
    const page1 = state1.body as { items: { slug: string }[]; nextCursor: string | null };
    expect(page1.items).toHaveLength(24);
    expect(page1.nextCursor).not.toBeNull();
    // Más reciente primero: post-29 (1+29 días) es el último y más reciente.
    expect(page1.items[0]?.slug).toBe("post-29");

    const { res: res2, state: state2 } = mockRes();
    await handleCosplayList(req("GET", { cursor: page1.nextCursor! }), res2);
    const page2 = state2.body as { items: { slug: string }[]; nextCursor: string | null };
    expect(page2.items).toHaveLength(6);
    expect(page2.nextCursor).toBeNull();

    // Sin solapamiento entre páginas.
    const allSlugs = [...page1.items, ...page2.items].map((i) => i.slug);
    expect(new Set(allSlugs).size).toBe(30);
  });

  it("cursor inválido (no decodificable) → 400", async () => {
    const { res, state } = mockRes();
    await handleCosplayList(req("GET", { cursor: "%%%no-es-base64%%%" }), res);
    expect(state.status).toBe(400);
  });

  it("error de Supabase → 500 genérico, sin detalles", async () => {
    cosplayDb.failNext = {
      code: "42501",
      message: "permiso denegado a la tabla secreta",
    };
    const { res, state } = mockRes();
    await handleCosplayList(req("GET"), res);
    expect(state.status).toBe(500);
    expect(JSON.stringify(state.body)).not.toContain("42501");
  });

  it("excepción del cliente → 500 genérico", async () => {
    cosplayDb.throwNext = new Error("red caída");
    const { res, state } = mockRes();
    await handleCosplayList(req("GET"), res);
    expect(state.status).toBe(500);
  });
});

describe("handleCosplayPost", () => {
  it("método distinto de GET → 405 con Allow: GET", async () => {
    const { res, state } = mockRes();
    await handleCosplayPost(req("POST", { slug: "kirito-sao" }), res);
    expect(state.status).toBe(405);
    expect(state.headers.Allow).toBe("GET");
  });

  it.each(["", "ab", "Kirito-SAO", "kirito sao"])(
    "slug con formato inválido (%s) → 404 sin tocar la base de datos",
    async (slug) => {
      const { res, state } = mockRes();
      await handleCosplayPost(req("GET", { slug }), res);
      expect(state.status).toBe(404);
      expect(cosplayDb.queries).toHaveLength(0);
    },
  );

  it("publicación encontrada y publicada → 200 con el detalle completo", async () => {
    cosplayDb.rows = [row()];
    const { res, state } = mockRes();
    await handleCosplayPost(req("GET", { slug: "kirito-sao" }), res);
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({
      slug: "kirito-sao",
      titleEs: "Kirito",
      descriptionEs: "Del anime Sword Art Online.",
      gallery: [expect.objectContaining({ id: "img-1" })],
    });
    expect(state.headers["Cache-Control"]).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
  });

  it("la galería excluye imágenes no ready y queda ordenada por position", async () => {
    cosplayDb.rows = [
      row({
        cosplay_post_images: [
          readyImageRow({ id: "img-2", position: 1 }),
          readyImageRow({
            id: "img-pending",
            position: 2,
            media_assets: {
              id: "b",
              status: "reserved",
              width: 1,
              height: 1,
              storage_key: "k",
            },
          }),
          readyImageRow({ id: "img-1", position: 0 }),
        ],
      }),
    ];
    const { res, state } = mockRes();
    await handleCosplayPost(req("GET", { slug: "kirito-sao" }), res);
    const body = state.body as { gallery: { id: string }[] };
    expect(body.gallery.map((i) => i.id)).toEqual(["img-1", "img-2"]);
  });

  it("un slug de BORRADOR responde 404 IDÉNTICO a un slug inexistente (nunca se filtra que existe)", async () => {
    cosplayDb.rows = [
      row({ slug: "es-un-borrador", status: "draft", published_at: null }),
    ];

    const { res: resDraft, state: stateDraft } = mockRes();
    await handleCosplayPost(req("GET", { slug: "es-un-borrador" }), resDraft);

    const { res: resMissing, state: stateMissing } = mockRes();
    await handleCosplayPost(req("GET", { slug: "no-existe-nunca" }), resMissing);

    expect(stateDraft.status).toBe(stateMissing.status);
    expect(stateDraft.status).toBe(404);
    expect(stateDraft.body).toEqual(stateMissing.body);
  });

  it("error de Supabase → 500 genérico, sin detalles", async () => {
    cosplayDb.failNext = { code: "42501", message: "detalle interno" };
    const { res, state } = mockRes();
    await handleCosplayPost(req("GET", { slug: "kirito-sao" }), res);
    expect(state.status).toBe(500);
    expect(JSON.stringify(state.body)).not.toContain("detalle interno");
  });
});
