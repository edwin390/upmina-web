import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import router from "../../api/content/[resource]";
import * as handlers from "./cosplay-handlers";
import * as communityHandlers from "./community-feed-handlers";
import * as communityProfileHandlers from "./community-profile-handlers";
import * as communityPostDetailHandlers from "./community-post-detail-handlers";

// Fija el despachador de lecturas públicas de contenido propio (api/content/[resource].ts): solo
// comprueba que el `resource` correcto llega al handler correcto y que uno desconocido no llama a
// ninguno. La lógica de cada handler ya está cubierta por cosplay-handlers.test.ts,
// community-feed-handlers.test.ts (Fase 9J-2A añadió "community-feed") y
// community-profile-handlers.test.ts (Fase 9J-2B añadió "community-profile").

vi.mock("./cosplay-handlers", () => ({
  handleCosplayList: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("list"),
  ),
  handleCosplayPost: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("post"),
  ),
}));

vi.mock("./community-feed-handlers", () => ({
  handleCommunityFeed: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("community-feed"),
  ),
}));

vi.mock("./community-profile-handlers", () => ({
  handleCommunityProfile: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("community-profile"),
  ),
}));

vi.mock("./community-post-detail-handlers", () => ({
  handleCommunityPostDetail: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("community-post-detail"),
  ),
}));

function mockRes() {
  const state: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
    setHeader() {
      return res;
    },
  };
  return { res: res as unknown as VercelResponse, state };
}

function req(resource?: string, extra: Record<string, string> = {}) {
  return { query: { resource, ...extra } } as unknown as VercelRequest;
}

describe("api/content/[resource]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cosplay-list → handleCosplayList", async () => {
    const { res, state } = mockRes();
    await router(req("cosplay-list"), res);
    expect(handlers.handleCosplayList).toHaveBeenCalledTimes(1);
    expect(handlers.handleCosplayPost).not.toHaveBeenCalled();
    expect(state.body).toBe("list");
  });

  it("cosplay-post → handleCosplayPost", async () => {
    const { res, state } = mockRes();
    await router(req("cosplay-post", { slug: "kirito-sao" }), res);
    expect(handlers.handleCosplayPost).toHaveBeenCalledTimes(1);
    expect(handlers.handleCosplayList).not.toHaveBeenCalled();
    expect(state.body).toBe("post");
  });

  it("community-feed → handleCommunityFeed", async () => {
    const { res, state } = mockRes();
    await router(req("community-feed"), res);
    expect(communityHandlers.handleCommunityFeed).toHaveBeenCalledTimes(1);
    expect(handlers.handleCosplayList).not.toHaveBeenCalled();
    expect(handlers.handleCosplayPost).not.toHaveBeenCalled();
    expect(state.body).toBe("community-feed");
  });

  it("community-profile → handleCommunityProfile", async () => {
    const { res, state } = mockRes();
    await router(req("community-profile", { username: "edwin1" }), res);
    expect(communityProfileHandlers.handleCommunityProfile).toHaveBeenCalledTimes(1);
    expect(handlers.handleCosplayList).not.toHaveBeenCalled();
    expect(communityHandlers.handleCommunityFeed).not.toHaveBeenCalled();
    expect(state.body).toBe("community-profile");
  });

  it("community-post-detail → handleCommunityPostDetail", async () => {
    const { res, state } = mockRes();
    await router(req("community-post-detail", { postId: "abc" }), res);
    expect(communityPostDetailHandlers.handleCommunityPostDetail).toHaveBeenCalledTimes(
      1,
    );
    expect(handlers.handleCosplayList).not.toHaveBeenCalled();
    expect(communityProfileHandlers.handleCommunityProfile).not.toHaveBeenCalled();
    expect(state.body).toBe("community-post-detail");
  });

  it("resource desconocido → 404, sin llamar a ningún handler", async () => {
    const { res, state } = mockRes();
    await router(req("algo-inventado"), res);
    expect(state.status).toBe(404);
    expect(handlers.handleCosplayList).not.toHaveBeenCalled();
    expect(handlers.handleCosplayPost).not.toHaveBeenCalled();
    expect(communityHandlers.handleCommunityFeed).not.toHaveBeenCalled();
    expect(communityProfileHandlers.handleCommunityProfile).not.toHaveBeenCalled();
    expect(communityPostDetailHandlers.handleCommunityPostDetail).not.toHaveBeenCalled();
  });

  it("sin resource → 404", async () => {
    const { res, state } = mockRes();
    await router(req(undefined), res);
    expect(state.status).toBe(404);
  });
});
