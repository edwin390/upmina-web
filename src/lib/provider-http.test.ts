import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelResponse } from "@vercel/node";
import {
  MAX_PROVIDER_TEXT_LENGTH,
  MAX_RETRY_AFTER_SECONDS,
  PROVIDER_REQUEST_TIMEOUT_MS,
  ProviderApiError,
  ProviderRequestError,
  classifyProviderStatus,
  createDeadline,
  fetchWithTimeout,
  parseRetryAfter,
  providerErrorFromResponse,
  readProviderJson,
  requestTimeoutWithin,
  sanitizeProviderText,
  sendProviderFailure,
} from "./provider-http";

// Primitivas de fiabilidad de las peticiones a proveedores (9H-1). Todo determinista: reloj
// falso, sin red ni esperas reales. Los valores sensibles son SINTÉTICOS.

const SECRET = "AIzaSy-clave-sintetica-de-prueba";
const URL_WITH_KEY = `https://provider.example/v1/things?id=1&key=${SECRET}`;

/** fetch que no responde nunca, pero respeta la señal de aborto como el real. */
function hangingFetch() {
  const seen: { signal?: AbortSignal } = {};
  const fn = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        seen.signal = init?.signal ?? undefined;
        const abort = () =>
          reject(new DOMException("The operation was aborted.", "AbortError"));
        // Como el fetch real: una señal ya abortada rechaza de inmediato.
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort);
      }),
  );
  return { fn, seen };
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

