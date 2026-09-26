import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import statusHandler from "../../api/twitch-status";
import clipsHandler from "../../api/twitch-clips";
import latestVideoHandler from "../../api/twitch-latest-video";
import { fetchTwitchHelix, resetTwitchCacheForTests } from "./twitch-shared";

// Fiabilidad de las peticiones a Twitch (9H-1): timeout real, 429, 5xx y el reintento ÚNICO ante un
// 401 de Helix. Todo determinista (reloj falso, fetch simulado); los tokens y credenciales son
// sintéticos.

const CREDS = {
  TWITCH_CLIENT_ID: "test-client-id",
  TWITCH_CLIENT_SECRET: "test-client-secret",
};

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
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

const req = () => ({ method: "GET" }) as VercelRequest;

const oauthOk = () => jsonResponse({ access_token: "token-sintetico", expires_in: 3600 });

/** fetch simulado; `helix` resuelve las llamadas a api.twitch.tv (y `oauth` la del token). */
function stubTwitch(
  helix: (url: string, call: number, init?: RequestInit) => Response | Promise<Response>,
  oauth: () => Response | Promise<Response> = oauthOk,
) {
  const calls = { oauth: 0, helix: 0 };
  const signals: (AbortSignal | undefined)[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    signals.push(init?.signal ?? undefined);
    if (url.includes("oauth2/token")) {
      calls.oauth++;
      return oauth();
    }
    calls.helix++;
    return helix(url, calls.helix, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock, signals };
}

/** fetch que nunca responde pero respeta el aborto. */
const hang = (_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted.", "AbortError")),
    );
  });

const originalEnv = { ...process.env };
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  Object.assign(process.env, CREDS);
  resetTwitchCacheForTests();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetTwitchCacheForTests();
});

const logged = () => JSON.stringify(errorSpy.mock.calls);

describe("timeout", () => {
  it("Helix no responde: aborta la petición y el handler responde 504 con code", async () => {
    vi.useFakeTimers();
    const { signals } = stubTwitch((url, _call, init) => hang(url, init));
    const { res, state } = mockRes();

    const done = statusHandler(req(), res);
    await vi.advanceTimersByTimeAsync(8_000);
    await done;

    expect(state.status).toBe(504);
    expect(state.body).toEqual({
      error: "No se pudo obtener el estado de Twitch",
      code: "provider_timeout",
    });
    // La llamada a Helix (la 2ª: la 1ª es el token) se abortó de verdad.
    expect(signals[1]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(logged()).not.toContain("test-client-secret");
  });

  it("la petición de token no responde: 504 y no se llama a Helix", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(hang);
    vi.stubGlobal("fetch", fetchMock);
    const { res, state } = mockRes();

    const done = clipsHandler(req(), res);
    await vi.advanceTimersByTimeAsync(8_000);
    await done;

    expect(state.status).toBe(504);
    expect(state.body).toMatchObject({ code: "provider_timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("oauth2/token");
    expect(logged()).not.toContain("test-client-secret");
  });

  it.each([
    ["latest-video", latestVideoHandler],
    ["clips", clipsHandler],
  ] as const)(
    "%s: la resolución del canal que no responde también vence",
    async (_n, handler) => {
      vi.useFakeTimers();
      stubTwitch((url, _call, init) => hang(url, init));
      const { res, state } = mockRes();

      const done = handler(req(), res);
      await vi.advanceTimersByTimeAsync(8_000);
      await done;

      expect(state.status).toBe(504);
      expect(state.body).toMatchObject({ code: "provider_timeout" });
    },
  );
});

describe("429 del proveedor", () => {
  it("streams con Retry-After válido: 429, code y cabecera Retry-After", async () => {
    stubTwitch(() => jsonResponse({ message: "Too Many" }, 429, { "Retry-After": "30" }));
    const { res, state } = mockRes();

    await statusHandler(req(), res);

    expect(state.status).toBe(429);
    expect(state.body).toEqual({
      error: "No se pudo obtener el estado de Twitch",
      code: "provider_rate_limited",
    });
    expect(state.headers["Retry-After"]).toBe("30");
    expect(state.headers["Cache-Control"]).toBeUndefined();
  });

  it.each(["soon", "-1", "9999999", ""])(
    "Retry-After malformado (%j): 429 sin cabecera Retry-After",
    async (value) => {
      stubTwitch(() => jsonResponse({}, 429, value ? { "Retry-After": value } : {}));
      const { res, state } = mockRes();

      await statusHandler(req(), res);

      expect(state.status).toBe(429);
      expect(state.headers["Retry-After"]).toBeUndefined();
    },
  );

  it("no reintenta ni duerme: una sola llamada a Helix", async () => {
    const { calls } = stubTwitch(() => jsonResponse({}, 429, { "Retry-After": "5" }));
    const { res } = mockRes();

    await statusHandler(req(), res);

    expect(calls.helix).toBe(1);
    expect(calls.oauth).toBe(1);
  });

  it("429 al pedir el token: 429 y no se llama a Helix", async () => {
    const { calls } = stubTwitch(
      () => jsonResponse({ data: [] }),
      () => jsonResponse({ message: "slow down" }, 429, { "Retry-After": "12" }),
    );
    const { res, state } = mockRes();

    await statusHandler(req(), res);

    expect(state.status).toBe(429);
    expect(state.headers["Retry-After"]).toBe("12");
    expect(calls.helix).toBe(0);
  });

  it("429 al resolver el canal (clips): 429", async () => {
    stubTwitch(() => jsonResponse({}, 429, { "Retry-After": "7" }));
    const { res, state } = mockRes();

    await clipsHandler(req(), res);

    expect(state.status).toBe(429);
    expect(state.headers["Retry-After"]).toBe("7");
  });

  it("429 en el último VOD: 429", async () => {
    stubTwitch((url) =>
      url.includes("/users")
        ? jsonResponse({ data: [{ id: "42" }] })
        : jsonResponse({}, 429, { "Retry-After": "9" }),
    );
    const { res, state } = mockRes();

    await latestVideoHandler(req(), res);

    expect(state.status).toBe(429);
    expect(state.headers["Retry-After"]).toBe("9");
  });
});

describe("5xx del proveedor", () => {
  it.each([500, 502, 503, 504])(
    "Helix %i: 502 público con el cuerpo de siempre, sin code y sin reintento",
    async (status) => {
      const { calls } = stubTwitch(() =>
        jsonResponse({ message: "detalle interno" }, status),
      );
      const { res, state } = mockRes();

      await statusHandler(req(), res);

      expect(state.status).toBe(502);
      expect(state.body).toEqual({ error: "No se pudo obtener el estado de Twitch" });
      expect(JSON.stringify(state.body)).not.toContain("detalle interno");
      expect(calls.helix).toBe(1);
    },
  );

  it("5xx al pedir el token: 502 sin llamar a Helix", async () => {
    const { calls } = stubTwitch(
      () => jsonResponse({ data: [] }),
      () => jsonResponse({ message: "boom" }, 503),
    );
    const { res, state } = mockRes();

    await statusHandler(req(), res);

    expect(state.status).toBe(502);
    expect(calls.helix).toBe(0);
  });
});

describe("respuesta inválida y fallo de red", () => {
  it("Helix 200 con cuerpo no JSON: 502 genérico", async () => {
    stubTwitch(() => new Response("<html>oops</html>", { status: 200 }));
    const { res, state } = mockRes();

    await statusHandler(req(), res);

    expect(state.status).toBe(502);
    expect(state.body).toEqual({ error: "No se pudo obtener el estado de Twitch" });
  });

  it("fallo de red: 502 genérico y el log no arrastra el error original", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        throw new TypeError(`fetch failed for ${url}`);
      }),
    );
    const { res, state } = mockRes();

    await statusHandler(req(), res);

    expect(state.status).toBe(502);
    expect(state.body).toEqual({ error: "No se pudo obtener el estado de Twitch" });
    expect(logged()).not.toContain("fetch failed for");
  });
});

