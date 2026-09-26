import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import latestHandler from "../../api/youtube-latest";
import videosHandler from "../../api/youtube-videos";
import { resetYouTubeCacheForTests } from "./youtube-shared";

// Fiabilidad de las peticiones a YouTube (9H-1): timeout real, 429 con Retry-After, 5xx y la
// conservación de la semántica existente (403 quotaExceeded/forbidden → 502, la key nunca se
// registra ni se devuelve). Determinista: reloj falso y fetch simulado; la key es sintética.

const API_KEY = "AIzaSy-clave-sintetica-de-prueba";
const CHANNEL_ID = "UCcanal-de-prueba";

type Operation = "channels" | "playlistItems" | "videos";
const OPERATIONS: Operation[] = ["channels", "playlistItems", "videos"];

const jsonResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

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

const req = () => ({ method: "GET", query: {} }) as unknown as VercelRequest;

const CHANNEL_OK = {
  items: [{ contentDetails: { relatedPlaylists: { uploads: "UUuploads" } } }],
};
const PLAYLIST_OK = {
  items: [
    {
      snippet: {
        resourceId: { videoId: "vid1" },
        title: "Video 1",
        description: "Descripción",
        thumbnails: { high: { url: "https://i.ytimg.com/vi/vid1/hqdefault.jpg" } },
        publishedAt: "2026-09-18T19:00:31Z",
      },
    },
  ],
};
const VIDEOS_OK = { items: [{ id: "vid1", contentDetails: { duration: "PT8M38S" } }] };

/** Google simulado. `override(operation, init)` puede sustituir la respuesta de una operación. */
function stubGoogle(
  override: (
    operation: Operation,
    init?: RequestInit,
  ) => Response | Promise<Response> | undefined,
) {
  const signals: Partial<Record<Operation, AbortSignal | undefined>> = {};
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const operation = new URL(url).pathname.split("/").pop() as Operation;
    signals[operation] = init?.signal ?? undefined;
    const custom = override(operation, init);
    if (custom) return custom;
    if (operation === "channels") return jsonResponse(CHANNEL_OK);
    if (operation === "playlistItems") return jsonResponse(PLAYLIST_OK);
    return jsonResponse(VIDEOS_OK);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, signals };
}

const hang = (init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted.", "AbortError")),
    );
  });

const handlers = [
  ["youtube-latest", latestHandler, "No se pudo obtener el último video de YouTube"],
  ["youtube-videos", videosHandler, "No se pudieron obtener los videos de YouTube"],
] as const;

const originalEnv = { ...process.env };
let errorSpy: ReturnType<typeof vi.spyOn>;
const logged = () => JSON.stringify(errorSpy.mock.calls);

