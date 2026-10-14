import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Carrera desconexión ↔ petición pública en vuelo: si la conexión desaparece mientras se obtiene el contenido,
// NO se entrega ni se marca como cacheable. Sintético: ninguna credencial real.
const state = vi.hoisted(() => ({ connected: true }));

vi.mock("./instagram-connection.js", async (orig) => ({
  ...(await orig<typeof import("./instagram-connection")>()),
  getInstagramAccess: async () => ({ accessToken: "tok-sintetico", source: "ig:1:2" }),
  isInstagramSourceCurrent: async () => state.connected,
}));
vi.mock("./tiktok-connection.js", async (orig) => ({
  ...(await orig<typeof import("./tiktok-connection")>()),
  getUsableTikTokAccessToken: async (
    _a: unknown,
    o?: { onConnection?: (s: string) => void },
  ) => {
    o?.onConnection?.("tt:1:2");
    return "tok-sintetico";
  },
  tiktokSnapshotOptions: () => ({
    eligible: () => false,
    confirm: async () => state.connected,
  }),
}));

import { handleInstagramFeed } from "./instagram-handlers";
import { handleTikTokVideos } from "./tiktok-handlers";

function mockRes() {
  const out: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const res = {
    setHeader: (n: string, v: string) => ((out.headers[n] = v), res),
    status: (c: number) => ((out.status = c), res),
    json: (b: unknown) => ((out.body = b), res),
    send: (b: unknown) => ((out.body = b), res),
  };
  return { res: res as unknown as VercelResponse, out };
}
const get = { method: "GET", headers: {}, query: {} } as unknown as VercelRequest;

const IG_ITEMS = {
  data: [
    {
      id: "1",
      media_type: "IMAGE",
      media_url: "https://cdn.example/a.jpg",
      permalink: "https://www.instagram.com/p/A/",
      timestamp: "2026-09-18T19:00:31+0000",
      username: "cuenta_sintetica",
    },
  ],
};
const TT_VIDEOS = {
  data: {
    videos: [
      {
        id: "7",
        share_url: "https://www.tiktok.com/@x/video/7",
        cover_image_url: "https://p.example/c.jpg",
        create_time: 1760000000,
      },
    ],
  },
  error: { code: "ok" },
};

beforeEach(() => {
  state.connected = true;
  vi.stubEnv("VERCEL_ENV", "production");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const stubFetch = (body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );

describe.each([
  [
    "instagram-feed",
    handleInstagramFeed,
    IG_ITEMS,
    "cuenta_sintetica",
    "social-instagram",
  ],
  ["tiktok-videos", handleTikTokVideos, TT_VIDEOS, "tiktok.com/@x", "social-tiktok"],
] as const)("%s", (_n, handler, upstream, marker, tag) => {
  it("conexión activa: contenido con caché corta etiquetada y sin stale", async () => {
    stubFetch(upstream);
    const { res, out } = mockRes();
    await handler(get, res);
    expect(out.status).toBe(200);
    expect(JSON.stringify(out.body)).toContain(marker);
    expect(out.headers["Cache-Control"]).toBe("public, s-maxage=60");
    expect(out.headers["Vercel-Cache-Tag"]).toBe(tag);
  });

  it("desconectada durante la petición (revalidación concurrente): no entrega contenido ni lo hace cacheable", async () => {
    stubFetch(upstream);
    state.connected = false;
    const { res, out } = mockRes();
    await handler(get, res);
    expect(out.status).toBe(503);
    expect(JSON.stringify(out.body)).not.toContain(marker);
    expect(out.headers["Cache-Control"]).toBe("no-store");
    expect(out.headers["Vercel-Cache-Tag"]).toBeUndefined();
  });

  it("reconexión: vuelve a servir normalmente", async () => {
    stubFetch(upstream);
    state.connected = false;
    await handler(get, mockRes().res);
    state.connected = true;
    const { res, out } = mockRes();
    await handler(get, res);
    expect(out.status).toBe(200);
  });
});
