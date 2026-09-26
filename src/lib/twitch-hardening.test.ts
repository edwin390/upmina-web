import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import clipsHandler from "../../api/twitch-clips";
import latestVideoHandler from "../../api/twitch-latest-video";
import statusHandler from "../../api/twitch-status";
import { createDeadline, ProviderApiError, ProviderRequestError } from "./provider-http";
import { MAX_CLIPS, TWITCH_CLIPS_DEADLINE_MS, getRecentClips } from "./twitch-clips";
import {
  fetchTwitchHelix,
  getBroadcasterId,
  resetTwitchCacheForTests,
} from "./twitch-shared";

// Endurecimiento de Twitch (9H-2): plazo TOTAL de los clips, política ante fallos parciales,
// semántica de las cachés en memoria y saneado de los logs. Determinista: reloj falso o inyectado,
// fetch simulado, credenciales sintéticas.

const CREDS = {
  TWITCH_CLIENT_ID: "test-client-id-sintetico",
  TWITCH_CLIENT_SECRET: "test-client-secret-sintetico",
};
const NOW = new Date("2026-09-26T12:00:00Z");

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const oauthOk = () => json({ access_token: "token-sintetico", expires_in: 3600 });

function clip(id: string, minutesAgo: number, thumbnail = "https://t.example/x.jpg") {
  return {
    id,
    url: `https://clips.twitch.tv/${id}`,
    title: `Clip ${id}`,
    creator_name: "creador",
    thumbnail_url: thumbnail,
    view_count: 1,
    created_at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  };
}

/** Respuesta que llega tras `ms` (reloj falso) y respeta el aborto como el fetch real. */
const after = (ms: number, init: RequestInit | undefined, make: () => Response) =>
  new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(make()), ms);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });

const hang = (init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted.", "AbortError")),
    );
  });

interface Stub {
  clipCalls: number;
  oauthCalls: number;
  userCalls: number;
  signals: (AbortSignal | undefined)[];
}

/**
 * Twitch simulado. `clips(n, init)` responde a la petición de clips número n (1, 2, …);
 * `users` a la resolución del canal; `oauth` al token.
 */
function stubTwitch(handlers: {
  clips?: (n: number, init?: RequestInit) => Response | Promise<Response>;
  users?: (init?: RequestInit) => Response | Promise<Response>;
  oauth?: (n: number, init?: RequestInit) => Response | Promise<Response>;
  videos?: (init?: RequestInit) => Response | Promise<Response>;
  streams?: (init?: RequestInit) => Response | Promise<Response>;
}): Stub {
  const stub: Stub = { clipCalls: 0, oauthCalls: 0, userCalls: 0, signals: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2/token")) {
        stub.oauthCalls++;
        return handlers.oauth ? handlers.oauth(stub.oauthCalls, init) : oauthOk();
      }
      if (url.includes("/clips?")) {
        stub.clipCalls++;
        stub.signals.push(init?.signal ?? undefined);
        return handlers.clips ? handlers.clips(stub.clipCalls, init) : json({ data: [] });
      }
      if (url.includes("/users?")) {
        stub.userCalls++;
        return handlers.users ? handlers.users(init) : json({ data: [{ id: "42" }] });
      }
      if (url.includes("/videos?")) return handlers.videos?.(init) ?? json({ data: [] });
      if (url.includes("/streams?"))
        return handlers.streams?.(init) ?? json({ data: [] });
      throw new Error(`fetch inesperado: ${url}`);
    }),
  );
  return stub;
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

const originalEnv = { ...process.env };
let errorSpy: ReturnType<typeof vi.spyOn>;
const logged = () => JSON.stringify(errorSpy.mock.calls);

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

