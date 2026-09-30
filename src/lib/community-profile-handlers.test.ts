import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  communityProfileDb,
  fakeCreateClient,
  resetCommunityProfileDb,
} from "./community-profile-supabase-fake";

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => fakeCreateClient(...args),
}));

const { handleCommunityProfile } = await import("./community-profile-handlers");

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
    username: "edwin1",
    display_name: null,
    bio: null,
    ...overrides,
  };
}

function readyMediaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "media-1",
    position: 0,
    media_assets: {
      status: "ready",
      kind: "image",
      width: 1200,
      height: 1600,
      storage_key: "community/asset-1/w1200.webp",
      duration_seconds: null,
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
    like_count: 0,
    community_post_media: [],
    ...overrides,
  };
}

beforeEach(() => {
  resetCommunityProfileDb();
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

describe("handleCommunityProfile", () => {
  it("método distinto de GET → 405 con Allow: GET", async () => {
    const { res, state } = mockRes();
    await handleCommunityProfile(req("POST", { username: "edwin1" }), res);
    expect(state.status).toBe(405);
    expect(state.headers.Allow).toBe("GET");
  });

  it("sin username → 400", async () => {
    const { res, state } = mockRes();
    await handleCommunityProfile(req("GET"), res);
    expect(state.status).toBe(400);
  });

  it("username con formato inválido → 400, sin tocar la base de datos", async () => {
    const { res, state } = mockRes();
    await handleCommunityProfile(req("GET", { username: "a" }), res);
    expect(state.status).toBe(400);
  });

  it("perfil inexistente → 404 estable", async () => {
    const { res, state } = mockRes();
    await handleCommunityProfile(req("GET", { username: "nadie" }), res);
    expect(state.status).toBe(404);
    expect(state.body).toEqual({ error: "Perfil no encontrado" });
  });

  it("búsqueda case-insensitive: username en mayúsculas resuelve el mismo perfil canónico en minúsculas", async () => {
    communityProfileDb.profiles = [profileRow()];
    const { res, state } = mockRes();
    await handleCommunityProfile(req("GET", { username: "EDWIN1" }), res);
    expect(state.status).toBe(200);
    const body = state.body as { profile: { username: string } };
    expect(body.profile.username).toBe("edwin1");
  });

  it("perfil válido: username, displayName, bio y postCount", async () => {
    communityProfileDb.profiles = [
      profileRow({ display_name: "Edwin", bio: "Fan de Mina" }),
    ];
    communityProfileDb.posts = [postRow(), postRow({ id: "post-2" })];
    const { res, state } = mockRes();
    await handleCommunityProfile(req("GET", { username: "edwin1" }), res);
    expect(state.status).toBe(200);
    const body = state.body as { profile: unknown };
    expect(body.profile).toEqual({
      username: "edwin1",
      displayName: "Edwin",
      bio: "Fan de Mina",
      postCount: 2,
      totalLikes: 0,
    });
  });

  it("totalLikes: suma real de likeCount de sus publicaciones published (Fase 9J-2C)", async () => {
    communityProfileDb.profiles = [profileRow()];
    communityProfileDb.posts = [
      postRow({ id: "p1", like_count: 5 }),
      postRow({ id: "p2", like_count: 7 }),
    ];
    const { res, state } = mockRes();
    await handleCommunityProfile(req("GET", { username: "edwin1" }), res);
    const body = state.body as { profile: { totalLikes: number } };
    expect(body.profile.totalLikes).toBe(12);
  });

  it("totalLikes excluye publicaciones hidden y de otro autor", async () => {
    communityProfileDb.profiles = [
      profileRow(),
      profileRow({ user_id: "other", username: "otro" }),
    ];
    communityProfileDb.posts = [
      postRow({ id: "mine", like_count: 3 }),
      postRow({ id: "mine-hidden", status: "hidden", like_count: 100 }),
      postRow({ id: "not-mine", author_user_id: "other", like_count: 100 }),
    ];
    const { res, state } = mockRes();
    await handleCommunityProfile(req("GET", { username: "edwin1" }), res);
    const body = state.body as { profile: { totalLikes: number } };
    expect(body.profile.totalLikes).toBe(3);
  });

  it("cero likes es un valor válido, nunca fabricado", async () => {
    communityProfileDb.profiles = [profileRow()];
    communityProfileDb.posts = [postRow()];
    const { res, state } = mockRes();
    await handleCommunityProfile(req("GET", { username: "edwin1" }), res);
    const body = state.body as { profile: { totalLikes: number } };
    expect(body.profile.totalLikes).toBe(0);
  });

  it("cada item de la galería expone likeCount real", async () => {
    communityProfileDb.profiles = [profileRow()];
    communityProfileDb.posts = [postRow({ like_count: 4 })];
    const { res, state } = mockRes();
    await handleCommunityProfile(req("GET", { username: "edwin1" }), res);
    const body = state.body as { posts: { items: { likeCount: number }[] } };
    expect(body.posts.items[0]?.likeCount).toBe(4);
  });

  it("no expone email, UUID, author_user_id, role ni metadata de MFA/seguridad", async () => {
    communityProfileDb.profiles = [profileRow()];
    communityProfileDb.posts = [postRow({ community_post_media: [readyMediaRow()] })];
    const { res, state } = mockRes();
    await handleCommunityProfile(req("GET", { username: "edwin1" }), res);
    const raw = JSON.stringify(state.body).toLowerCase();
    expect(raw).not.toContain("author_user_id");
    expect(raw).not.toContain("author-1");
    expect(raw).not.toContain("user_id");
    expect(raw).not.toContain("email");
    expect(raw).not.toContain("role");
    expect(raw).not.toContain("mfa");
    expect(raw).not.toContain("aal");
    expect(raw).not.toContain("private");
  });

  it("solo publicaciones published de ESE autor; hidden y de otro autor se excluyen", async () => {
    communityProfileDb.profiles = [
      profileRow(),
      profileRow({ user_id: "other", username: "otro" }),
    ];
    communityProfileDb.posts = [
      postRow({ id: "mine-visible" }),
      postRow({ id: "mine-hidden", status: "hidden" }),
      postRow({ id: "not-mine", author_user_id: "other" }),
    ];
    const { res, state } = mockRes();
    await handleCommunityProfile(req("GET", { username: "edwin1" }), res);
    const body = state.body as { posts: { items: { id: string }[] } };
    expect(body.posts.items.map((i) => i.id)).toEqual(["mine-visible"]);
  });

  it("solo media ready se renderiza, con URL pública canónica", async () => {
    communityProfileDb.profiles = [profileRow()];
    communityProfileDb.posts = [
      postRow({
        community_post_media: [
          readyMediaRow(),
          readyMediaRow({
            id: "media-2",
            media_assets: { status: "processing", width: 1, height: 1, storage_key: "k" },
          }),
        ],
      }),
    ];
    const { res, state } = mockRes();
    await handleCommunityProfile(req("GET", { username: "edwin1" }), res);
    const body = state.body as {
      posts: { items: { media: { id: string; url: string }[] }[] };
    };
    expect(body.posts.items[0]?.media).toHaveLength(1);
    expect(body.posts.items[0]?.media[0]?.url).toContain("community/asset-1/w1200.webp");
  });

  it("post con vídeo (9J-3): kind='video' expuesto en la galería del perfil público", async () => {
    communityProfileDb.profiles = [profileRow()];
    communityProfileDb.posts = [
      postRow({
        community_post_media: [
          readyMediaRow({
            id: "media-video",
            media_assets: {
              status: "ready",
              kind: "video",
              width: 1280,
              height: 720,
              storage_key: "community/asset-video/original.mp4",
              duration_seconds: 6,
            },
          }),
        ],
      }),
    ];
    const { res, state } = mockRes();
    await handleCommunityProfile(req("GET", { username: "edwin1" }), res);
    const body = state.body as {
      posts: { items: { media: { kind: string; durationSeconds: number | null }[] }[] };
    };
    expect(body.posts.items[0]?.media[0]).toMatchObject({
      kind: "video",
      durationSeconds: 6,
    });
  });

  it("paginación determinista: 25 publicadas → primera página de 20 con nextCursor, segunda con las 5 restantes", async () => {
    communityProfileDb.profiles = [profileRow()];
    communityProfileDb.posts = Array.from({ length: 25 }, (_, i) =>
      postRow({
        id: `p${String(i).padStart(2, "0")}`,
        created_at: new Date(2026, 0, 1 + i).toISOString(),
      }),
    );

    const { res: res1, state: state1 } = mockRes();
    await handleCommunityProfile(req("GET", { username: "edwin1" }), res1);
    const page1 = state1.body as {
      posts: { items: { id: string }[]; nextCursor: string | null };
    };
    expect(page1.posts.items).toHaveLength(20);
    expect(page1.posts.nextCursor).not.toBeNull();

    const { res: res2, state: state2 } = mockRes();
    await handleCommunityProfile(
      req("GET", { username: "edwin1", cursor: page1.posts.nextCursor! }),
      res2,
    );
    const page2 = state2.body as {
      posts: { items: { id: string }[]; nextCursor: string | null };
    };
    expect(page2.posts.items).toHaveLength(5);
    expect(page2.posts.nextCursor).toBeNull();

    const allIds = [...page1.posts.items, ...page2.posts.items].map((i) => i.id);
    expect(new Set(allIds).size).toBe(25);
  });

  it("cursor inválido → 400", async () => {
    communityProfileDb.profiles = [profileRow()];
    const { res, state } = mockRes();
    await handleCommunityProfile(
      req("GET", { username: "edwin1", cursor: "%%%no-es-base64%%%" }),
      res,
    );
    expect(state.status).toBe(400);
  });

  it("Cache-Control público con s-maxage", async () => {
    communityProfileDb.profiles = [profileRow()];
    const { res, state } = mockRes();
    await handleCommunityProfile(req("GET", { username: "edwin1" }), res);
    expect(state.headers["Cache-Control"]).toBe(
      "public, s-maxage=30, stale-while-revalidate=120",
    );
  });

  it("error de Supabase al leer profiles → 500 genérico, sin detalles", async () => {
    communityProfileDb.failNextProfiles = { code: "42501", message: "permiso denegado" };
    const { res, state } = mockRes();
    await handleCommunityProfile(req("GET", { username: "edwin1" }), res);
    expect(state.status).toBe(500);
    expect(JSON.stringify(state.body)).not.toContain("42501");
  });

  it("error de Supabase al contar publicaciones → 500 genérico", async () => {
    communityProfileDb.profiles = [profileRow()];
    communityProfileDb.failNextCount = { code: "42501", message: "permiso denegado" };
    const { res, state } = mockRes();
    await handleCommunityProfile(req("GET", { username: "edwin1" }), res);
    expect(state.status).toBe(500);
  });

  it("error de Supabase al leer publicaciones → 500 genérico", async () => {
    communityProfileDb.profiles = [profileRow()];
    communityProfileDb.failNextPosts = { code: "42501", message: "permiso denegado" };
    const { res, state } = mockRes();
    await handleCommunityProfile(req("GET", { username: "edwin1" }), res);
    expect(state.status).toBe(500);
  });

  it("excepción del cliente → 500 genérico", async () => {
    communityProfileDb.throwNext = new Error("red caída");
    const { res, state } = mockRes();
    await handleCommunityProfile(req("GET", { username: "edwin1" }), res);
    expect(state.status).toBe(500);
  });
});
