import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  communityFeedDb,
  fakeCreateClient,
  resetCommunityFeedDb,
} from "./community-feed-supabase-fake";

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => fakeCreateClient(...args),
}));

const { handleCommunityFeed } = await import("./community-feed-handlers");

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

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: "author-1",
    username: "mina",
    display_name: "Mina",
    ...overrides,
  };
}

function readyMediaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "media-1",
    position: 0,
    media_assets: {
      status: "ready",
      width: 1200,
      height: 1600,
      storage_key: "community/asset-1/w1200.webp",
    },
    ...overrides,
  };
}

function postRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    author_user_id: "author-1",
    text: "hola comunidad",
    status: "published",
    created_at: "2026-03-02T10:00:00.000Z",
    community_post_media: [],
    ...overrides,
  };
}

beforeEach(() => {
  resetCommunityFeedDb();
  communityFeedDb.profiles = [profileRow()];
  vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  vi.stubEnv("R2_DEV_ACCESS_KEY_ID", "test-access-key-id");
  vi.stubEnv("R2_DEV_SECRET_ACCESS_KEY", "test-secret-access-key");
  vi.stubEnv("R2_DEV_ENDPOINT", "https://test-account.r2.cloudflarestorage.com");
  vi.stubEnv("R2_DEV_PRIVATE_BUCKET", "upmina-media-dev-private");
  vi.stubEnv("R2_DEV_PUBLIC_BUCKET", "upmina-media-dev-public");
  vi.stubEnv("R2_DEV_PUBLIC_BASE_URL", "https://pub-test.r2.dev");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const { resetR2DevConfigCache } = await import("./r2-client");
  resetR2DevConfigCache();
});

