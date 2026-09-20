import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import statusHandler from "../../api/twitch-status";
import latestVideoHandler from "../../api/twitch-latest-video";
import { resetTwitchCacheForTests } from "./twitch-shared";

// Estos tests fijan el contrato de transformación Helix -> respuesta de la API
// (incluido el camino LIVE, que solo puede validarse con un stream real de
// forma manual). No sustituyen esa validación: cubren regresiones del mapeo.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockRes() {
  const state: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const res = {
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return res;
    },
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
    end() {
      return res;
    },
  };
  return { res: res as unknown as VercelResponse, state };
}

const req = (method = "GET") => ({ method }) as VercelRequest;

function stubHelix(routes: (url: string) => Response | undefined) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return jsonResponse({ access_token: "token-de-prueba", expires_in: 3600 });
      }
      return routes(url) ?? jsonResponse({ data: [] });
    }),
  );
}

describe("api/twitch-status", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    Object.assign(process.env, {
      TWITCH_CLIENT_ID: "test-client-id",
      TWITCH_CLIENT_SECRET: "test-client-secret",
      TWITCH_CHANNEL: "canal_de_prueba",
    });
    resetTwitchCacheForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTwitchCacheForTests();
  });

  it("canal en directo: devuelve isLive, canal dinámico, viewers y thumbnail con tamaño aplicado", async () => {
    stubHelix((url) =>
      url.includes("streams?user_login=canal_de_prueba")
        ? jsonResponse({
            data: [
              {
                title: "Directo de prueba",
                viewer_count: 1234,
                thumbnail_url: "https://cdn/live_user-{width}x{height}.jpg",
                started_at: "2026-01-01T10:00:00Z",
              },
            ],
          })
        : undefined,
    );
    const { res, state } = mockRes();

    await statusHandler(req(), res);

    expect(state.status).toBe(200);
    expect(state.body).toEqual({
      isLive: true,
      channel: "canal_de_prueba",
      title: "Directo de prueba",
      viewerCount: 1234,
      thumbnailUrl: "https://cdn/live_user-440x248.jpg",
      startedAt: "2026-01-01T10:00:00Z",
    });
  });

  it("canal offline: devuelve isLive false y el canal consultado", async () => {
    stubHelix(() => jsonResponse({ data: [] }));
    const { res, state } = mockRes();

    await statusHandler(req(), res);

    expect(state.status).toBe(200);
    expect(state.body).toEqual({ isLive: false, channel: "canal_de_prueba" });
  });

  it("stream sin thumbnail_url: no rompe y omite thumbnailUrl", async () => {
    stubHelix(() =>
      jsonResponse({
        data: [{ title: "t", viewer_count: 1, started_at: "2026-01-01T10:00:00Z" }],
      }),
    );
    const { res, state } = mockRes();

    await statusHandler(req(), res);

    expect(state.status).toBe(200);
    expect((state.body as { thumbnailUrl?: string }).thumbnailUrl).toBeUndefined();
  });

  it("rechaza métodos distintos de GET con 405", async () => {
    const { res, state } = mockRes();

    await statusHandler(req("POST"), res);

    expect(state.status).toBe(405);
  });

  it("sin credenciales: responde 503 con mensaje genérico (sin filtrar detalles)", async () => {
    delete process.env.TWITCH_CLIENT_ID;
    delete process.env.TWITCH_CLIENT_SECRET;
    const { res, state } = mockRes();

    await statusHandler(req(), res);

    expect(state.status).toBe(503);
    expect(JSON.stringify(state.body)).not.toMatch(/CLIENT_SECRET|CLIENT_ID/);
  });

  it("Helix responde 500: responde 502 genérico", async () => {
    stubHelix(() => jsonResponse({ message: "boom" }, 500));
    const { res, state } = mockRes();

    await statusHandler(req(), res);

    expect(state.status).toBe(502);
    expect(JSON.stringify(state.body)).not.toContain("boom");
  });
});

describe("api/twitch-latest-video", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    Object.assign(process.env, {
      TWITCH_CLIENT_ID: "test-client-id",
      TWITCH_CLIENT_SECRET: "test-client-secret",
      TWITCH_CHANNEL: "canal_de_prueba",
    });
    resetTwitchCacheForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTwitchCacheForTests();
  });

  it("devuelve id, url, título, thumbnail, fecha y duración del VOD más reciente", async () => {
    stubHelix((url) => {
      if (url.includes("/users")) return jsonResponse({ data: [{ id: "42" }] });
      if (url.includes("/videos")) {
        return jsonResponse({
          data: [
            {
              id: "999",
              url: "https://www.twitch.tv/videos/999",
              title: "VOD de prueba",
              thumbnail_url: "https://cdn/vod-%{width}x%{height}.jpg",
              created_at: "2026-01-01T10:00:00Z",
              duration: "3h8m33s",
            },
          ],
        });
      }
      return undefined;
    });
    const { res, state } = mockRes();

    await latestVideoHandler(req(), res);

    expect(state.status).toBe(200);
    expect(state.body).toEqual({
      id: "999",
      url: "https://www.twitch.tv/videos/999",
      title: "VOD de prueba",
      thumbnailUrl: "https://cdn/vod-640x360.jpg",
      createdAt: "2026-01-01T10:00:00Z",
      duration: "3h8m33s",
    });
  });

  it("canal sin VOD: responde 204 (estado vacío, no error)", async () => {
    stubHelix((url) =>
      url.includes("/users") ? jsonResponse({ data: [{ id: "42" }] }) : undefined,
    );
    const { res, state } = mockRes();

    await latestVideoHandler(req(), res);

    expect(state.status).toBe(204);
  });
});
