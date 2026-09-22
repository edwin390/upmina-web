import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
// Los 3 endpoints de TikTok los atiende ahora una única Serverless Function
// (api/tiktok/[resource].ts, ver vercel.json) por el límite de 12 funciones del plan
// Hobby de Vercel; la lógica de /api/tiktok-auth y /api/tiktok-callback no cambió, solo
// se movió a exports nombrados en src/lib/tiktok-handlers.ts. Se renombran en el import
// para no tocar el resto del archivo (mismos nombres locales que ya usaban los tests).
import {
  handleTikTokAuth as authHandler,
  handleTikTokCallback as callbackHandler,
} from "./tiktok-handlers";
import {
  TIKTOK_REDIRECT_URI,
  TIKTOK_STATE_COOKIE,
  TIKTOK_STATE_TTL_MS,
  createTikTokState,
  readStateCookie,
  verifyTikTokState,
} from "./tiktok-shared";

// Fijan el flujo OAuth de TikTok (inicio, callback, intercambio de tokens, guardado en
// Supabase) y que ningún secreto/token salga en respuestas, redirecciones ni logs.

// Cliente de Supabase simulado: el único punto de I/O de la persistencia.
const db = vi.hoisted(() => ({ upsert: vi.fn(), createClient: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => {
    db.createClient(...args);
    return {
      from: (table: string) => ({
        upsert: (row: unknown, options: unknown) => db.upsert(table, row, options),
      }),
    };
  },
}));

const CLIENT_KEY = "ck-ficticio";
const CLIENT_SECRET = "cs-secreto-ficticio";
const CODE = "code-ficticio-de-un-solo-uso";
const ACCESS_TOKEN = "act.access-token-ficticio";
const REFRESH_TOKEN = "rft.refresh-token-ficticio";
const SUPABASE_URL = "https://proyecto-ficticio.supabase.co";
const SERVICE_ROLE_KEY = "srk-service-role-ficticia";
const SECRETS = [CLIENT_SECRET, CODE, ACCESS_TOKEN, REFRESH_TOKEN, SERVICE_ROLE_KEY];

interface MockState {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  redirectTo?: string;
}

function mockRes() {
  const state: MockState = { status: 200, headers: {}, body: undefined };
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
    send(body: unknown) {
      state.body = body;
      return res;
    },
    redirect(code: number, url: string) {
      state.status = code;
      state.redirectTo = url;
      return res;
    },
  };
  return { res: res as unknown as VercelResponse, state };
}