/** Espera un rechazo y devuelve el error (falla si la promesa se resuelve). */
async function rejection<T = ProviderRequestError>(
  promise: Promise<unknown>,
): Promise<T> {
  try {
    await promise;
  } catch (err) {
    return err as T;
  }
  throw new Error("se esperaba un rechazo");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchWithTimeout", () => {
  it("éxito: devuelve una Response completa y no deja temporizadores", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 })),
    );

    const response = await fetchWithTimeout("Prov op", URL_WITH_KEY);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propaga el status no exitoso y sus cabeceras sin lanzar (lo decide el adaptador)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("{}", { status: 429, headers: { "Retry-After": "30" } }),
      ),
    );

    const response = await fetchWithTimeout("Prov op", URL_WITH_KEY);

    expect(response.ok).toBe(false);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
  });

  it("status sin cuerpo (204) no rompe la reconstrucción de la Response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );

    const response = await fetchWithTimeout("Prov op", URL_WITH_KEY);

    expect(response.status).toBe(204);
  });

  it("timeout: ABORTA la petición y lanza TIMEOUT (504) sin URL ni secretos", async () => {
    const { fn, seen } = hangingFetch();
    vi.stubGlobal("fetch", fn);

    const promise = fetchWithTimeout("Prov op", URL_WITH_KEY, {}, 8_000);
    const assertion = expect(promise).rejects.toMatchObject({
      name: "ProviderRequestError",
      kind: "TIMEOUT",
      status: 504,
      code: "provider_timeout",
    });
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;

    expect(seen.signal?.aborted).toBe(true);
    const error = await rejection<Error>(promise);
    expect(error.message).toBe("Prov op: tiempo de espera agotado (8 s)");
    expect(error.message).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("no vence antes de tiempo", async () => {
    const { fn, seen } = hangingFetch();
    vi.stubGlobal("fetch", fn);

    const promise = fetchWithTimeout("Prov op", URL_WITH_KEY, {}, 8_000);
    promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(7_999);

    expect(seen.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.signal?.aborted).toBe(true);
  });

  it("usa PROVIDER_REQUEST_TIMEOUT_MS por defecto", async () => {
    const { fn, seen } = hangingFetch();
    vi.stubGlobal("fetch", fn);

    const promise = fetchWithTimeout("Prov op", URL_WITH_KEY);
    promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(PROVIDER_REQUEST_TIMEOUT_MS - 1);
    expect(seen.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.signal?.aborted).toBe(true);
  });

  it("timeout durante la LECTURA del cuerpo también es TIMEOUT", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => ({
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () =>
          new Promise<string>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      })),
    );

    const promise = fetchWithTimeout("Prov op", URL_WITH_KEY, {}, 5_000);
    const assertion = expect(promise).rejects.toMatchObject({ kind: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fallo de red: NETWORK_ERROR sin filtrar el error original ni la URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        throw new TypeError(`fetch failed for ${url}`);
      }),
    );

    const error = await rejection(fetchWithTimeout("Prov op", URL_WITH_KEY));

    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error.kind).toBe("NETWORK_ERROR");
    expect(error.status).toBe(502);
    expect(error.code).toBeUndefined();
    expect(error.message).toBe("Prov op: error de red");
    expect(String(error)).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("señal del llamador ya abortada: se propaga SU error, no un timeout ni un error de red", async () => {
    const { fn } = hangingFetch();
    vi.stubGlobal("fetch", fn);
    const outer = new AbortController();
    const reason = new Error("cancelado por el llamador");
    outer.abort(reason);

    await expect(
      fetchWithTimeout("Prov op", URL_WITH_KEY, { signal: outer.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborto del llamador durante la petición: cancela y no se clasifica como timeout", async () => {
    const { fn, seen } = hangingFetch();
    vi.stubGlobal("fetch", fn);
    const outer = new AbortController();

    const promise = fetchWithTimeout("Prov op", URL_WITH_KEY, { signal: outer.signal });
    const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    outer.abort();
    await assertion;

    expect(seen.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cierre limpio: abortar la señal del llamador DESPUÉS del éxito no tiene efecto", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const outer = new AbortController();

    const response = await fetchWithTimeout("Prov op", URL_WITH_KEY, {
      signal: outer.signal,
    });
    outer.abort();

    expect(response.status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("classifyProviderStatus", () => {
  it.each([
    [429, "RATE_LIMITED"],
    [500, "UPSTREAM_UNAVAILABLE"],
    [502, "UPSTREAM_UNAVAILABLE"],
    [503, "UPSTREAM_UNAVAILABLE"],
    [504, "UPSTREAM_UNAVAILABLE"],
    [400, "UPSTREAM_REJECTED"],
    [401, "UPSTREAM_REJECTED"],
    [403, "UPSTREAM_REJECTED"],
    [404, "UPSTREAM_REJECTED"],
  ])("%i → %s", (status, kind) => {
    expect(classifyProviderStatus(status)).toBe(kind);
  });
});

describe("parseRetryAfter", () => {
  const NOW = Date.parse("2026-09-26T12:00:00Z");

  it.each([
    ["120", 120],
    ["0", 0],
    ["  30  ", 30],
    [String(MAX_RETRY_AFTER_SECONDS), MAX_RETRY_AFTER_SECONDS],
  ])("delta-segundos válido %j → %j", (value, expected) => {
    expect(parseRetryAfter(value, NOW)).toBe(expected);
  });

  it("HTTP-date futura → segundos restantes (redondeo hacia arriba)", () => {
    expect(parseRetryAfter("Sat, 26 Sep 2026 12:01:30 GMT", NOW)).toBe(90);
    expect(parseRetryAfter("Sat, 26 Sep 2026 12:00:00 GMT", NOW)).toBe(0);
    expect(parseRetryAfter("Sat, 26 Sep 2026 12:00:00 GMT", NOW - 500)).toBe(1);
  });

  it.each([
    ["ausente", undefined],
    ["null", null],
    ["vacío", ""],
    ["solo espacios", "   "],
    ["negativo", "-5"],
    ["decimal", "1.5"],
    ["notación científica", "1e3"],
    ["texto", "abc"],
    ["Infinity", "Infinity"],
    ["NaN", "NaN"],
    ["más allá del tope", String(MAX_RETRY_AFTER_SECONDS + 1)],
    ["enorme", "99999999999"],
    ["fecha en texto libre (Date.parse la aceptaría)", "Sep 26 2026 12:05:00"],
    ["ISO 8601 (no es HTTP-date)", "2026-09-26T12:05:00Z"],
    ["HTTP-date ya pasada", "Sat, 26 Sep 2026 11:00:00 GMT"],
    ["HTTP-date más allá del tope", "Sat, 26 Sep 2026 14:00:00 GMT"],
    ["HTTP-date lejana", "Mon, 01 Jan 2035 00:00:00 GMT"],
    ["HTTP-date inexistente", "Sat, 99 Zzz 2026 99:99:99 GMT"],
  ])("rechaza %s", (_name, value) => {
    expect(parseRetryAfter(value as string | null | undefined, NOW)).toBeUndefined();
  });

  it("reloj no finito falla cerrado con HTTP-date", () => {
    expect(parseRetryAfter("Sat, 26 Sep 2026 12:01:30 GMT", Number.NaN)).toBeUndefined();
  });
});

describe("providerErrorFromResponse", () => {
  const res = (status: number, headers: Record<string, string> = {}) =>
    new Response("{}", { status, headers });

  it("429: RATE_LIMITED, 429 público, code estable y Retry-After válido", () => {
    const err = providerErrorFromResponse(
      res(429, { "Retry-After": "45" }),
      "Prov: HTTP 429",
    );

    expect(err).toBeInstanceOf(ProviderRequestError);
    expect(err.kind).toBe("RATE_LIMITED");
    expect(err.status).toBe(429);
    expect(err.code).toBe("provider_rate_limited");
    expect(err.httpStatus).toBe(429);
    expect(err.retryAfterSeconds).toBe(45);
  });

  it("429 con Retry-After malformado o desmesurado: sin retryAfterSeconds", () => {
    expect(
      providerErrorFromResponse(res(429, { "Retry-After": "soon" }), "x")
        .retryAfterSeconds,
    ).toBeUndefined();
    expect(
      providerErrorFromResponse(res(429, { "Retry-After": "999999" }), "x")
        .retryAfterSeconds,
    ).toBeUndefined();
    expect(providerErrorFromResponse(res(429), "x").retryAfterSeconds).toBeUndefined();
  });

  it.each([500, 502, 503])(
    "%i: UPSTREAM_UNAVAILABLE, 502 público, sin code",
    (status) => {
      const err = providerErrorFromResponse(res(status, { "Retry-After": "10" }), "x");

      expect(err.kind).toBe("UPSTREAM_UNAVAILABLE");
      expect(err.status).toBe(502);
      expect(err.code).toBeUndefined();
      // Retry-After solo se interpreta en un 429.
      expect(err.retryAfterSeconds).toBeUndefined();
    },
  );

  it.each([400, 401, 403, 404])(
    "%i: UPSTREAM_REJECTED, 502 público, sin code",
    (status) => {
      const err = providerErrorFromResponse(res(status), "x");

      expect(err.kind).toBe("UPSTREAM_REJECTED");
      expect(err.status).toBe(502);
      expect(err.code).toBeUndefined();
      expect(err.httpStatus).toBe(status);
    },
  );
});

describe("readProviderJson", () => {
  it("JSON válido", async () => {
    expect(
      await readProviderJson<{ a: number }>(new Response('{"a":1}'), "Prov op"),
    ).toEqual({
      a: 1,
    });
  });

  it("cuerpo ilegible: INVALID_RESPONSE (502) y el cuerpo no aparece en el error", async () => {
    const error = await rejection(
      readProviderJson(new Response(`<html>Bad Gateway ${SECRET}</html>`), "Prov op"),
    );

    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error.kind).toBe("INVALID_RESPONSE");
    expect(error.status).toBe(502);
    expect(error.message).toBe("Prov op: respuesta no válida");
    expect(error.message).not.toContain(SECRET);
  });
});

describe("sendProviderFailure", () => {
  it("429 con Retry-After válido: 429, code y cabecera", () => {
    const { res, state } = mockRes();
    const err = new ProviderRequestError("RATE_LIMITED", "x", { retryAfterSeconds: 30 });

    sendProviderFailure(res, err, "Mensaje público");

    expect(state.status).toBe(429);
    expect(state.body).toEqual({
      error: "Mensaje público",
      code: "provider_rate_limited",
    });
    expect(state.headers["Retry-After"]).toBe("30");
  });

  it("429 sin Retry-After válido: no inventa la cabecera", () => {
    const { res, state } = mockRes();

    sendProviderFailure(res, new ProviderRequestError("RATE_LIMITED", "x"), "Mensaje");

    expect(state.status).toBe(429);
    expect(state.headers["Retry-After"]).toBeUndefined();
  });

  it("timeout: 504 con code", () => {
    const { res, state } = mockRes();

    sendProviderFailure(res, new ProviderRequestError("TIMEOUT", "x"), "Mensaje");

    expect(state.status).toBe(504);
    expect(state.body).toEqual({ error: "Mensaje", code: "provider_timeout" });
  });

  it.each([
    "UPSTREAM_UNAVAILABLE",
    "UPSTREAM_REJECTED",
    "NETWORK_ERROR",
    "INVALID_RESPONSE",
  ] as const)("%s: 502 con el cuerpo de siempre (sin code)", (kind) => {
    const { res, state } = mockRes();

    sendProviderFailure(res, new ProviderRequestError(kind, "x"), "Mensaje");

    expect(state.status).toBe(502);
    expect(state.body).toEqual({ error: "Mensaje" });
    expect(state.headers["Retry-After"]).toBeUndefined();
  });

  it("ProviderApiError de configuración conserva su status (503) y no añade code", () => {
    const { res, state } = mockRes();

    sendProviderFailure(res, new ProviderApiError("Faltan credenciales", 503), "Mensaje");

    expect(state.status).toBe(503);
    expect(state.body).toEqual({ error: "Mensaje" });
  });

  it("error desconocido: 502 genérico, sin filtrar el mensaje ni secretos", () => {
    const { res, state } = mockRes();

    sendProviderFailure(res, new Error(`fallo con ${SECRET}`), "Mensaje");

    expect(state.status).toBe(502);
    expect(state.body).toEqual({ error: "Mensaje" });
    expect(JSON.stringify(state.body)).not.toContain(SECRET);
  });
});

describe("createDeadline / requestTimeoutWithin", () => {
  it("restante decreciente con reloj inyectado, sin bajar de 0", () => {
    let clock = 1_000;
    const deadline = createDeadline(5_000, () => clock);

    expect(deadline.remainingMs()).toBe(5_000);
    clock += 3_000;
    expect(deadline.remainingMs()).toBe(2_000);
    clock += 10_000;
    expect(deadline.remainingMs()).toBe(0);
  });

  it("usa el reloj global (falso en los tests) por defecto", () => {
    const deadline = createDeadline(5_000);

    vi.advanceTimersByTime(2_000);

    expect(deadline.remainingMs()).toBe(3_000);
  });

  it("sin plazo: el máximo por petición", () => {
    expect(requestTimeoutWithin("Prov op", undefined)).toBe(PROVIDER_REQUEST_TIMEOUT_MS);
    expect(requestTimeoutWithin("Prov op", undefined, 1_234)).toBe(1_234);
  });

  it("con plazo: el menor entre el máximo por petición y lo que queda", () => {
    let clock = 0;
    const deadline = createDeadline(10_000, () => clock);

    expect(requestTimeoutWithin("Prov op", deadline)).toBe(PROVIDER_REQUEST_TIMEOUT_MS);
    clock = 7_000;
    expect(requestTimeoutWithin("Prov op", deadline)).toBe(3_000);
    clock = 9_999;
    expect(requestTimeoutWithin("Prov op", deadline)).toBe(1);
  });

  it("plazo agotado: lanza TIMEOUT (504) ANTES de iniciar la petición", () => {
    let clock = 0;
    const deadline = createDeadline(1_000, () => clock);
    clock = 1_000;

    let error: unknown;
    try {
      requestTimeoutWithin("Prov op", deadline);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error).toMatchObject({
      kind: "TIMEOUT",
      status: 504,
      code: "provider_timeout",
    });
    expect((error as Error).message).toBe("Prov op: plazo total agotado");
  });
});

/** Independiente de la implementación: C0/C1 y separadores Unicode de línea. */
const hasControlCode = (code: number) =>
  code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;

describe("sanitizeProviderText", () => {
  it("texto normal: intacto", () => {
    expect(sanitizeProviderText("Invalid OAuth token")).toBe("Invalid OAuth token");
  });

  it.each([
    ["saltos de línea", "a\nb\r\nc", "a b c"],
    ["escape ANSI", "\u001b[31mrojo\u001b[0m", "[31mrojo [0m"],
    ["NUL y DEL", "a\u0000b\u007fc", "a b c"],
    ["separadores Unicode de línea", "a\u2028b\u2029c", "a b c"],
    ["tabuladores", "a\tb", "a b"],
  ])("sin caracteres de control (%s)", (_name, input, expected) => {
    const out = sanitizeProviderText(input);

    expect(out).toBe(expected);
    expect([...out].some((char) => hasControlCode(char.codePointAt(0) ?? 0))).toBe(false);
  });

  it("acota la longitud (con elipsis) y respeta un máximo propio", () => {
    const out = sanitizeProviderText("palabra ".repeat(1_000));

    expect(out.length).toBeLessThanOrEqual(MAX_PROVIDER_TEXT_LENGTH);
    expect(out.endsWith("…")).toBe(true);
    expect(sanitizeProviderText("abcdefghij", { maxLength: 5 })).toBe("abcd…");
  });

  it("un texto enorme se procesa rápido y sigue acotado", () => {
    const start = Date.now();
    const out = sanitizeProviderText("x ".repeat(5_000_000));

    expect(out.length).toBeLessThanOrEqual(MAX_PROVIDER_TEXT_LENGTH);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("URLs fuera", () => {
    const out = sanitizeProviderText(
      "fallo en https://api.example/v1?key=SECRETO&x=1 y http://a.b/c",
    );

    expect(out).toBe("fallo en [url] y [url]");
  });

  it.each([
    ["Bearer", "auth Bearer abcDEF123.456_789-xyz fin"],
    ["par credencial=valor", "client_secret=abc123 fin"],
    ["par con dos puntos", "access_token: abc123 fin"],
    ["api_key", "api_key=AIza123 fin"],
    ["password", "password=hunter2 fin"],
  ])("credenciales fuera (%s)", (_name, input) => {
    const out = sanitizeProviderText(input);

    expect(out).not.toMatch(/abc123|abcDEF|AIza123|hunter2/);
    expect(out).toContain("fin");
  });

  it("cadenas opacas largas (tokens/JWT) fuera", () => {
    // Sintética: no es un token real ni tiene forma de JWT válido.
    const opaque = `${"Zm9vYmFy".repeat(6)}.${"cXV4".repeat(8)}`;
    const out = sanitizeProviderText(`token recibido ${opaque} ok`);

    expect(out).not.toContain("Zm9vYmFy");
    expect(out).toContain("ok");
  });

  it("los secretos exactos indicados se eliminan aunque no tengan formato reconocible", () => {
    const out = sanitizeProviderText("cliente mi-secreto-raro rechazado", {
      secrets: ["mi-secreto-raro"],
    });

    expect(out).toBe("cliente [redacted] rechazado");
  });

  it("un secreto demasiado corto (< 6) no se usa como patrón para no destrozar el texto", () => {
    expect(sanitizeProviderText("abc def", { secrets: ["abc", ""] })).toBe("abc def");
  });

  it.each([undefined, null, 42, {}, [], true])(
    "entrada no textual (%j) → cadena vacía",
    (v) => {
      expect(sanitizeProviderText(v)).toBe("");
    },
  );

  it("conserva el diagnóstico útil (no borra todo)", () => {
    expect(sanitizeProviderText("Twitch OAuth: invalid client")).toBe(
      "Twitch OAuth: invalid client",
    );
  });
});
