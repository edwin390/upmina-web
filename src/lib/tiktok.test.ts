import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
// Los 3 endpoints de TikTok los atiende ahora una única Serverless Function
// (api/tiktok/[resource].ts, ver vercel.json) por el límite de 12 funciones del plan
// Hobby de Vercel; la lógica de /api/tiktok-callback no cambió, solo
// se movió a exports nombrados en src/lib/tiktok-handlers.ts. Se renombran en el import
// para no tocar el resto del archivo (mismos nombres locales que ya usaban los tests).
import { handleTikTokCallback as callbackHandler } from "./tiktok-handlers";
import { flowFake, resetFlowFake } from "./social-flow-supabase-fake";
import {
  SOCIAL_OAUTH_FLOW_TTL_MS,
  claimSocialOAuthFlow,
  createSocialOAuthFlow,
} from "./social-oauth-flow";
import {
  TIKTOK_REDIRECT_URI,
  TIKTOK_STATE_COOKIE,
  TIKTOK_STATE_TTL_MS,
  createTikTokState,
  verifyTikTokState,
} from "./tiktok-shared";

// Fijan el flujo OAuth de TikTok (inicio, callback, intercambio de tokens, guardado en
// Supabase) y que ningún secreto/token salga en respuestas, redirecciones ni logs.

// Cliente de Supabase simulado: el único punto de I/O de la persistencia de social_connections.
// social_oauth_flows y admin_roles (capability del callback, Bloque 8D) usan el fake compartido,
// con los módulos REALES encima.
const db = vi.hoisted(() => ({ upsert: vi.fn(), createClient: vi.fn() }));
vi.mock("@supabase/supabase-js", async () => {
  const { flowFake, flowTableFor } = await import("./social-flow-supabase-fake");
  return {
    createClient: (...args: unknown[]) => {
      db.createClient(...args);
      return {
        from: (table: string) =>
          flowTableFor(table) ?? {
            upsert: (row: unknown, options: unknown) => {
              flowFake.events.push("persist");
              return db.upsert(table, row, options);
            },
          },
      };
    },
  };
});

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

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";