describe("handleCommunityFeed", () => {
  it("método distinto de GET → 405 con Allow: GET", async () => {
    const { res, state } = mockRes();
    await handleCommunityFeed(req("POST"), res);
    expect(state.status).toBe(405);
    expect(state.headers.Allow).toBe("GET");
  });

  it("sin Supabase configurado → 500 genérico", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    const { res, state } = mockRes();
    await handleCommunityFeed(req("GET"), res);
    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
  });

  it("sin publicaciones: 200 con lista vacía, nunca 500", async () => {
    const { res, state } = mockRes();
    await handleCommunityFeed(req("GET"), res);
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ items: [], nextCursor: null });
  });

  it("solo devuelve publicaciones published; hidden nunca aparece", async () => {
    communityFeedDb.posts = [
      postRow({ id: "visible" }),
      postRow({ id: "oculta", status: "hidden" }),
    ];
    const { res, state } = mockRes();
    await handleCommunityFeed(req("GET"), res);
    const body = state.body as { items: { id: string }[] };
    expect(body.items.map((i) => i.id)).toEqual(["visible"]);
  });

  it("publicación de solo texto: media vacía", async () => {
    communityFeedDb.posts = [postRow()];
    const { res, state } = mockRes();
    await handleCommunityFeed(req("GET"), res);
    const body = state.body as { items: { text: string | null; media: unknown[] }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ text: "hola comunidad", media: [] });
  });

  it("publicación con imagen: variante pública segura, sin storage_key crudo", async () => {
    communityFeedDb.posts = [postRow({ community_post_media: [readyMediaRow()] })];
    const { res, state } = mockRes();
    await handleCommunityFeed(req("GET"), res);
    const body = state.body as {
      items: { media: { id: string; url: string; kind: string }[] }[];
    };
    expect(body.items[0]?.media).toHaveLength(1);
    const media = body.items[0]!.media[0]!;
    expect(media.kind).toBe("image");
    expect(media.url).toContain("community/asset-1/w1200.webp");
    expect(JSON.stringify(body)).not.toContain("private");
  });

  it("varias imágenes conservan su position", async () => {
    communityFeedDb.posts = [
      postRow({
        text: null,
        community_post_media: [
          readyMediaRow({ id: "media-2", position: 1 }),
          readyMediaRow({ id: "media-1", position: 0 }),
        ],
      }),
    ];
    const { res, state } = mockRes();
    await handleCommunityFeed(req("GET"), res);
    const body = state.body as { items: { media: { id: string }[] }[] };
    expect(body.items[0]?.media.map((m) => m.id)).toEqual(["media-1", "media-2"]);
  });

  it("excluye media no ready (reservada/procesándose)", async () => {
    communityFeedDb.posts = [
      postRow({
        community_post_media: [
          readyMediaRow({
            media_assets: { status: "processing", width: 1, height: 1, storage_key: "k" },
          }),
        ],
      }),
    ];
    const { res, state } = mockRes();
    await handleCommunityFeed(req("GET"), res);
    const body = state.body as { items: { media: unknown[] }[] };
    expect(body.items[0]?.media).toEqual([]);
  });

  it("orden: más recientes primero", async () => {
    communityFeedDb.posts = [
      postRow({ id: "old", created_at: "2026-01-01T00:00:00.000Z" }),
      postRow({ id: "new", created_at: "2026-02-01T00:00:00.000Z" }),
    ];
    const { res, state } = mockRes();
    await handleCommunityFeed(req("GET"), res);
    const body = state.body as { items: { id: string }[] };
    expect(body.items.map((i) => i.id)).toEqual(["new", "old"]);
  });

  it("paginación: 25 publicadas → primera página de 20 con nextCursor, segunda con las 5 restantes sin cursor, sin solapamiento", async () => {
    communityFeedDb.posts = Array.from({ length: 25 }, (_, i) =>
      postRow({
        id: `p${String(i).padStart(2, "0")}`,
        created_at: new Date(2026, 0, 1 + i).toISOString(),
      }),
    );

    const { res: res1, state: state1 } = mockRes();
    await handleCommunityFeed(req("GET"), res1);
    const page1 = state1.body as { items: { id: string }[]; nextCursor: string | null };
    expect(page1.items).toHaveLength(20);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.items[0]?.id).toBe("p24");

    const { res: res2, state: state2 } = mockRes();
    await handleCommunityFeed(req("GET", { cursor: page1.nextCursor! }), res2);
    const page2 = state2.body as { items: { id: string }[]; nextCursor: string | null };
    expect(page2.items).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();

    const allIds = [...page1.items, ...page2.items].map((i) => i.id);
    expect(new Set(allIds).size).toBe(25);
  });

  it("cursor inválido (no decodificable) → 400", async () => {
    const { res, state } = mockRes();
    await handleCommunityFeed(req("GET", { cursor: "%%%no-es-base64%%%" }), res);
    expect(state.status).toBe(400);
  });

  it("no expone email, role, ni metadata de MFA/seguridad", async () => {
    communityFeedDb.posts = [postRow()];
    const { res, state } = mockRes();
    await handleCommunityFeed(req("GET"), res);
    const raw = JSON.stringify(state.body).toLowerCase();
    expect(raw).not.toContain("email");
    expect(raw).not.toContain("role");
    expect(raw).not.toContain("mfa");
    expect(raw).not.toContain("aal");
  });

  it("no expone author_user_id (UUID) como identidad pública", async () => {
    communityFeedDb.posts = [postRow({ author_user_id: "author-1" })];
    const { res, state } = mockRes();
    await handleCommunityFeed(req("GET"), res);
    expect(JSON.stringify(state.body)).not.toContain("author_user_id");
    const body = state.body as { items: { author: object }[] };
    expect(body.items[0]?.author).toEqual({ username: "mina", displayName: "Mina" });
  });

  it("displayName ausente: se expone username, sin inventar un nombre", async () => {
    communityFeedDb.profiles = [profileRow({ display_name: null })];
    communityFeedDb.posts = [postRow()];
    const { res, state } = mockRes();
    await handleCommunityFeed(req("GET"), res);
    const body = state.body as { items: { author: { displayName: string | null } }[] };
    expect(body.items[0]?.author.displayName).toBeNull();
  });

  it("publicación sin perfil resoluble (fail-closed) nunca aparece en el feed", async () => {
    communityFeedDb.profiles = [];
    communityFeedDb.posts = [postRow()];
    const { res, state } = mockRes();
    await handleCommunityFeed(req("GET"), res);
    const body = state.body as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("Cache-Control público con s-maxage", async () => {
    communityFeedDb.posts = [postRow()];
    const { res, state } = mockRes();
    await handleCommunityFeed(req("GET"), res);
    expect(state.headers["Cache-Control"]).toBe(
      "public, s-maxage=30, stale-while-revalidate=120",
    );
  });

  it("error de Supabase al leer community_posts → 500 genérico, sin detalles", async () => {
    communityFeedDb.failNextPosts = { code: "42501", message: "permiso denegado" };
    const { res, state } = mockRes();
    await handleCommunityFeed(req("GET"), res);
    expect(state.status).toBe(500);
    expect(JSON.stringify(state.body)).not.toContain("42501");
  });

  it("error de Supabase al leer profiles → 500 genérico", async () => {
    communityFeedDb.posts = [postRow()];
    communityFeedDb.failNextProfiles = { code: "42501", message: "permiso denegado" };
    const { res, state } = mockRes();
    await handleCommunityFeed(req("GET"), res);
    expect(state.status).toBe(500);
  });

  it("excepción del cliente → 500 genérico", async () => {
    communityFeedDb.throwNext = new Error("red caída");
    const { res, state } = mockRes();
    await handleCommunityFeed(req("GET"), res);
    expect(state.status).toBe(500);
  });
});