function req(
  query: Record<string, string> = {},
  { method = "GET", cookie }: { method?: string; cookie?: string } = {},
) {
  return { method, query, headers: cookie ? { cookie } : {} } as unknown as VercelRequest;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const tokenBody = {
  access_token: ACCESS_TOKEN,
  expires_in: 86400,
  open_id: "open-id-ficticio",
  refresh_expires_in: 31536000,
  refresh_token: REFRESH_TOKEN,
  scope: "user.info.basic,video.list",
  token_type: "Bearer",
};

/** Inicia el flujo y devuelve un state válido con su cookie, como haría el navegador. */
async function startFlow() {
  const { res, state } = mockRes();
  authHandler(req(), res);
  const setCookie = state.headers["Set-Cookie"];
  const authUrl = new URL(state.redirectTo!);
  return {
    stateParam: authUrl.searchParams.get("state")!,
    cookie: setCookie.split(";")[0],
  };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

function leaked(state: MockState) {
  const haystack = JSON.stringify([
    state.body,
    state.headers,
    state.redirectTo,
    errorSpy.mock.calls,
  ]);
  return SECRETS.some((s) => haystack.includes(s));
}

beforeEach(() => {
  vi.stubEnv("TIKTOK_CLIENT_KEY", CLIENT_KEY);
  vi.stubEnv("TIKTOK_CLIENT_SECRET", CLIENT_SECRET);
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  db.upsert.mockReset().mockResolvedValue({ error: null });
  db.createClient.mockReset();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("api/tiktok-auth", () => {
  it("302 a la URL oficial con client_key, solo los scopes previstos y el redirect exacto", () => {
    const { res, state } = mockRes();
    authHandler(req(), res);

    expect(state.status).toBe(302);
    const url = new URL(state.redirectTo!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://www.tiktok.com/v2/auth/authorize/",
    );
    expect(url.searchParams.get("client_key")).toBe(CLIENT_KEY);
    expect(url.searchParams.get("scope")).toBe("user.info.basic,video.list");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(TIKTOK_REDIRECT_URI);
    expect(TIKTOK_REDIRECT_URI).toBe("https://upmina-web.vercel.app/api/tiktok-callback");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(state.headers["Cache-Control"]).toBe("no-store");
  });

  it("no expone el Client Secret ni en la URL ni en las cabeceras", () => {
    const { res, state } = mockRes();
    authHandler(req(), res);
    expect(JSON.stringify([state.redirectTo, state.headers])).not.toContain(
      CLIENT_SECRET,
    );
    expect(new URL(state.redirectTo!).searchParams.has("client_secret")).toBe(false);
  });

  it("la cookie del state es HttpOnly, Secure, SameSite=Lax y limitada al callback", () => {
    const { res, state } = mockRes();
    authHandler(req(), res);
    const cookie = state.headers["Set-Cookie"];
    expect(cookie).toMatch(new RegExp(`^${TIKTOK_STATE_COOKIE}=[\\w-]+;`));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/api\/tiktok-callback/);
    expect(cookie).toMatch(/Max-Age=600/);
    // El nonce de la cookie es el primer tramo del state.
    const nonce = readStateCookie(cookie.split(";")[0]);
    expect(
      new URL(state.redirectTo!).searchParams.get("state")!.startsWith(`${nonce}.`),
    ).toBe(true);
  });

  it("cada inicio genera un state distinto", () => {
    const a = mockRes();
    const b = mockRes();
    authHandler(req(), a.res);
    authHandler(req(), b.res);
    expect(new URL(a.state.redirectTo!).searchParams.get("state")).not.toBe(
      new URL(b.state.redirectTo!).searchParams.get("state"),
    );
  });

  it("503 sin redirigir si falta TIKTOK_CLIENT_KEY o TIKTOK_CLIENT_SECRET", () => {
    for (const name of ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"]) {
      vi.stubEnv(name, "");
      const { res, state } = mockRes();
      authHandler(req(), res);
      expect(state.status).toBe(503);
      expect(state.redirectTo).toBeUndefined();
      expect(state.headers["Set-Cookie"]).toBeUndefined();
      expect(String(state.body)).not.toContain("TIKTOK_CLIENT");
      vi.stubEnv(name, name === "TIKTOK_CLIENT_KEY" ? CLIENT_KEY : CLIENT_SECRET);
    }
  });

  it("405 con métodos distintos de GET", () => {
    const { res, state } = mockRes();
    authHandler(req({}, { method: "POST" }), res);
    expect(state.status).toBe(405);
    expect(state.redirectTo).toBeUndefined();
  });
});

describe("state (anti-CSRF)", () => {
  const NOW = 1_800_000_000_000;

  it("es válido con su cookie, firma y vigencia", () => {
    const { state, nonce } = createTikTokState(CLIENT_SECRET, NOW);
    expect(verifyTikTokState(state, nonce, CLIENT_SECRET, NOW + 1000)).toBe(true);
  });

  it("es inválido si falta o no coincide la cookie (otro navegador / CSRF)", () => {
    const { state } = createTikTokState(CLIENT_SECRET, NOW);
    expect(verifyTikTokState(state, undefined, CLIENT_SECRET, NOW)).toBe(false);
    expect(verifyTikTokState(state, "otro-nonce", CLIENT_SECRET, NOW)).toBe(false);
  });

  it("es inválido si se manipula la firma, la caducidad o si usa otro secreto", () => {
    const { state, nonce } = createTikTokState(CLIENT_SECRET, NOW);
    const [n, exp, sig] = state.split(".");
    expect(verifyTikTokState(`${n}.${exp}.${sig}x`, nonce, CLIENT_SECRET, NOW)).toBe(
      false,
    );
    expect(
      verifyTikTokState(`${n}.${Number(exp) + 999999}.${sig}`, nonce, CLIENT_SECRET, NOW),
    ).toBe(false);
    expect(verifyTikTokState(state, nonce, "otro-secreto", NOW)).toBe(false);
  });

  it("caduca pasado su TTL", () => {
    const { state, nonce } = createTikTokState(CLIENT_SECRET, NOW);
    expect(
      verifyTikTokState(state, nonce, CLIENT_SECRET, NOW + TIKTOK_STATE_TTL_MS - 1),
    ).toBe(true);
    expect(
      verifyTikTokState(state, nonce, CLIENT_SECRET, NOW + TIKTOK_STATE_TTL_MS + 1),
    ).toBe(false);
  });

  it("rechaza valores mal formados o no string", () => {
    for (const bad of [undefined, "", "abc", "a.b", "a.b.c.d", 42, ["x"]]) {
      expect(verifyTikTokState(bad, "a", CLIENT_SECRET, NOW)).toBe(false);
    }
  });
});

describe("api/tiktok-callback: persistencia en Supabase", () => {
  it("guarda la conexión con cliente admin (service_role, sin sesión) y expiraciones absolutas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(tokenBody)),
    );
    const { stateParam, cookie } = await startFlow();

    const before = Date.now();
    const { res, state } = mockRes();
    await callbackHandler(req({ code: CODE, state: stateParam }, { cookie }), res);
    const after = Date.now();

    expect(state.status).toBe(200);
    expect(String(state.body)).toContain("la conexión quedó guardada");

    const [url, key, options] = db.createClient.mock.calls[0];
    expect(url).toBe(SUPABASE_URL);
    expect(key).toBe(SERVICE_ROLE_KEY);
    expect(options).toEqual({ auth: { persistSession: false, autoRefreshToken: false } });

    expect(db.upsert).toHaveBeenCalledTimes(1);
    const [table, row, upsertOptions] = db.upsert.mock.calls[0];
    expect(table).toBe("social_connections");
    expect(upsertOptions).toEqual({ onConflict: "provider" });
    expect(row).toMatchObject({
      provider: "tiktok",
      provider_user_id: "open-id-ficticio",
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      scope: "user.info.basic,video.list",
    });
    const accessExp = Date.parse(row.access_token_expires_at);
    const refreshExp = Date.parse(row.refresh_token_expires_at);
    expect(accessExp).toBeGreaterThanOrEqual(before + 86400 * 1000);
    expect(accessExp).toBeLessThanOrEqual(after + 86400 * 1000);
    expect(refreshExp).toBeGreaterThanOrEqual(before + 31536000 * 1000);
    expect(refreshExp).toBeLessThanOrEqual(after + 31536000 * 1000);

    // Los tokens se guardan, pero no salen en respuesta, cabeceras ni logs.
    expect(leaked(state)).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("si falla el guardado tras recibir los tokens: no declara éxito, 500 y sin filtrar nada", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(tokenBody)),
    );
    db.upsert.mockResolvedValue({
      error: {
        code: "42501",
        message: `permission denied; row: ${ACCESS_TOKEN} ${REFRESH_TOKEN}`,
        details: SERVICE_ROLE_KEY,
      },
    });
    const { stateParam, cookie } = await startFlow();

    const { res, state } = mockRes();
    await callbackHandler(req({ code: CODE, state: stateParam }, { cookie }), res);

    expect(state.status).toBe(500);
    expect(String(state.body)).toContain("no guardada");
    expect(String(state.body)).not.toContain("conexión quedó guardada");
    expect(state.headers["Set-Cookie"]).toMatch(/Max-Age=0/);
    expect(leaked(state)).toBe(false);
    // Solo se registra un mensaje genérico y el código saneado.
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toMatch(/42501/);
    expect(logged).not.toMatch(/permission denied/);
  });

  it("si Supabase lanza una excepción (red) tras los tokens → 500 sin filtrar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(tokenBody)),
    );
    db.upsert.mockRejectedValue(
      new TypeError(`fetch failed ${ACCESS_TOKEN} ${SERVICE_ROLE_KEY}`),
    );
    const { stateParam, cookie } = await startFlow();

    const { res, state } = mockRes();
    await callbackHandler(req({ code: CODE, state: stateParam }, { cookie }), res);

    expect(state.status).toBe(500);
    expect(leaked(state)).toBe(false);
  });

  it("sin configuración de Supabase → 503 ANTES de gastar el code en TikTok", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(tokenBody));
    vi.stubGlobal("fetch", fetchMock);
    const { stateParam, cookie } = await startFlow();

    for (const name of ["VITE_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
      vi.stubEnv(name, "");
      const { res, state } = mockRes();
      await callbackHandler(req({ code: CODE, state: stateParam }, { cookie }), res);
      expect(state.status).toBe(503);
      expect(String(state.body)).not.toMatch(/SUPABASE|VITE_/);
      expect(leaked(state)).toBe(false);
      vi.stubEnv(name, name === "VITE_SUPABASE_URL" ? SUPABASE_URL : SERVICE_ROLE_KEY);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("si TikTok rechaza el intercambio no se escribe nada en Supabase", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400)),
    );
    const { stateParam, cookie } = await startFlow();

    const { res, state } = mockRes();
    await callbackHandler(req({ code: CODE, state: stateParam }, { cookie }), res);

    expect(state.status).toBe(502);
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("con state inválido no se contacta ni con TikTok ni con Supabase", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(req({ code: CODE, state: "a.b.c" }, { cookie: "x=1" }), res);

    expect(state.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
    expect(db.createClient).not.toHaveBeenCalled();
  });
});

