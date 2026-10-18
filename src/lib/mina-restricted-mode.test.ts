// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- dobles de VercelRequest/VercelResponse */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Modo operativo restringido: Instagram, TikTok y Cosplays (las tres funciones que esperan la autorización de Mina) quedan
// desactivadas en el SERVIDOR salvo MINA_FEATURES_ENABLED. No se borra nada: aquí solo se prueba el control de acceso.
const h = vi.hoisted(() => ({
  fn: () => vi.fn(async (_req: unknown, res: any) => res.status(200).json({ ok: true })),
}));
const handlers = vi.hoisted(() => ({
  igFeed: vi.fn(),
  igProfile: vi.fn(),
  igMedia: vi.fn(),
  igComments: vi.fn(),
  ttCallback: vi.fn(),
  ttVideos: vi.fn(),
  cosplayList: vi.fn(),
  cosplayPost: vi.fn(),
  cpSave: vi.fn(),
  cpDelete: vi.fn(),
  cpDetach: vi.fn(),
  cpReorder: vi.fn(),
  cpListAdmin: vi.fn(),
  cpGetAdmin: vi.fn(),
  communityFeed: vi.fn(),
}));
const ok = (_req: unknown, res: any) => res.status(200).json({ ok: true });
for (const f of Object.values(handlers)) f.mockImplementation(ok);

vi.mock("./instagram-handlers.js", () => ({
  handleInstagramFeed: handlers.igFeed,
  handleInstagramProfile: handlers.igProfile,
  handleInstagramMedia: handlers.igMedia,
  handleInstagramComments: handlers.igComments,
}));
vi.mock("./tiktok-handlers.js", () => ({
  handleTikTokCallback: handlers.ttCallback,
  handleTikTokVideos: handlers.ttVideos,
}));
vi.mock("./cosplay-handlers.js", () => ({
  handleCosplayList: handlers.cosplayList,
  handleCosplayPost: handlers.cosplayPost,
}));
vi.mock("./community-feed-handlers.js", () => ({
  handleCommunityFeed: handlers.communityFeed,
}));
vi.mock("./cosplay-editor-handlers.js", () => ({
  handleCosplayPostSave: handlers.cpSave,
  handleCosplayPostDelete: handlers.cpDelete,
  handleCosplayMediaDetach: handlers.cpDetach,
  handleCosplayPostReorder: handlers.cpReorder,
  handleCosplayPostListAdmin: handlers.cpListAdmin,
  handleCosplayPostGetAdmin: handlers.cpGetAdmin,
}));
void h;

import {
  FEATURE_UNAVAILABLE_BODY,
  minaFeatureEnabled,
  requireMinaFeature,
} from "./mina-feature-guard";
import { MINA_FEATURES, parseMinaFeatures } from "./mina-features";

function call(
  handler: (req: any, res: any) => unknown,
  query: Record<string, string> = {},
  extra: Record<string, unknown> = {},
) {
  const out = {
    status: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
  };
  const res = {
    setHeader: (k: string, v: string) => ((out.headers[k] = v), res),
    status: (n: number) => ((out.status = n), res),
    json: (b: unknown) => ((out.body = b), res),
  } as unknown as VercelResponse;
  return Promise.resolve(
    handler({ method: "GET", query, headers: {}, ...extra } as VercelRequest, res),
  ).then(() => out);
}
const calledAny = () => Object.values(handlers).some((f) => f.mock.calls.length > 0);

