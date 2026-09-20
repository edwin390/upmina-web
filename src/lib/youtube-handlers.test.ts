import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import latestHandler from "../../api/youtube-latest";
import videosHandler from "../../api/youtube-videos";

// Fijan el manejo de errores del backend de YouTube (config ausente, fallos de
// Google, secretos) y el contrato de las respuestas exitosas. No cubren la UI.

const API_KEY = "AIzaSy-clave-secreta-de-prueba";
const CHANNEL_ID = "UCcanal-de-prueba";

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
  };
  return { res: res as unknown as VercelResponse, state };
}

const req = (query: Record<string, string> = {}) =>
  ({ method: "GET", query }) as unknown as VercelRequest;

const CHANNEL_OK = {
  items: [{ contentDetails: { relatedPlaylists: { uploads: "UUuploads" } } }],
};

function playlistItem(videoId: string, title = `Video ${videoId}`) {
  return {
    snippet: {
      resourceId: { videoId },
      title,
      description: `Descripción ${videoId}`,
      thumbnails: { high: { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` } },
      publishedAt: "2026-09-18T19:00:31Z",
    },
  };
}

// Simula la API de Google. `overrides` permite forzar la respuesta de una
// operación concreta (channels | playlistItems | videos).
function stubGoogle(
  overrides: Partial<
    Record<"channels" | "playlistItems" | "videos", () => Response>
  > = {},
) {
  const fetchMock = vi.fn(async (url: string) => {
    const operation = new URL(url).pathname.split("/").pop() as
      "channels" | "playlistItems" | "videos";
    const override = overrides[operation];
    if (override) return override();
    if (operation === "channels") return jsonResponse(CHANNEL_OK);
    if (operation === "playlistItems") {
      return jsonResponse({ items: [playlistItem("vid1"), playlistItem("vid2")] });
    }
    return jsonResponse({
      items: [
        { id: "vid1", contentDetails: { duration: "PT8M38S" } },
        { id: "vid2", contentDetails: { duration: "PT16S" } },
      ],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Cuerpo de error de Google que además "hace eco" de la key: ni el log ni la
// respuesta pública pueden reproducirlo.
function googleError(status: number, reason: string, apiStatus: string) {
  return () =>
    jsonResponse(
      {
        error: {
          code: status,
          message: `Detalle de Google con la clave ${API_KEY} incluida`,
          status: apiStatus,
          errors: [{ reason, message: `otro ${API_KEY}` }],
        },
      },
      status,
    );
}

const handlers = [
  ["youtube-latest", latestHandler, "No se pudo obtener el último video de YouTube"],
  ["youtube-videos", videosHandler, "No se pudieron obtener los videos de YouTube"],
] as const;

describe.each(handlers)("api/%s: manejo de errores", (_name, handler, publicError) => {
  const originalEnv = { ...process.env };
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const loggedText = () => JSON.stringify(errorSpy.mock.calls);

  beforeEach(() => {
    Object.assign(process.env, {
      YOUTUBE_API_KEY: API_KEY,
      YOUTUBE_CHANNEL_ID: CHANNEL_ID,
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("configuración ausente", () => {
    it.each(["YOUTUBE_API_KEY", "YOUTUBE_CHANNEL_ID"])(
      "sin %s: 503 sin llamar a Google y sin filtrar valores",
      async (variable) => {
        delete process.env[variable];
        const fetchMock = stubGoogle();
        const { res, state } = mockRes();

        await handler(req(), res);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(state.status).toBe(503);
        expect(state.body).toEqual({ error: publicError });
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(loggedText()).toContain(variable);
        expect(loggedText()).not.toContain(API_KEY);
      },
    );

    it("variables solo con espacios cuentan como ausentes", async () => {
      process.env.YOUTUBE_API_KEY = "   ";
      const fetchMock = stubGoogle();
      const { res, state } = mockRes();

      await handler(req(), res);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(state.status).toBe(503);
    });
  });

  describe.each([
    [400, "keyInvalid", "INVALID_ARGUMENT"],
    [403, "quotaExceeded", "PERMISSION_DENIED"],
    [404, "playlistNotFound", "NOT_FOUND"],
    [429, "rateLimitExceeded", "RESOURCE_EXHAUSTED"],
    [500, "backendError", "INTERNAL"],
    [503, "backendError", "UNAVAILABLE"],
  ])("Google responde %i", (status, reason, apiStatus) => {
    it.each(["channels", "playlistItems", "videos"] as const)(
      `en la operación %s: 502 público genérico y log seguro con status y reason`,
      async (operation) => {
        stubGoogle({ [operation]: googleError(status, reason, apiStatus) });
        const { res, state } = mockRes();

        await handler(req(), res);

        expect(state.status).toBe(502);
        expect(state.body).toEqual({ error: publicError });
        expect(state.headers["Cache-Control"]).toBeUndefined();

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(loggedText()).toContain(operation);
        expect(loggedText()).toContain(`HTTP ${status}`);
        expect(loggedText()).toContain(reason);
        expect(loggedText()).not.toContain(API_KEY);
        expect(JSON.stringify(state.body)).not.toContain(API_KEY);
      },
    );
  });

  it("Google con cuerpo no JSON: se registra el status con reason 'unknown'", async () => {
    stubGoogle({
      channels: () => new Response("<html>Bad Gateway</html>", { status: 502 }),
    });
    const { res, state } = mockRes();

    await handler(req(), res);

    expect(state.status).toBe(502);
    expect(loggedText()).toContain("HTTP 502 (unknown)");
    expect(loggedText()).not.toContain("Bad Gateway");
  });

  it("reason con formato no seguro se descarta", async () => {
    stubGoogle({
      channels: googleError(403, `texto libre con ${API_KEY}`, "PERMISSION_DENIED"),
    });
    const { res } = mockRes();

    await handler(req(), res);

    expect(loggedText()).toContain("HTTP 403 (unknown)");
    expect(loggedText()).not.toContain(API_KEY);
  });

  it("error de red: 502 y el log no incluye la URL con la key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        throw new TypeError(`fetch failed for ${url}`);
      }),
    );
    const { res, state } = mockRes();

    await handler(req(), res);

    expect(state.status).toBe(502);
    expect(state.body).toEqual({ error: publicError });
    expect(loggedText()).toContain("error de red");
    expect(loggedText()).not.toContain(API_KEY);
  });

  it("canal inexistente (200 sin items): 502 genérico", async () => {
    stubGoogle({ channels: () => jsonResponse({ items: [] }) });
    const { res, state } = mockRes();

    await handler(req(), res);

    expect(state.status).toBe(502);
    expect(state.body).toEqual({ error: publicError });
    expect(loggedText()).toContain("canal no encontrado");
  });

  it("la key viaja solo en la petición a Google, nunca en logs ni en el cuerpo público", async () => {
    const fetchMock = stubGoogle({
      videos: googleError(403, "forbidden", "PERMISSION_DENIED"),
    });
    const { res, state } = mockRes();

    await handler(req(), res);

    for (const [url] of fetchMock.mock.calls) {
      expect(new URL(url).searchParams.get("key")).toBe(API_KEY);
    }
    expect(JSON.stringify(state)).not.toContain(API_KEY);
    expect(loggedText()).not.toContain(API_KEY);
    expect(loggedText()).not.toContain("googleapis.com");
  });
});

describe("api/youtube-latest: respuesta exitosa", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    Object.assign(process.env, {
      YOUTUBE_API_KEY: API_KEY,
      YOUTUBE_CHANNEL_ID: CHANNEL_ID,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("mantiene el contrato: 200, cache y campos normalizados", async () => {
    const fetchMock = stubGoogle({
      playlistItems: () =>
        jsonResponse({ items: [playlistItem("vid1", "Último video")] }),
    });
    const { res, state } = mockRes();

    await latestHandler(req(), res);

    expect(state.status).toBe(200);
    expect(state.headers["Cache-Control"]).toBe(
      "s-maxage=900, stale-while-revalidate=1800",
    );
    expect(state.body).toEqual({
      id: "vid1",
      title: "Último video",
      description: "Descripción vid1",
      thumbnailUrl: "https://i.ytimg.com/vi/vid1/hqdefault.jpg",
      publishedAt: "2026-09-18T19:00:31Z",
      duration: "8:38",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("canal sin videos: 404 'Sin videos' como antes", async () => {
    stubGoogle({ playlistItems: () => jsonResponse({ items: [] }) });
    const { res, state } = mockRes();

    await latestHandler(req(), res);

    expect(state.status).toBe(404);
    expect(state.body).toEqual({ error: "Sin videos" });
  });

  it("consulta el canal configurado y limita la playlist a 1 resultado", async () => {
    const fetchMock = stubGoogle();
    const { res } = mockRes();

    await latestHandler(req(), res);

    const urls = fetchMock.mock.calls.map(([url]) => new URL(url));
    expect(urls[0].searchParams.get("id")).toBe(CHANNEL_ID);
    expect(urls[1].searchParams.get("playlistId")).toBe("UUuploads");
    expect(urls[1].searchParams.get("maxResults")).toBe("1");
  });
});

describe("api/youtube-videos: respuesta exitosa", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    Object.assign(process.env, {
      YOUTUBE_API_KEY: API_KEY,
      YOUTUBE_CHANNEL_ID: CHANNEL_ID,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("mantiene el contrato: 200, cache y lista normalizada en orden", async () => {
    const fetchMock = stubGoogle();
    const { res, state } = mockRes();

    await videosHandler(req(), res);

    expect(state.status).toBe(200);
    expect(state.headers["Cache-Control"]).toBe(
      "s-maxage=900, stale-while-revalidate=1800",
    );
    expect(state.body).toEqual([
      {
        id: "vid1",
        title: "Video vid1",
        description: "Descripción vid1",
        thumbnailUrl: "https://i.ytimg.com/vi/vid1/hqdefault.jpg",
        publishedAt: "2026-09-18T19:00:31Z",
        duration: "8:38",
      },
      {
        id: "vid2",
        title: "Video vid2",
        description: "Descripción vid2",
        thumbnailUrl: "https://i.ytimg.com/vi/vid2/hqdefault.jpg",
        publishedAt: "2026-09-18T19:00:31Z",
        duration: "0:16",
      },
    ]);
    const videosUrl = new URL(fetchMock.mock.calls[2][0]);
    expect(videosUrl.searchParams.get("id")).toBe("vid1,vid2");
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, "12"],
    ["5", "5"],
    ["999", "50"],
  ])("maxResults=%s se envía a Google como %s", async (input, expected) => {
    const fetchMock = stubGoogle();
    const { res } = mockRes();

    await videosHandler(req(input ? { maxResults: input } : {}), res);

    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get("maxResults")).toBe(
      expected,
    );
  });

  it("playlist vacía: 200 [] sin pedir detalles de videos", async () => {
    const fetchMock = stubGoogle({ playlistItems: () => jsonResponse({ items: [] }) });
    const { res, state } = mockRes();

    await videosHandler(req(), res);

    expect(state.status).toBe(200);
    expect(state.body).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
