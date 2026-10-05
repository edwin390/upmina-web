import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  communityPostDetailDb,
  fakeCreateClient,
  resetCommunityPostDetailDb,
} from "./community-post-detail-supabase-fake";

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => fakeCreateClient(...args),
}));

const { handleCommunityPostDetail } = await import("./community-post-detail-handlers");

const POST_ID = "11111111-1111-4111-8111-111111111111";

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
  return { user_id: "author-1", username: "edwin1", display_name: null, ...overrides };
}

function postRow(overrides: Record<string, unknown> = {}) {
  return {
    id: POST_ID,
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
  resetCommunityPostDetailDb();
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

describe("handleCommunityPostDetail", () => {
  it("método distinto de GET → 405 con Allow: GET", async () => {
    const { res, state } = mockRes();
    await handleCommunityPostDetail(req("POST", { postId: POST_ID }), res);
    expect(state.status).toBe(405);
    expect(state.headers.Allow).toBe("GET");
  });

  it("postId con formato inválido → 404, sin tocar la base de datos", async () => {
    const { res, state } = mockRes();
    await handleCommunityPostDetail(req("GET", { postId: "no-es-un-uuid" }), res);
    expect(state.status).toBe(404);
  });

  it("publicación publicada: devuelve el post con autor y media", async () => {
    communityPostDetailDb.posts = [postRow()];
    communityPostDetailDb.profiles = [profileRow()];
    const { res, state } = mockRes();
    await handleCommunityPostDetail(req("GET", { postId: POST_ID }), res);
    expect(state.status).toBe(200);
    const body = state.body as { post: { id: string; text: string; author: object } };
    expect(body.post.id).toBe(POST_ID);
    expect(body.post.text).toBe("hola comunidad");
    expect(body.post.author).toEqual({ username: "edwin1", displayName: null });
  });

  it("publicación inexistente → 404", async () => {
    const { res, state } = mockRes();
    await handleCommunityPostDetail(req("GET", { postId: POST_ID }), res);
    expect(state.status).toBe(404);
    expect(state.body).toEqual({ error: "No encontrado" });
  });

  it.each(["hidden", "hidden_pending_review"])(
    "publicación %s (no pública) → 404, idéntico a inexistente",
    async (status) => {
      communityPostDetailDb.posts = [postRow({ status })];
      communityPostDetailDb.profiles = [profileRow()];
      const { res: resHidden, state: stateHidden } = mockRes();
      await handleCommunityPostDetail(req("GET", { postId: POST_ID }), resHidden);

      const { res: resMissing, state: stateMissing } = mockRes();
      await handleCommunityPostDetail(
        req("GET", { postId: "22222222-2222-4222-8222-222222222222" }),
        resMissing,
      );

      expect(stateHidden.status).toBe(stateMissing.status);
      expect(stateHidden.status).toBe(404);
      expect(stateHidden.body).toEqual(stateMissing.body);
    },
  );

  it("solo devuelve media ready, con URL pública canónica", async () => {
    communityPostDetailDb.posts = [
      postRow({
        community_post_media: [
          {
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
          },
          {
            id: "media-2",
            position: 1,
            media_assets: { status: "processing", width: 1, height: 1, storage_key: "k" },
          },
        ],
      }),
    ];
    communityPostDetailDb.profiles = [profileRow()];
    const { res, state } = mockRes();
    await handleCommunityPostDetail(req("GET", { postId: POST_ID }), res);
    const body = state.body as { post: { media: { id: string; url: string }[] } };
    expect(body.post.media).toHaveLength(1);
    expect(body.post.media[0]?.url).toContain("community/asset-1/w1200.webp");
  });

  it("post mixto (9J-3): imagen+vídeo en el orden definido, kind/durationSeconds expuestos", async () => {
    communityPostDetailDb.posts = [
      postRow({
        community_post_media: [
          {
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
          },
          {
            id: "media-video",
            position: 1,
            media_assets: {
              status: "ready",
              kind: "video",
              width: 1280,
              height: 720,
              storage_key: "community/asset-video/original.mp4",
              duration_seconds: 15,
            },
          },
        ],
      }),
    ];
    communityPostDetailDb.profiles = [profileRow()];
    const { res, state } = mockRes();
    await handleCommunityPostDetail(req("GET", { postId: POST_ID }), res);
    const body = state.body as {
      post: { media: { id: string; kind: string; durationSeconds: number | null }[] };
    };
    expect(body.post.media.map((m) => ({ id: m.id, kind: m.kind }))).toEqual([
      { id: "media-1", kind: "image" },
      { id: "media-video", kind: "video" },
    ]);
    expect(body.post.media[1]?.durationSeconds).toBe(15);
  });

  it("no expone email, UUID, author_user_id, role ni metadata de MFA/seguridad", async () => {
    communityPostDetailDb.posts = [postRow()];
    communityPostDetailDb.profiles = [profileRow()];
    const { res, state } = mockRes();
    await handleCommunityPostDetail(req("GET", { postId: POST_ID }), res);
    const raw = JSON.stringify(state.body).toLowerCase();
    expect(raw).not.toContain("author_user_id");
    expect(raw).not.toContain("author-1");
    expect(raw).not.toContain("user_id");
    expect(raw).not.toContain("email");
    expect(raw).not.toContain("role");
    expect(raw).not.toContain("mfa");
    expect(raw).not.toContain("private");
  });

  it("autor sin perfil resoluble (fail-closed) → 404", async () => {
    communityPostDetailDb.posts = [postRow()];
    const { res, state } = mockRes();
    await handleCommunityPostDetail(req("GET", { postId: POST_ID }), res);
    expect(state.status).toBe(404);
  });

  it("Cache-Control público con s-maxage", async () => {
    communityPostDetailDb.posts = [postRow()];
    communityPostDetailDb.profiles = [profileRow()];
    const { res, state } = mockRes();
    await handleCommunityPostDetail(req("GET", { postId: POST_ID }), res);
    expect(state.headers["Cache-Control"]).toBe(
      "public, s-maxage=30, stale-while-revalidate=120",
    );
  });

  it("error de Supabase → 500 genérico, sin detalles", async () => {
    communityPostDetailDb.failNextPosts = { code: "42501", message: "permiso denegado" };
    const { res, state } = mockRes();
    await handleCommunityPostDetail(req("GET", { postId: POST_ID }), res);
    expect(state.status).toBe(500);
    expect(JSON.stringify(state.body)).not.toContain("42501");
  });

  it("excepción del cliente → 500 genérico", async () => {
    communityPostDetailDb.throwNext = new Error("red caída");
    const { res, state } = mockRes();
    await handleCommunityPostDetail(req("GET", { postId: POST_ID }), res);
    expect(state.status).toBe(500);
  });

  it("expone likeCount real (Fase 9J-2C)", async () => {
    communityPostDetailDb.posts = [postRow({ like_count: 12 })];
    communityPostDetailDb.profiles = [profileRow()];
    const { res, state } = mockRes();
    await handleCommunityPostDetail(req("GET", { postId: POST_ID }), res);
    const body = state.body as { post: { likeCount: number } };
    expect(body.post.likeCount).toBe(12);
  });
});