beforeEach(() => {
  for (const f of Object.values(handlers)) f.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("lista de funciones", () => {
  it("son exactamente tres y están desactivadas por defecto", () => {
    expect([...MINA_FEATURES]).toEqual(["instagram", "tiktok", "cosplay"]);
    for (const raw of [
      undefined,
      null,
      "",
      "  ",
      ",,",
      "twitch,youtube,community",
      "INSTAGRAM2",
    ])
      expect(parseMinaFeatures(raw).size).toBe(0);
  });
  it("acepta una lista separada por comas, sin distinguir mayúsculas ni espacios, e ignora lo desconocido", () => {
    expect([...parseMinaFeatures(" Instagram , cosplay,otra,tiktok ")].sort()).toEqual([
      "cosplay",
      "instagram",
      "tiktok",
    ]);
    expect([...parseMinaFeatures("tiktok")]).toEqual(["tiktok"]);
  });
  it("el servidor lee la variable en cada llamada y falla cerrado sin ella", () => {
    vi.stubEnv("MINA_FEATURES_ENABLED", "");
    expect(minaFeatureEnabled("instagram")).toBe(false);
    vi.stubEnv("MINA_FEATURES_ENABLED", "instagram");
    expect(minaFeatureEnabled("instagram")).toBe(true);
    expect(minaFeatureEnabled("tiktok")).toBe(false);
    const res: any = { setHeader: vi.fn(), status: vi.fn(() => res), json: vi.fn() };
    expect(requireMinaFeature("cosplay", res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(FEATURE_UNAVAILABLE_BODY);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  });
});

describe("endpoints con las funciones desactivadas", () => {
  beforeEach(() => vi.stubEnv("MINA_FEATURES_ENABLED", ""));

  it.each(["feed", "profile", "media", "comments"])(
    "Instagram /%s → 503 sin llegar al handler",
    async (resource) => {
      const { default: dispatcher } = await import("../../api/instagram/[resource]");
      const r = await call(dispatcher, { resource });
      expect(r.status).toBe(503);
      expect(r.body).toEqual(FEATURE_UNAVAILABLE_BODY);
      expect(calledAny()).toBe(false);
    },
  );
  it.each(["videos", "callback"])(
    "TikTok /%s → 503 sin llegar al handler",
    async (resource) => {
      const { default: dispatcher } = await import("../../api/tiktok/[resource]");
      expect((await call(dispatcher, { resource })).status).toBe(503);
      expect(calledAny()).toBe(false);
    },
  );
  it("Cosplays públicos (lista y detalle) → 503; el feed de Community NO se ve afectado", async () => {
    const { default: dispatcher } = await import("../../api/content/[resource]");
    expect((await call(dispatcher, { resource: "cosplay-list" })).status).toBe(503);
    expect((await call(dispatcher, { resource: "cosplay-post", slug: "x" })).status).toBe(
      503,
    );
    expect(handlers.cosplayList).not.toHaveBeenCalled();
    expect(handlers.cosplayPost).not.toHaveBeenCalled();
    expect((await call(dispatcher, { resource: "community-feed" })).status).toBe(200);
    expect(handlers.communityFeed).toHaveBeenCalledTimes(1);
  });
  it("callback OAuth de Instagram → 503 antes de tocar ningún estado", async () => {
    const { default: callback } = await import("../../api/instagram-callback");
    const r = await call(callback, { code: "x", state: "y" });
    expect(r.status).toBe(503);
    expect(r.body).toEqual(FEATURE_UNAVAILABLE_BODY);
  });
  it("editor admin de Cosplay: guardar, reordenar y desadjuntar se bloquean; borrar y leer siguen disponibles", async () => {
    const { default: dispatcher } = await import("../../api/admin/[action]");
    for (const action of [
      "cosplay-post-save",
      "cosplay-post-reorder",
      "cosplay-media-detach",
    ]) {
      expect((await call(dispatcher, { action }, { method: "POST" })).status).toBe(503);
    }
    expect(handlers.cpSave).not.toHaveBeenCalled();
    expect(handlers.cpReorder).not.toHaveBeenCalled();
    expect(handlers.cpDetach).not.toHaveBeenCalled();
    for (const action of [
      "cosplay-post-delete",
      "cosplay-post-list-admin",
      "cosplay-post-get-admin",
    ])
      expect((await call(dispatcher, { action }, { method: "POST" })).status).toBe(200);
    expect(handlers.cpDelete).toHaveBeenCalledTimes(1);
  });
  it("manipular el cliente no sirve: ni cabeceras ni parámetros activan nada", async () => {
    const { default: dispatcher } = await import("../../api/instagram/[resource]");
    const r = await call(
      dispatcher,
      { resource: "feed", MINA_FEATURES_ENABLED: "instagram", features: "instagram" },
      { headers: { "x-mina-features": "instagram" } },
    );
    expect(r.status).toBe(503);
  });
});

describe("endpoints con las funciones activadas (reversibilidad)", () => {
  it("con la variable activa todo vuelve a pasar por los handlers originales", async () => {
    vi.stubEnv("MINA_FEATURES_ENABLED", "instagram,tiktok,cosplay");
    const ig = (await import("../../api/instagram/[resource]")).default;
    const tt = (await import("../../api/tiktok/[resource]")).default;
    const content = (await import("../../api/content/[resource]")).default;
    const admin = (await import("../../api/admin/[action]")).default;
    expect((await call(ig, { resource: "feed" })).status).toBe(200);
    expect((await call(tt, { resource: "videos" })).status).toBe(200);
    expect((await call(content, { resource: "cosplay-list" })).status).toBe(200);
    expect(
      (await call(admin, { action: "cosplay-post-save" }, { method: "POST" })).status,
    ).toBe(200);
    expect(handlers.igFeed).toHaveBeenCalledTimes(1);
    expect(handlers.ttVideos).toHaveBeenCalledTimes(1);
    expect(handlers.cosplayList).toHaveBeenCalledTimes(1);
    expect(handlers.cpSave).toHaveBeenCalledTimes(1);
  });
  it("activar una sola función no activa las demás", async () => {
    vi.stubEnv("MINA_FEATURES_ENABLED", "tiktok");
    const ig = (await import("../../api/instagram/[resource]")).default;
    const tt = (await import("../../api/tiktok/[resource]")).default;
    expect((await call(ig, { resource: "feed" })).status).toBe(503);
    expect((await call(tt, { resource: "videos" })).status).toBe(200);
  });
});