/** Simula un inicio autorizado (POST /api/admin/social-connect): state + cookie + flujo real. */
async function startFlow(now?: number, admin = ADMIN_ID) {
  const { state, nonce } = createTikTokState(CLIENT_SECRET, now);
  await createSocialOAuthFlow("tiktok", nonce, admin, now);
  // Crear el flujo es parte del inicio, no del callback: no cuenta como cliente del callback.
  db.createClient.mockClear();
  return { stateParam: state, cookie: `${TIKTOK_STATE_COOKIE}=${nonce}`, nonce };
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
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("TIKTOK_CLIENT_KEY", CLIENT_KEY);
  vi.stubEnv("TIKTOK_CLIENT_SECRET", CLIENT_SECRET);
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  db.upsert.mockReset().mockResolvedValue({ error: null });
  db.createClient.mockReset();
  resetFlowFake();
  flowFake.roles[ADMIN_ID] = "admin";
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
      // Cada intento necesita su propio inicio autorizado: el flujo se consume al reclamarlo.
      const { stateParam, cookie } = await startFlow();
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

describe("api/tiktok-callback: capability server-side (Bloque 8D)", () => {
  const TTL = SOCIAL_OAUTH_FLOW_TTL_MS;
  const GENERIC_400 = "La solicitud de autorización no es válida o caducó";

  type Started = { stateParam: string; cookie: string; nonce: string };
  const callbackFor = (started: Pick<Started, "stateParam" | "cookie">) =>
    req({ code: CODE, state: started.stateParam }, { cookie: started.cookie });

  /** Fetch de TikTok que registra el intercambio en la cronología. */
  function exchangeFetch(onExchange?: () => void | Promise<void>) {
    return vi.fn(async () => {
      flowFake.events.push("exchange");
      await onExchange?.();
      return jsonResponse(tokenBody);
    });
  }

  function expectNoExchangeNoPersist(fetchMock: ReturnType<typeof vi.fn>) {
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
    expect(flowFake.events).not.toContain("exchange");
    expect(flowFake.events).not.toContain("persist");
  }

  it("fuera de Production → 403 ANTES de reclamar el flujo (sin claim, roles, exchange ni escritura)", async () => {
    const started = await startFlow();
    flowFake.events = [];
    const fetchMock = exchangeFetch();
    vi.stubGlobal("fetch", fetchMock);

    for (const env of ["preview", "development", ""]) {
      vi.stubEnv("VERCEL_ENV", env);
      const { res, state } = mockRes();
      await callbackHandler(callbackFor(started), res);
      expect(state.status).toBe(403);
      expect(String(state.body)).toContain("solo puede completarse en Production");
    }
    expect(flowFake.events).toEqual([]);
    expect(flowFake.flows.get("tiktok")?.consumed_at).toBeNull();
    expectNoExchangeNoPersist(fetchMock);
    expect(db.createClient).not.toHaveBeenCalled();
  });

  it("el guard de Production no rompe el routing: método incorrecto sigue dando 405 en cualquier entorno", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const { res, state } = mockRes();
    await callbackHandler(req({}, { method: "POST" }), res);
    expect(state.status).toBe(405);
  });

  it("state con firma inválida → 400 sin reclamar el flujo; el flujo sigue intacto", async () => {
    const started = await startFlow();
    const [n, expires] = started.stateParam.split(".");
    const fetchMock = exchangeFetch();
    vi.stubGlobal("fetch", fetchMock);
    flowFake.events = [];

    const { res, state } = mockRes();
    await callbackHandler(
      req(
        { code: CODE, state: `${n}.${expires}.firma-falsa` },
        { cookie: started.cookie },
      ),
      res,
    );

    expect(state.status).toBe(400);
    expect(flowFake.events).toEqual([]);
    expect(flowFake.flows.get("tiktok")?.consumed_at).toBeNull();
    expectNoExchangeNoPersist(fetchMock);
  });

  it("cookie ausente o distinta → 400 sin reclamar el flujo", async () => {
    const started = await startFlow();
    const fetchMock = exchangeFetch();
    vi.stubGlobal("fetch", fetchMock);
    flowFake.events = [];

    for (const cookie of [undefined, `${TIKTOK_STATE_COOKIE}=otro-nonce`]) {
      const { res, state } = mockRes();
      await callbackHandler(
        req({ code: CODE, state: started.stateParam }, { cookie }),
        res,
      );
      expect(state.status).toBe(400);
    }
    expect(flowFake.events).toEqual([]);
    expectNoExchangeNoPersist(fetchMock);
  });

  it("flujo inexistente (state y cookie válidos, sin inicio autorizado) → 400, sin exchange ni escritura", async () => {
    const { state: st, nonce } = createTikTokState(CLIENT_SECRET);
    const fetchMock = exchangeFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(
      req({ code: CODE, state: st }, { cookie: `${TIKTOK_STATE_COOKIE}=${nonce}` }),
      res,
    );

    expect(state.status).toBe(400);
    expect(String(state.body)).toContain(GENERIC_400);
    expect(flowFake.events).toEqual(["claim"]);
    expectNoExchangeNoPersist(fetchMock);
  });

  it("flujo expirado antes del claim → 400, sin exchange ni escritura", async () => {
    const { state: st, nonce } = createTikTokState(CLIENT_SECRET);
    await createSocialOAuthFlow("tiktok", nonce, ADMIN_ID, Date.now() - TTL - 1_000);
    const fetchMock = exchangeFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(
      req({ code: CODE, state: st }, { cookie: `${TIKTOK_STATE_COOKIE}=${nonce}` }),
      res,
    );

    expect(state.status).toBe(400);
    expect(flowFake.flows.get("tiktok")?.consumed_at).toBeNull();
    expectNoExchangeNoPersist(fetchMock);
  });

  it("flujo ya consumido → 400, sin exchange ni escritura", async () => {
    const started = await startFlow();
    await claimSocialOAuthFlow("tiktok", started.nonce);
    const fetchMock = exchangeFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(callbackFor(started), res);

    expect(state.status).toBe(400);
    expectNoExchangeNoPersist(fetchMock);
  });

  it("flujo reemplazado antes del claim (latest-wins) → 400 sin exchange, y NO consume el flujo nuevo", async () => {
    const a = await startFlow();
    const b = await startFlow();
    const fetchMock = exchangeFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(callbackFor(a), res);

    expect(state.status).toBe(400);
    expect(flowFake.flows.get("tiktok")?.consumed_at).toBeNull();
    expectNoExchangeNoPersist(fetchMock);

    const ok = mockRes();
    await callbackHandler(callbackFor(b), ok.res);
    expect(ok.state.status).toBe(200);
  });

  it("el admin que se comprueba es el del FLUJO (no uno fijo): otro ADMIN con rol → 200", async () => {
    const OTHER_ADMIN = "55555555-5555-4555-8555-555555555555";
    flowFake.roles = { [OTHER_ADMIN]: "admin" }; // ADMIN_ID ya no tiene rol
    const started = await startFlow(undefined, OTHER_ADMIN);
    vi.stubGlobal("fetch", exchangeFetch());

    const { res, state } = mockRes();
    await callbackHandler(callbackFor(started), res);

    expect(state.status).toBe(200);
    expect(db.upsert).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["admin revocado (sin rol)", undefined],
    ["degradado a MODERATOR", "moderator"],
  ])(
    "%s → 400 genérico, sin exchange ni escritura; el flujo queda consumido",
    async (_n, role) => {
      const started = await startFlow();
      flowFake.roles[ADMIN_ID] = role;
      const fetchMock = exchangeFetch();
      vi.stubGlobal("fetch", fetchMock);
      flowFake.events = [];

      const { res, state } = mockRes();
      await callbackHandler(callbackFor(started), res);

      expect(state.status).toBe(400);
      expect(String(state.body)).toContain(GENERIC_400);
      expect(flowFake.events).toEqual(["claim", "roles"]);
      expect(flowFake.flows.get("tiktok")?.consumed_at).not.toBeNull();
      expectNoExchangeNoPersist(fetchMock);
    },
  );

  it("error de base de datos al comprobar el rol → 500 fail-closed, sin exchange ni escritura", async () => {
    const started = await startFlow();
    flowFake.failOn.roles = { code: "57014", message: "detalle interno" };
    const fetchMock = exchangeFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(callbackFor(started), res);

    expect(state.status).toBe(500);
    expect(String(state.body)).not.toContain("detalle interno");
    expectNoExchangeNoPersist(fetchMock);
  });

  it("error de base de datos en el claim → 500 fail-closed, sin exchange ni escritura", async () => {
    const started = await startFlow();
    flowFake.failOn.claim = { code: "42501", message: "detalle interno" };
    const fetchMock = exchangeFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(callbackFor(started), res);

    expect(state.status).toBe(500);
    expectNoExchangeNoPersist(fetchMock);
  });

  it("si el intercambio falla tras el claim, el flujo queda consumido y un reintento no puede reclamarlo", async () => {
    const started = await startFlow();
    const failing = vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400));
    vi.stubGlobal("fetch", failing);

    const first = mockRes();
    await callbackHandler(callbackFor(started), first.res);
    expect(first.state.status).toBe(502);
    expect(db.upsert).not.toHaveBeenCalled();
    expect(flowFake.flows.get("tiktok")?.consumed_at).not.toBeNull();
    const callsAfterFirst = failing.mock.calls.length;

    const retry = mockRes();
    await callbackHandler(callbackFor(started), retry.res);
    expect(retry.state.status).toBe(400);
    expect(failing.mock.calls.length).toBe(callsAfterFirst);
  });

  it("callback repetido con éxito: el segundo intento no puede reclamar ni contactar a TikTok", async () => {
    const started = await startFlow();
    const fetchMock = exchangeFetch();
    vi.stubGlobal("fetch", fetchMock);

    const first = mockRes();
    await callbackHandler(callbackFor(started), first.res);
    expect(first.state.status).toBe(200);
    const calls = fetchMock.mock.calls.length;

    const second = mockRes();
    await callbackHandler(callbackFor(started), second.res);
    expect(second.state.status).toBe(400);
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(db.upsert).toHaveBeenCalledTimes(1);
  });

  it("dos callbacks concurrentes del mismo flujo: solo uno completa", async () => {
    const started = await startFlow();
    vi.stubGlobal("fetch", exchangeFetch());

    const a = mockRes();
    const b = mockRes();
    await Promise.all([
      callbackHandler(callbackFor(started), a.res),
      callbackHandler(callbackFor(started), b.res),
    ]);

    expect([a.state.status, b.state.status].sort()).toEqual([200, 400]);
    expect(db.upsert).toHaveBeenCalledTimes(1);
  });

  it("flujo reemplazado DURANTE el intercambio → current=false, no se persiste", async () => {
    const a = await startFlow();
    vi.stubGlobal(
      "fetch",
      exchangeFetch(async () => {
        await createSocialOAuthFlow("tiktok", "nonce-de-B-durante-el-exchange", ADMIN_ID);
      }),
    );

    const { res, state } = mockRes();
    await callbackHandler(callbackFor(a), res);

    expect(state.status).toBe(400);
    expect(String(state.body)).toContain(GENERIC_400);
    expect(db.upsert).not.toHaveBeenCalled();
    expect(flowFake.events).not.toContain("persist");
  });

  it("orquestación: claim → rol → exchange → current → persistencia, en ese orden", async () => {
    const started = await startFlow();
    flowFake.events = [];
    vi.stubGlobal("fetch", exchangeFetch());

    const { res, state } = mockRes();
    await callbackHandler(callbackFor(started), res);

    expect(state.status).toBe(200);
    expect(flowFake.events).toEqual(["claim", "roles", "exchange", "current", "persist"]);
  });

  it("cruzar el TTL DURANTE el intercambio no invalida el flujo ya reclamado (current no exige expires_at)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.UTC(2026, 8, 25, 12, 0, 0));
      const started = await startFlow();
      vi.stubGlobal(
        "fetch",
        exchangeFetch(() => {
          vi.setSystemTime(Date.now() + TTL + 60_000);
        }),
      );

      const { res, state } = mockRes();
      await callbackHandler(callbackFor(started), res);

      expect(state.status).toBe(200);
      expect(db.upsert).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("todos los rechazos de la capability tienen la MISMA respuesta pública y limpian la cookie", async () => {
    vi.stubGlobal("fetch", exchangeFetch());
    const pages: string[] = [];
    const results: MockState[] = [];

    const { state: st1, nonce: n1 } = createTikTokState(CLIENT_SECRET);
    const r1 = mockRes();
    await callbackHandler(
      req({ code: CODE, state: st1 }, { cookie: `${TIKTOK_STATE_COOKIE}=${n1}` }),
      r1.res,
    );
    results.push(r1.state);

    const s2 = await startFlow();
    await claimSocialOAuthFlow("tiktok", s2.nonce);
    const r2 = mockRes();
    await callbackHandler(callbackFor(s2), r2.res);
    results.push(r2.state);

    const s3 = await startFlow();
    await startFlow();
    const r3 = mockRes();
    await callbackHandler(callbackFor(s3), r3.res);
    results.push(r3.state);

    const s4 = await startFlow();
    flowFake.roles = {};
    const r4 = mockRes();
    await callbackHandler(callbackFor(s4), r4.res);
    results.push(r4.state);

    for (const r of results) {
      expect(r.status).toBe(400);
      pages.push(String(r.body));
      expect(r.headers["Set-Cookie"]).toContain("Max-Age=0");
    }
    expect(new Set(pages).size).toBe(1);
  });

  it("ni las respuestas ni los logs contienen nonce, state, id del admin ni el rol", async () => {
    const started = await startFlow();
    flowFake.roles = {};
    vi.stubGlobal("fetch", exchangeFetch());
    const { res, state } = mockRes();
    await callbackHandler(callbackFor(started), res);

    const wire = `${JSON.stringify(state)}${JSON.stringify(errorSpy.mock.calls)}`;
    for (const secret of [
      started.nonce,
      started.stateParam,
      ADMIN_ID,
      "moderator",
      "aal2",
    ]) {
      expect(wire).not.toContain(secret);
    }
  });
});