describe("plazo total de los clips", () => {
  it("el presupuesto elegido es de 8 s (por debajo del límite clásico de 10 s de Hobby)", () => {
    expect(TWITCH_CLIPS_DEADLINE_MS).toBe(8_000);
  });

  it("sin ningún clip utilizable: la petición en vuelo vence exactamente al agotarse el plazo", async () => {
    vi.useFakeTimers();
    const stub = stubTwitch({ clips: (_n, init) => hang(init) });
    const deadline = createDeadline(8_000);

    const promise = getRecentClips("42", NOW, { deadline });
    const assertion = expect(promise).rejects.toMatchObject({
      kind: "TIMEOUT",
      status: 504,
    });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(stub.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;

    expect(stub.signals[0]?.aborted).toBe(true);
    expect(stub.clipCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cada petición usa solo lo que queda del plazo, no su timeout completo", async () => {
    vi.useFakeTimers();
    // 1ª petición: tarda 5 s y devuelve una ventana vacía. 2ª: se cuelga.
    const stub = stubTwitch({
      clips: (n, init) =>
        n === 1 ? after(5_000, init, () => json({ data: [] })) : hang(init),
    });
    const deadline = createDeadline(8_000);

    const promise = getRecentClips("42", NOW, { deadline });
    const assertion = expect(promise).rejects.toMatchObject({ kind: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stub.clipCalls).toBe(2);
    // La 2ª tenía 8 s de timeout por petición, pero solo le quedaban 3 s de plazo.
    await vi.advanceTimersByTimeAsync(2_999);
    expect(stub.signals[1]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;

    expect(stub.signals[1]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("agotado el plazo NO se inicia otra petición (reloj inyectado)", async () => {
    let clock = 0;
    const deadline = createDeadline(8_000, () => clock);
    const stub = stubTwitch({
      // La primera ventana responde vacía pero "consume" todo el presupuesto.
      clips: () => {
        clock += 8_000;
        return json({ data: [] });
      },
    });

    await expect(getRecentClips("42", NOW, { deadline })).rejects.toMatchObject({
      kind: "TIMEOUT",
    });

    expect(stub.clipCalls).toBe(1);
  });

  it("el plazo también cubre el token y la resolución del canal (mismo presupuesto)", async () => {
    vi.useFakeTimers();
    const stub = stubTwitch({
      oauth: (_n, init) => after(5_000, init, oauthOk),
      users: (init) => after(2_000, init, () => json({ data: [{ id: "42" }] })),
      clips: (_n, init) => hang(init),
    });
    const { res, state } = mockRes();

    const done = clipsHandler(req(), res);
    await vi.advanceTimersByTimeAsync(7_000);
    // El token tardó 5 s, el canal 2 s: la petición de clips empieza con 1 s de plazo.
    expect(stub.clipCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(stub.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(stub.signals[0]?.aborted).toBe(true);
    expect(state.status).toBe(504);
    expect(state.body).toEqual({
      error: "No se pudieron obtener los clips de Twitch",
      code: "provider_timeout",
    });
    expect(state.headers["Cache-Control"]).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("un 401 de Helix sigue reintentándose UNA sola vez dentro de la búsqueda de clips", async () => {
    const stub = stubTwitch({
      clips: (n) =>
        n === 1
          ? json({ message: "Invalid OAuth token" }, 401)
          : json({ data: [clip("a", 10)] }),
    });

    const clips = await getRecentClips("42", NOW, { deadline: createDeadline(8_000) });

    expect(clips.map((c) => c.id)).toContain("a");
    expect(stub.oauthCalls).toBe(2);
  });

  it("segundo 401 en los clips: falla sin un tercer intento", async () => {
    const stub = stubTwitch({
      clips: () => json({ message: "Invalid OAuth token" }, 401),
    });

    await expect(getRecentClips("42", NOW)).rejects.toBeInstanceOf(ProviderRequestError);

    expect(stub.oauthCalls).toBe(2);
    expect(stub.clipCalls).toBe(2);
  });
});

describe("política ante un fallo a mitad de la búsqueda", () => {
  const partial = () => json({ data: [clip("c1", 30), clip("c2", 10), clip("c3", 20)] });

  it.each([
    ["timeout", (_n: number, init?: RequestInit) => hang(init), "TIMEOUT"],
    ["429", () => json({}, 429, { "Retry-After": "30" }), "RATE_LIMITED"],
    ["5xx", () => json({ message: "boom" }, 503), "UPSTREAM_UNAVAILABLE"],
    [
      "respuesta no JSON",
      () => new Response("<html>", { status: 200 }),
      "INVALID_RESPONSE",
    ],
  ] as const)(
    "%s en una ventana posterior con clips ya reunidos: devuelve los clips (ordenados) y avisa",
    async (_name, failure, kind) => {
      vi.useFakeTimers();
      const stub = stubTwitch({
        clips: (n, init) => (n === 1 ? partial() : failure(n, init)),
      });
      const onIncomplete = vi.fn();

      const promise = getRecentClips("42", NOW, {
        deadline: createDeadline(8_000),
        onIncomplete,
      });
      await vi.advanceTimersByTimeAsync(8_000);
      const clips = await promise;

      expect(clips.map((c) => c.id)).toEqual(["c2", "c3", "c1"]);
      expect(onIncomplete).toHaveBeenCalledTimes(1);
      expect(onIncomplete.mock.calls[0][0]).toBeInstanceOf(ProviderApiError);
      expect(onIncomplete.mock.calls[0][0].kind).toBe(kind);
      // No hay reintento del fallo: una única petición fallida tras la primera ventana.
      expect(stub.clipCalls).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("plazo agotado tras reunir clips: se devuelven, no se descartan", async () => {
    let clock = 0;
    const deadline = createDeadline(8_000, () => clock);
    const stub = stubTwitch({
      clips: () => {
        clock += 8_000;
        return partial();
      },
    });
    const onIncomplete = vi.fn();

    const clips = await getRecentClips("42", NOW, { deadline, onIncomplete });

    expect(clips.map((c) => c.id)).toEqual(["c2", "c3", "c1"]);
    expect(onIncomplete.mock.calls[0][0].kind).toBe("TIMEOUT");
    expect(stub.clipCalls).toBe(1);
  });

  it.each([
    ["timeout", (_n: number, init?: RequestInit) => hang(init)],
    ["429", () => json({}, 429)],
    ["5xx", () => json({}, 502)],
  ] as const)(
    "%s en la PRIMERA ventana: el fallo se propaga (no se confunde con un canal sin clips)",
    async (_name, failure) => {
      vi.useFakeTimers();
      stubTwitch({ clips: failure });

      const promise = getRecentClips("42", NOW, { onIncomplete: vi.fn() });
      const assertion = expect(promise).rejects.toBeInstanceOf(ProviderRequestError);
      await vi.advanceTimersByTimeAsync(8_000);
      await assertion;
    },
  );

  it("ventana vacía válida y luego un fallo: se propaga (no es un vacío legítimo)", async () => {
    const onIncomplete = vi.fn();
    stubTwitch({ clips: (n) => (n === 1 ? json({ data: [] }) : json({}, 503)) });

    await expect(getRecentClips("42", NOW, { onIncomplete })).rejects.toBeInstanceOf(
      ProviderRequestError,
    );
    expect(onIncomplete).not.toHaveBeenCalled();
  });

  it("con suficientes clips no se hacen más peticiones: un fallo posterior no puede ocurrir", async () => {
    const many = Array.from({ length: MAX_CLIPS + 3 }, (_v, i) => clip(`k${i}`, i + 1));
    const stub = stubTwitch({
      clips: (n) => (n === 1 ? json({ data: many }) : json({}, 503)),
    });
    const onIncomplete = vi.fn();

    const clips = await getRecentClips("42", NOW, { onIncomplete });

    expect(clips).toHaveLength(MAX_CLIPS);
    expect(stub.clipCalls).toBe(1);
    expect(onIncomplete).not.toHaveBeenCalled();
  });

  it("menos clips de los pedidos tras recorrer todo con éxito: se devuelven sin avisar de fallo", async () => {
    const stub = stubTwitch({
      clips: (n) => json({ data: n === 1 ? [clip("solo", 5)] : [] }),
    });
    const onIncomplete = vi.fn();

    const clips = await getRecentClips("42", NOW, { onIncomplete });

    expect(clips.map((c) => c.id)).toEqual(["solo"]);
    expect(onIncomplete).not.toHaveBeenCalled();
    expect(stub.clipCalls).toBeGreaterThan(1);
  });

  it("dedupe, orden y filtro de reproducibles siguen igual en un resultado parcial", async () => {
    stubTwitch({
      clips: (n) =>
        n === 1
          ? json({
              data: [
                clip("viejo", 60),
                clip("nuevo", 5),
                clip("nuevo", 5), // duplicado
                clip("sin-miniatura", 1, ""), // no reproducible
                { id: "", created_at: NOW.toISOString(), thumbnail_url: "https://t/x" },
                clip("medio", 30),
              ],
            })
          : json({}, 429),
    });

    const clips = await getRecentClips("42", NOW, { onIncomplete: vi.fn() });

    expect(clips.map((c) => c.id)).toEqual(["nuevo", "medio", "viejo"]);
  });

  it("un fallo de red tras reunir clips también es parcial (NETWORK_ERROR)", async () => {
    stubTwitch({
      clips: (n) => {
        if (n === 1) return json({ data: [clip("a", 5)] });
        throw new TypeError("fetch failed");
      },
    });

    const onIncomplete = vi.fn();
    const clips = await getRecentClips("42", NOW, { onIncomplete });
    expect(clips.map((c) => c.id)).toEqual(["a"]);
    expect(onIncomplete.mock.calls[0][0].kind).toBe("NETWORK_ERROR");
  });
});

describe("api/twitch-clips: respuesta y caché", () => {
  it("lista completa: 200 con la caché de siempre", async () => {
    const many = Array.from({ length: MAX_CLIPS }, (_v, i) => clip(`k${i}`, i + 1));
    stubTwitch({ clips: () => json({ data: many }) });
    const { res, state } = mockRes();

    await clipsHandler(req(), res);

    expect(state.status).toBe(200);
    expect(state.headers["Cache-Control"]).toBe(
      "s-maxage=300, stale-while-revalidate=600",
    );
    expect(state.body).toHaveLength(MAX_CLIPS);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("lista parcial: 200 con caché CORTA y un log saneado del fallo", async () => {
    stubTwitch({
      clips: (n) =>
        n === 1 ? json({ data: [clip("a", 10), clip("b", 20)] }) : json({}, 429),
    });
    const { res, state } = mockRes();

    await clipsHandler(req(), res);

    expect(state.status).toBe(200);
    expect(state.body).toHaveLength(2);
    expect(state.headers["Cache-Control"]).toBe(
      "s-maxage=60, stale-while-revalidate=120",
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logged()).toContain("twitch-clips");
    expect(logged()).not.toContain(CREDS.TWITCH_CLIENT_SECRET);
  });

  it("sin ningún clip y con fallo: error, sin Cache-Control (no se cachea un fallo)", async () => {
    stubTwitch({ clips: () => json({}, 429, { "Retry-After": "15" }) });
    const { res, state } = mockRes();

    await clipsHandler(req(), res);

    expect(state.status).toBe(429);
    expect(state.headers["Retry-After"]).toBe("15");
    expect(state.headers["Cache-Control"]).toBeUndefined();
  });

  it("lista vacía y válida: 200 [] con caché normal (distinto de un fallo)", async () => {
    stubTwitch({ clips: () => json({ data: [] }) });
    const { res, state } = mockRes();

    await clipsHandler(req(), res);

    expect(state.status).toBe(200);
    expect(state.body).toEqual([]);
    expect(state.headers["Cache-Control"]).toBe(
      "s-maxage=300, stale-while-revalidate=600",
    );
  });
});

describe("cachés en memoria de Twitch ante errores", () => {
  it("el broadcasterId válido se conserva: un fallo posterior de Helix no lo invalida", async () => {
    const stub = stubTwitch({ clips: () => json({}, 503) });

    expect(await getBroadcasterId()).toBe("42");
    await expect(getRecentClips("42", NOW)).rejects.toBeInstanceOf(ProviderRequestError);
    expect(await getBroadcasterId()).toBe("42");

    expect(stub.userCalls).toBe(1);
  });

  it.each([
    ["429", () => json({}, 429)],
    ["5xx", () => json({}, 503)],
    ["cuerpo no JSON", () => new Response("<html>", { status: 200 })],
    ["canal inexistente", () => json({ data: [] })],
  ] as const)(
    "resolución del canal fallida (%s): no se cachea",
    async (_name, failure) => {
      let call = 0;
      const stub = stubTwitch({
        users: () => (++call === 1 ? failure() : json({ data: [{ id: "7" }] })),
      });

      await expect(getBroadcasterId()).rejects.toBeInstanceOf(ProviderApiError);
      expect(await getBroadcasterId()).toBe("7");

      expect(stub.userCalls).toBe(2);
    },
  );

  it("un fallo al refrescar el token no deja un token inválido cacheado", async () => {
    let helix = 0;
    const stub = stubTwitch({
      oauth: (n) => (n === 2 ? json({ message: "boom" }, 503) : oauthOk()),
      users: () => (++helix === 1 ? json({}, 401) : json({ data: [{ id: "42" }] })),
    });

    // 401 → refresco (falla con 503) → error; nada queda cacheado como bueno.
    await expect(getBroadcasterId()).rejects.toBeInstanceOf(ProviderRequestError);
    // La siguiente petición pide un token nuevo (3.ª petición de token) y funciona.
    expect(await getBroadcasterId()).toBe("42");

    expect(stub.oauthCalls).toBe(3);
  });
});

describe("último VOD", () => {
  const video = {
    id: "9",
    url: "https://www.twitch.tv/videos/9",
    title: "Stream",
    thumbnail_url: "https://t.example/%{width}x%{height}.jpg",
    created_at: "2026-09-23T18:00:00Z",
    duration: "3h28m10s",
  };

  it("éxito: forma y Cache-Control intactos", async () => {
    stubTwitch({ videos: () => json({ data: [video] }) });
    const { res, state } = mockRes();

    await latestVideoHandler(req(), res);

    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ id: "9", title: "Stream", duration: "3h28m10s" });
    expect(state.headers["Cache-Control"]).toBe(
      "s-maxage=300, stale-while-revalidate=600",
    );
  });

  it("respuesta vacía válida: 204 con su Cache-Control", async () => {
    stubTwitch({ videos: () => json({ data: [] }) });
    const { res, state } = mockRes();

    await latestVideoHandler(req(), res);

    expect(state.status).toBe(204);
    expect(state.headers["Cache-Control"]).toBe(
      "s-maxage=300, stale-while-revalidate=600",
    );
  });

  it("timeout: 504 con code y sin caché", async () => {
    vi.useFakeTimers();
    stubTwitch({ videos: (init) => hang(init) });
    const { res, state } = mockRes();

    const done = latestVideoHandler(req(), res);
    await vi.advanceTimersByTimeAsync(8_000);
    await done;

    expect(state.status).toBe(504);
    expect(state.body).toEqual({
      error: "No se pudo obtener el último stream de Twitch",
      code: "provider_timeout",
    });
    expect(state.headers["Cache-Control"]).toBeUndefined();
  });

  it("429: 429 con code y Retry-After; 5xx: 502 sin code; ambos sin caché", async () => {
    stubTwitch({ videos: () => json({}, 429, { "Retry-After": "40" }) });
    let out = mockRes();
    await latestVideoHandler(req(), out.res);
    expect(out.state.status).toBe(429);
    expect(out.state.headers["Retry-After"]).toBe("40");
    expect(out.state.headers["Cache-Control"]).toBeUndefined();

    stubTwitch({ videos: () => json({}, 500) });
    out = mockRes();
    await latestVideoHandler(req(), out.res);
    expect(out.state.status).toBe(502);
    expect(out.state.body).toEqual({
      error: "No se pudo obtener el último stream de Twitch",
    });
    expect(out.state.headers["Cache-Control"]).toBeUndefined();
  });

  it("respuesta malformada: 502 genérico", async () => {
    stubTwitch({ videos: () => new Response("<html>oops</html>", { status: 200 }) });
    const { res, state } = mockRes();

    await latestVideoHandler(req(), res);

    expect(state.status).toBe(502);
    expect(state.body).toEqual({
      error: "No se pudo obtener el último stream de Twitch",
    });
  });

  it("401 de Helix: refresca el token y reintenta una vez", async () => {
    let call = 0;
    const stub = stubTwitch({
      videos: () => (++call === 1 ? json({}, 401) : json({ data: [video] })),
    });
    const { res, state } = mockRes();

    await latestVideoHandler(req(), res);

    expect(state.status).toBe(200);
    expect(stub.oauthCalls).toBe(2);
  });
});

describe("estado en vivo: caso vacío válido", () => {
  it("sin stream: isLive false con su Cache-Control (no es un error)", async () => {
    stubTwitch({ streams: () => json({ data: [] }) });
    const { res, state } = mockRes();

    await statusHandler(req(), res);

    expect(state.status).toBe(200);
    expect(state.body).toEqual({ isLive: false, channel: "upminaa" });
    expect(state.headers["Cache-Control"]).toBe("s-maxage=30, stale-while-revalidate=60");
  });
});

describe("saneado de los logs de Twitch", () => {
  it("el texto del proveedor no puede inyectar líneas, URLs, credenciales ni volumen", async () => {
    const hostile =
      "línea 1\n[twitch-status] FALSO log inyectado\r\n\u001b[31mrojo\u001b[0m " +
      `client_secret=${CREDS.TWITCH_CLIENT_SECRET} ` +
      `https://id.twitch.tv/oauth2/token?client_secret=${CREDS.TWITCH_CLIENT_SECRET} ` +
      `Bearer abcdefghijklmnopqrstuvwxyz0123456789 ${CREDS.TWITCH_CLIENT_ID} ` +
      "A".repeat(5_000);
    stubTwitch({ streams: () => json({ message: hostile }, 500) });
    const { res, state } = mockRes();

    await statusHandler(req(), res);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0][0]);
    // Una sola línea física, sin caracteres de control y acotada.
    expect(
      [...line].some(
        (char) =>
          (char.codePointAt(0) ?? 0) < 0x20 ||
          ((char.codePointAt(0) ?? 0) >= 0x7f && (char.codePointAt(0) ?? 0) <= 0x9f),
      ),
    ).toBe(false);
    expect(line.length).toBeLessThan(300);
    expect(line.startsWith("[twitch-status] ")).toBe(true);
    // Sin credenciales, sin URLs, sin token de portador.
    expect(line).not.toContain(CREDS.TWITCH_CLIENT_SECRET);
    expect(line).not.toContain(CREDS.TWITCH_CLIENT_ID);
    expect(line).not.toContain("https://");
    expect(line).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(line).not.toContain("AAAAAAAAAA");
    // Y conserva algo de diagnóstico.
    expect(line).toContain("Twitch streams");
    // Nada del proveedor llega al cliente.
    expect(JSON.stringify(state.body)).not.toContain("FALSO");
    expect(state.body).toEqual({ error: "No se pudo obtener el estado de Twitch" });
  });

  it("el error del token no filtra los secretos configurados", async () => {
    stubTwitch({
      oauth: () =>
        json(
          {
            message: `invalid client ${CREDS.TWITCH_CLIENT_SECRET} for ${CREDS.TWITCH_CLIENT_ID}`,
          },
          400,
        ),
    });
    const { res } = mockRes();

    await statusHandler(req(), res);

    expect(logged()).toContain("Twitch OAuth");
    expect(logged()).not.toContain(CREDS.TWITCH_CLIENT_SECRET);
    expect(logged()).not.toContain(CREDS.TWITCH_CLIENT_ID);
  });

  it("un fallo de red: el log no arrastra el error original, la URL ni un stack", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed https://id.twitch.tv/x?client_secret=zzz");
      }),
    );
    const { res } = mockRes();

    await statusHandler(req(), res);

    expect(logged()).not.toContain("client_secret=zzz");
    expect(logged()).not.toContain("https://");
    expect(logged()).not.toContain("at "); // sin stack
  });
});

describe("fetchTwitchHelix con plazo", () => {
  it("sin plazo, el comportamiento es el de siempre (timeout por petición)", async () => {
    vi.useFakeTimers();
    const stub = stubTwitch({ clips: (_n, init) => hang(init) });

    const promise = fetchTwitchHelix("clips?broadcaster_id=1");
    const assertion = expect(promise).rejects.toMatchObject({ kind: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;

    expect(stub.signals[0]?.aborted).toBe(true);
  });
});