describe("401 de Helix: reintento ÚNICO con token nuevo", () => {
  it("401 y luego 200: invalida el token, pide uno nuevo y reintenta exactamente una vez", async () => {
    const { calls } = stubTwitch((_url, call) =>
      call === 1
        ? jsonResponse({ message: "Invalid OAuth token" }, 401)
        : jsonResponse({ data: [] }),
    );
    const { res, state } = mockRes();

    await statusHandler(req(), res);

    expect(state.status).toBe(200);
    expect(state.body).toEqual({ isLive: false, channel: "upminaa" });
    expect(calls.oauth).toBe(2);
    expect(calls.helix).toBe(2);
  });

  it("segundo 401: se devuelve ese 401 y NO hay un tercer intento", async () => {
    const { calls } = stubTwitch(() =>
      jsonResponse({ message: "Invalid OAuth token" }, 401),
    );

    const response = await fetchTwitchHelix("streams?user_login=upminaa");

    expect(response.status).toBe(401);
    expect(calls.oauth).toBe(2);
    expect(calls.helix).toBe(2);
  });

  it("segundo 401 en un handler: 502 genérico, sin bucle", async () => {
    const { calls } = stubTwitch(() =>
      jsonResponse({ message: "Invalid OAuth token" }, 401),
    );
    const { res, state } = mockRes();

    await statusHandler(req(), res);

    expect(state.status).toBe(502);
    expect(state.body).toEqual({ error: "No se pudo obtener el estado de Twitch" });
    expect(calls.oauth).toBe(2);
    expect(calls.helix).toBe(2);
  });

  it("un 429 tras el 401 se clasifica como 429 y tampoco se reintenta más", async () => {
    const { calls } = stubTwitch((_url, call) =>
      call === 1 ? jsonResponse({}, 401) : jsonResponse({}, 429, { "Retry-After": "20" }),
    );
    const { res, state } = mockRes();

    await statusHandler(req(), res);

    expect(state.status).toBe(429);
    expect(state.headers["Retry-After"]).toBe("20");
    expect(calls.helix).toBe(2);
  });
});

describe("el camino feliz no cambia", () => {
  it("streams en vivo: 200, forma y Cache-Control intactos", async () => {
    stubTwitch(() =>
      jsonResponse({
        data: [
          {
            title: "Directo",
            viewer_count: 12,
            thumbnail_url: "https://t/{width}x{height}.jpg",
            started_at: "2026-09-26T10:00:00Z",
          },
        ],
      }),
    );
    const { res, state } = mockRes();

    await statusHandler(req(), res);

    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({
      isLive: true,
      channel: "upminaa",
      title: "Directo",
      viewerCount: 12,
    });
    expect(state.headers["Cache-Control"]).toBe("s-maxage=30, stale-while-revalidate=60");
  });

  it("no hay temporizadores pendientes tras una respuesta correcta", async () => {
    vi.useFakeTimers();
    stubTwitch(() => jsonResponse({ data: [] }));
    const { res } = mockRes();

    await statusHandler(req(), res);

    expect(vi.getTimerCount()).toBe(0);
  });
});