beforeEach(() => {
  resetYouTubeCacheForTests();
  Object.assign(process.env, {
    YOUTUBE_API_KEY: API_KEY,
    YOUTUBE_CHANNEL_ID: CHANNEL_ID,
  });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(handlers)("api/%s", (_name, handler, publicError) => {
  describe("timeout", () => {
    it.each(OPERATIONS)(
      "Google no responde en %s: aborta y responde 504 con code, sin filtrar la key",
      async (operation) => {
        vi.useFakeTimers();
        const { signals } = stubGoogle((op, init) =>
          op === operation ? hang(init) : undefined,
        );
        const { res, state } = mockRes();

        const done = handler(req(), res);
        await vi.advanceTimersByTimeAsync(8_000);
        await done;

        expect(state.status).toBe(504);
        expect(state.body).toEqual({ error: publicError, code: "provider_timeout" });
        expect(state.headers["Cache-Control"]).toBeUndefined();
        expect(signals[operation]?.aborted).toBe(true);
        expect(logged()).toContain(operation);
        expect(logged()).toContain("tiempo de espera agotado");
        expect(logged()).not.toContain(API_KEY);
        expect(JSON.stringify(state.body)).not.toContain(API_KEY);
        expect(vi.getTimerCount()).toBe(0);
      },
    );
  });

  describe("429", () => {
    it("con Retry-After válido: 429, code y cabecera; no se reintenta", async () => {
      const { fetchMock } = stubGoogle((op) =>
        op === "channels"
          ? jsonResponse({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, 429, {
              "Retry-After": "60",
            })
          : undefined,
      );
      const { res, state } = mockRes();

      await handler(req(), res);

      expect(state.status).toBe(429);
      expect(state.body).toEqual({ error: publicError, code: "provider_rate_limited" });
      expect(state.headers["Retry-After"]).toBe("60");
      expect(state.headers["Cache-Control"]).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(logged()).toContain("HTTP 429");
      expect(logged()).toContain("rateLimitExceeded");
      expect(logged()).not.toContain(API_KEY);
    });

    it.each(["mañana", "-3", "100000", ""])(
      "Retry-After malformado (%j): 429 sin cabecera",
      async (value) => {
        stubGoogle((op) =>
          op === "channels"
            ? jsonResponse({}, 429, value ? { "Retry-After": value } : {})
            : undefined,
        );
        const { res, state } = mockRes();

        await handler(req(), res);

        expect(state.status).toBe(429);
        expect(state.headers["Retry-After"]).toBeUndefined();
      },
    );

    it.each(OPERATIONS)("429 en %s: 429 público", async (operation) => {
      stubGoogle((op) => (op === operation ? jsonResponse({}, 429) : undefined));
      const { res, state } = mockRes();

      await handler(req(), res);

      expect(state.status).toBe(429);
    });
  });

  describe("5xx", () => {
    it.each([500, 502, 503, 504])(
      "Google %i: 502 con el cuerpo de siempre (sin code) y sin reintento",
      async (status) => {
        const { fetchMock } = stubGoogle((op) =>
          op === "channels"
            ? jsonResponse({ error: { errors: [{ reason: "backendError" }] } }, status)
            : undefined,
        );
        const { res, state } = mockRes();

        await handler(req(), res);

        expect(state.status).toBe(502);
        expect(state.body).toEqual({ error: publicError });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(logged()).toContain(`HTTP ${status}`);
        expect(logged()).toContain("backendError");
      },
    );
  });

  describe("semántica existente conservada", () => {
    it.each([
      ["quotaExceeded", "PERMISSION_DENIED"],
      ["forbidden", "PERMISSION_DENIED"],
      ["dailyLimitExceeded", "PERMISSION_DENIED"],
    ])(
      "403 %s: sigue siendo 502 genérico y se registra el reason",
      async (reason, apiStatus) => {
        stubGoogle((op) =>
          op === "channels"
            ? jsonResponse(
                {
                  error: {
                    status: apiStatus,
                    message: `detalle con la key ${API_KEY}`,
                    errors: [{ reason }],
                  },
                },
                403,
              )
            : undefined,
        );
        const { res, state } = mockRes();

        await handler(req(), res);

        expect(state.status).toBe(502);
        expect(state.body).toEqual({ error: publicError });
        expect(logged()).toContain("HTTP 403");
        expect(logged()).toContain(reason);
        expect(logged()).not.toContain(API_KEY);
      },
    );

    it("200 con cuerpo no JSON: 502 genérico (INVALID_RESPONSE)", async () => {
      stubGoogle((op) =>
        op === "channels"
          ? new Response("<html>oops</html>", { status: 200 })
          : undefined,
      );
      const { res, state } = mockRes();

      await handler(req(), res);

      expect(state.status).toBe(502);
      expect(state.body).toEqual({ error: publicError });
      expect(logged()).toContain("respuesta no válida");
    });

    it("fallo de red: 502 y el log no incluye la URL con la key", async () => {
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
      expect(logged()).toContain("error de red");
      expect(logged()).not.toContain(API_KEY);
    });

    it("sin credenciales: 503 y no se llama a Google", async () => {
      delete process.env.YOUTUBE_API_KEY;
      const { fetchMock } = stubGoogle(() => undefined);
      const { res, state } = mockRes();

      await handler(req(), res);

      expect(state.status).toBe(503);
      expect(state.body).toEqual({ error: publicError });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("camino feliz", () => {
    it("200 con Cache-Control intacto y sin temporizadores pendientes", async () => {
      vi.useFakeTimers();
      stubGoogle(() => undefined);
      const { res, state } = mockRes();

      await handler(req(), res);

      expect(state.status).toBe(200);
      expect(state.headers["Cache-Control"]).toBe(
        "s-maxage=900, stale-while-revalidate=1800",
      );
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