describe("api/tiktok-callback", () => {
  it("200 con intercambio correcto: envía code + secret solo a TikTok y no muestra tokens", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(tokenBody));
    vi.stubGlobal("fetch", fetchMock);
    const { stateParam, cookie } = await startFlow();

    const { res, state } = mockRes();
    await callbackHandler(req({ code: CODE, state: stateParam }, { cookie }), res);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://open.tiktokapis.com/v2/oauth/token/");
    expect(init.method).toBe("POST");
    const form = new URLSearchParams(init.body as URLSearchParams);
    expect(Object.fromEntries(form)).toEqual({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      code: CODE,
      grant_type: "authorization_code",
      redirect_uri: TIKTOK_REDIRECT_URI,
    });

    expect(state.status).toBe(200);
    expect(String(state.body)).toContain("Autorización completada");
    expect(state.headers["Content-Type"]).toMatch(/text\/html/);
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(state.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(state.headers["Set-Cookie"]).toMatch(/Max-Age=0/);
    expect(leaked(state)).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("400 sin code: no llama a TikTok", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { stateParam, cookie } = await startFlow();

    const { res, state } = mockRes();
    await callbackHandler(req({ state: stateParam }, { cookie }), res);

    expect(state.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(leaked(state)).toBe(false);
  });

  it("400 con state ausente, manipulado o sin cookie: no llama a TikTok", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { stateParam, cookie } = await startFlow();

    const cases: [Record<string, string>, string | undefined][] = [
      [{ code: CODE }, cookie],
      [{ code: CODE, state: `${stateParam}x` }, cookie],
      [{ code: CODE, state: stateParam }, undefined],
      [{ code: CODE, state: stateParam }, `${TIKTOK_STATE_COOKIE}=otro`],
    ];
    for (const [query, ck] of cases) {
      const { res, state } = mockRes();
      await callbackHandler(req(query, { cookie: ck }), res);
      expect(state.status).toBe(400);
      expect(leaked(state)).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("?error= (usuario cancela) → 400 genérico sin llamar a TikTok ni reflejar el valor", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(
      req({ error: "access_denied", error_description: "<script>alert(1)</script>" }),
      res,
    );

    expect(state.status).toBe(400);
    expect(String(state.body)).not.toMatch(/access_denied|script/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("?error= con contenido raro no se vuelca a los logs", async () => {
    const { res } = mockRes();
    await callbackHandler(req({ error: "x\nFAKE LOG ENTRY <b>" }), res);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("FAKE LOG");
  });

  it("TikTok rechaza el intercambio (HTTP 400 invalid_grant) → 502 genérico y sin secretos", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: "invalid_grant",
            error_description: `Authorization code ${CODE} is expired`,
            log_id: "abc",
          },
          400,
        ),
      ),
    );
    const { stateParam, cookie } = await startFlow();

    const { res, state } = mockRes();
    await callbackHandler(req({ code: CODE, state: stateParam }, { cookie }), res);

    expect(state.status).toBe(502);
    expect(String(state.body)).toContain("No se pudo completar la autorización");
    expect(leaked(state)).toBe(false);
    // Se registra el código del proveedor y el status, nada más.
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/invalid_grant/);
    expect(errorSpy.mock.calls.flat().join(" ")).not.toMatch(/expired/);
  });

  it("TikTok responde 200 con `error` en el cuerpo → 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "invalid_request" })),
    );
    const { stateParam, cookie } = await startFlow();

    const { res, state } = mockRes();
    await callbackHandler(req({ code: CODE, state: stateParam }, { cookie }), res);
    expect(state.status).toBe(502);
    expect(leaked(state)).toBe(false);
  });

  it("respuesta de tokens incompleta o no JSON → 502 sin filtrar lo recibido", async () => {
    const { stateParam, cookie } = await startFlow();
    const { refresh_token: _drop, ...incomplete } = tokenBody;
    void _drop;

    for (const response of [
      () => jsonResponse(incomplete),
      () => jsonResponse({}),
      () => new Response("<html>gateway</html>", { status: 200 }),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response()),
      );
      const { res, state } = mockRes();
      await callbackHandler(req({ code: CODE, state: stateParam }, { cookie }), res);
      expect(state.status).toBe(502);
      expect(leaked(state)).toBe(false);
    }
  });

  it("fallo de red (con secretos en el mensaje) → 502 genérico sin filtrarlos", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(`fetch failed client_secret=${CLIENT_SECRET}&code=${CODE}`);
      }),
    );
    const { stateParam, cookie } = await startFlow();

    const { res, state } = mockRes();
    await callbackHandler(req({ code: CODE, state: stateParam }, { cookie }), res);
    expect(state.status).toBe(502);
    expect(leaked(state)).toBe(false);
  });

  it("503 sin llamar a TikTok si faltan las credenciales de la app", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const name of ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"]) {
      vi.stubEnv(name, "");
      const { res, state } = mockRes();
      await callbackHandler(req({ code: CODE, state: "a.b.c" }, { cookie: "x=1" }), res);
      expect(state.status).toBe(503);
      expect(String(state.body)).not.toContain("TIKTOK_CLIENT");
      vi.stubEnv(name, name === "TIKTOK_CLIENT_KEY" ? CLIENT_KEY : CLIENT_SECRET);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("405 con métodos distintos de GET", async () => {
    const { res, state } = mockRes();
    await callbackHandler(req({}, { method: "POST" }), res);
    expect(state.status).toBe(405);
  });

  it("el code y los tokens nunca aparecen en URL final, HTML ni logs (flujo completo)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(tokenBody)),
    );
    const { stateParam, cookie } = await startFlow();

    const { res, state } = mockRes();
    await callbackHandler(req({ code: CODE, state: stateParam }, { cookie }), res);

    expect(state.redirectTo).toBeUndefined();
    expect(leaked(state)).toBe(false);
  });
});
