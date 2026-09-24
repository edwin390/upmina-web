import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createInstagramState } from "./instagram-oauth-shared";
import { igFakeDb, resetIgFakeDb } from "./instagram-supabase-fake";
import { flowFake, resetFlowFake } from "./social-flow-supabase-fake";
import {
  SOCIAL_OAUTH_FLOW_TTL_MS,
  claimSocialOAuthFlow,
  createSocialOAuthFlow,
} from "./social-oauth-flow";

// Fijan el contrato del callback del OAuth de Instagram (el inicio ya no es público: ver
// social-connect-handlers.test.ts): validación de state, intercambio de tokens, persistencia. Usa el
// mismo estilo que twitch-handlers.test.ts (importa el handler real de api/, con
// req/res de prueba) y el fake de Supabase ya usado por instagram-connection.test.ts.

// social_connections usa el fake de Instagram; social_oauth_flows y admin_roles (capability del
// callback, Bloque 8D) usan el fake compartido, con los módulos REALES encima.
vi.mock("@supabase/supabase-js", async () => {
  const { fakeInstagramCreateClient } = await import("./instagram-supabase-fake");
  const { flowFake, flowTableFor } = await import("./social-flow-supabase-fake");
  return {
    createClient: (...args: unknown[]) => {
      const base = fakeInstagramCreateClient(...args);
      return {
        ...base,
        from: (table: string) => {
          const flowTable = flowTableFor(table);
          if (flowTable) return flowTable;
          const real = base.from(table);
          if (table !== "social_connections") return real;
          return {
            ...real,
            upsert: (...upsertArgs: Parameters<typeof real.upsert>) => {
              flowFake.events.push("persist");
              return real.upsert(...upsertArgs);
            },
          };
        },
      };
    },
  };
});

const callbackHandler = (await import("../../api/instagram-callback")).default;

const APP_ID = "1234567890";
const APP_SECRET = "secreto-de-app-ficticio";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockRes() {
  const state: {
    status?: number;
    body?: unknown;
    html?: string;
    headers: Record<string, string>;
    redirectStatus?: number;
    redirectedTo?: string;
  } = { headers: {} };
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
    send(body: string) {
      state.html = body;
      return res;
    },
    redirect(code: number, url: string) {
      state.redirectStatus = code;
      state.redirectedTo = url;
      return res;
    },
    end() {
      return res;
    },
  };
  return { res: res as unknown as VercelResponse, state };
}

function req(
  overrides: Partial<{
    method: string;
    query: Record<string, string>;
    headers: Record<string, string>;
  }> = {},
) {
  return {
    method: overrides.method ?? "GET",
    query: overrides.query ?? {},
    headers: overrides.headers ?? {},
  } as unknown as VercelRequest;
}

/** Fetch que resuelve las dos llamadas a Meta del callback con respuestas válidas por defecto. */
function stubMetaFlow(
  overrides: {
    shortLived?: unknown;
    shortLivedStatus?: number;
    longLived?: unknown;
    longLivedStatus?: number;
    onExchange?: () => void | Promise<void>;
  } = {},
) {
  return vi.fn(async (url: string) => {
    flowFake.events.push("exchange");
    await overrides.onExchange?.();
    if (url.includes("api.instagram.com/oauth/access_token")) {
      return jsonResponse(
        overrides.shortLived ?? {
          data: [
            {
              access_token: "IGAAshort-lived-ficticio",
              user_id: "17841400000000000",
              permissions: "instagram_business_basic,instagram_business_manage_comments",
            },
          ],
        },
        overrides.shortLivedStatus ?? 200,
      );
    }
    if (url.includes("graph.instagram.com/access_token")) {
      return jsonResponse(
        overrides.longLived ?? {
          access_token: "IGAAlong-lived-ficticio",
          token_type: "bearer",
          expires_in: 5_184_000,
        },
        overrides.longLivedStatus ?? 200,
      );
    }
    throw new Error(`fetch inesperado a ${url}`);
  });
}

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const MOD_ID = "22222222-2222-4222-8222-222222222222";

/** Simula un inicio autorizado (POST /api/admin/social-connect): state + cookie + flujo real. */
async function startFlow(now?: number, admin = ADMIN_ID) {
  const { state, nonce } = createInstagramState(APP_SECRET, now);
  await createSocialOAuthFlow("instagram", nonce, admin, now);
  return { state, nonce };
}

function callbackFor(
  started: { state: string; nonce: string },
  code = "AQC-code-ficticio",
) {
  return req({
    query: { state: started.state, code },
    headers: { cookie: `instagram_oauth_state=${started.nonce}` },
  });
}

async function validCallbackReq(overrides: Partial<{ code: string }> = {}) {
  const started = await startFlow();
  return callbackFor(started, overrides.code ?? "AQC-code-de-un-solo-uso-ficticio");
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("INSTAGRAM_APP_ID", APP_ID);
  vi.stubEnv("INSTAGRAM_APP_SECRET", APP_SECRET);
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-service-role-ficticia");
  resetIgFakeDb();
  resetFlowFake();
  flowFake.roles[ADMIN_ID] = "admin";
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("api/instagram-callback", () => {
  it("OAuth exitoso: 200, guarda la conexión y borra la cookie de state", async () => {
    vi.stubGlobal("fetch", stubMetaFlow());
    const { res, state } = mockRes();

    await callbackHandler(await validCallbackReq(), res);

    expect(state.status).toBe(200);
    expect(state.html).toContain("Instagram conectado correctamente");
    // Regreso directo al panel admin (no al inicio).
    expect(state.html).toContain('<a href="/admin">Volver al panel</a>');
    expect(state.html).not.toContain('href="/"');
    expect(state.headers["Set-Cookie"]).toContain("instagram_oauth_state=;");
    expect(state.headers["Set-Cookie"]).toContain("Max-Age=0");
    expect(igFakeDb.upserts).toHaveLength(1);
    expect(igFakeDb.upserts[0].options).toEqual({ onConflict: "provider" });
    expect(igFakeDb.rows.instagram).toMatchObject({
      provider: "instagram",
      provider_user_id: "17841400000000000",
      access_token: "IGAAlong-lived-ficticio",
      scope: "instagram_business_basic,instagram_business_manage_comments",
    });
    expect(igFakeDb.rows.instagram.refresh_token).toBeUndefined();
    expect(igFakeDb.rows.instagram.refresh_token_expires_at).toBeUndefined();
  });

  it("Preview: 403 sin contactar a Meta ni escribir Supabase", async () => {
    const request = await validCallbackReq();
    igFakeDb.clients = []; // el inicio (crear el flujo) no cuenta: solo lo que hace el callback
    vi.stubEnv("VERCEL_ENV", "preview");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(request, res);

    expect(state.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(igFakeDb.upserts).toHaveLength(0);
    expect(igFakeDb.clients).toHaveLength(0);
  });

  it("método distinto de GET → 405", async () => {
    const { res, state } = mockRes();
    await callbackHandler(req({ method: "POST" }), res);
    expect(state.status).toBe(405);
  });

  it("Instagram rechaza la autorización (?error=access_denied) → 400, sin tocar Meta ni Supabase", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { res, state } = mockRes();

    await callbackHandler(req({ query: { error: "access_denied" } }), res);

    expect(state.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(igFakeDb.upserts).toHaveLength(0);
  });

  it("state con cookie distinta (CSRF) → 400", async () => {
    const { state: st } = createInstagramState(APP_SECRET);
    const { res, state } = mockRes();

    await callbackHandler(
      req({
        query: { state: st, code: "x" },
        headers: { cookie: "instagram_oauth_state=otro-nonce-cualquiera" },
      }),
      res,
    );

    expect(state.status).toBe(400);
    expect(igFakeDb.upserts).toHaveLength(0);
  });

  it("state con firma alterada → 400, sin reclamar el nonce ni contactar a Meta", async () => {
    const { state: st, nonce } = createInstagramState(APP_SECRET);
    const [n, expires] = st.split(".");
    const tampered = `${n}.${expires}.firma-falsa`;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { res, state } = mockRes();

    await callbackHandler(
      req({
        query: { state: tampered, code: "x" },
        headers: { cookie: `instagram_oauth_state=${nonce}` },
      }),
      res,
    );

    expect(state.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(flowFake.events).not.toContain("claim");
  });

  it("state ausente → 400", async () => {
    const { res, state } = mockRes();
    await callbackHandler(req({ query: { code: "x" } }), res);
    expect(state.status).toBe(400);
  });

  it("state expirado → 400", async () => {
    const past = Date.now() - 20 * 60_000;
    const { state: st, nonce } = createInstagramState(APP_SECRET, past);
    const { res, state } = mockRes();

    await callbackHandler(
      req({
        query: { state: st, code: "x" },
        headers: { cookie: `instagram_oauth_state=${nonce}` },
      }),
      res,
    );

    expect(state.status).toBe(400);
  });

  it("code ausente → 400", async () => {
    const { state: st, nonce } = createInstagramState(APP_SECRET);
    const { res, state } = mockRes();

    await callbackHandler(
      req({
        query: { state: st },
        headers: { cookie: `instagram_oauth_state=${nonce}` },
      }),
      res,
    );

    expect(state.status).toBe(400);
  });

  it("Supabase sin configurar → 503, el authorization code NO se consume (Meta no se contacta)", async () => {
    const request = await validCallbackReq();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(request, res);

    expect(state.status).toBe(503);
    expect(flowFake.events).not.toContain("claim");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Instagram rechaza el code exchange → 502, no persiste nada", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("api.instagram.com")
          ? jsonResponse({ error_type: "OAuthException", error_message: "bad code" }, 400)
          : jsonResponse({}, 500),
      ),
    );
    const { res, state } = mockRes();
    await callbackHandler(await validCallbackReq(), res);

    expect(state.status).toBe(502);
    expect(igFakeDb.upserts).toHaveLength(0);
  });

  it("la conversión a token de larga duración falla → 502, no persiste nada", async () => {
    vi.stubGlobal(
      "fetch",
      stubMetaFlow({ longLived: { error_type: "OAuthException" }, longLivedStatus: 400 }),
    );
    const { res, state } = mockRes();
    await callbackHandler(await validCallbackReq(), res);

    expect(state.status).toBe(502);
    expect(igFakeDb.upserts).toHaveLength(0);
  });

  it("Instagram no devuelve un provider_user_id válido → identidad no fiable, no persiste nada", async () => {
    vi.stubGlobal(
      "fetch",
      stubMetaFlow({
        shortLived: {
          data: [
            { access_token: "IGAAshort", user_id: "no-es-numerico", permissions: "" },
          ],
        },
      }),
    );
    const { res, state } = mockRes();
    await callbackHandler(await validCallbackReq(), res);

    expect(state.status).toBe(502);
    expect(igFakeDb.upserts).toHaveLength(0);
  });

  it("el guardado falla tras un intercambio exitoso: la conexión anterior se conserva y NO se declara éxito", async () => {
    igFakeDb.rows.instagram = {
      provider: "instagram",
      provider_user_id: "OLD_PROVIDER_USER_ID",
      access_token: "IGAAtoken-anterior",
      access_token_expires_at: "2026-10-01T00:00:00.000Z",
      scope: "instagram_business_basic",
    };
    igFakeDb.upsertFailWith = { code: "57014", message: "statement timeout" };
    vi.stubGlobal("fetch", stubMetaFlow());

    const { res, state } = mockRes();
    await callbackHandler(await validCallbackReq(), res);

    expect(state.status).toBe(500);
    expect(state.html).not.toContain("IGAAlong-lived-ficticio");
    expect(igFakeDb.rows.instagram.access_token).toBe("IGAAtoken-anterior");
  });

  it("primer callback válido continúa y completa el OAuth", async () => {
    vi.stubGlobal("fetch", stubMetaFlow());
    const { res, state } = mockRes();

    await callbackHandler(await validCallbackReq(), res);

    expect(state.status).toBe(200);
    expect(igFakeDb.upserts).toHaveLength(1);
  });

  it("callback repetido: el 2º intento con el mismo state se rechaza en NUESTRA app (400 genérico) SIN contactar a Meta", async () => {
    const fetchMock = stubMetaFlow();
    vi.stubGlobal("fetch", fetchMock);

    // Mismo req (mismo code + state + cookie) para simular el reenvío exacto del callback.
    const request = await validCallbackReq();

    const first = mockRes();
    await callbackHandler(request, first.res);
    expect(first.state.status).toBe(200);
    expect(igFakeDb.upserts).toHaveLength(1);
    const savedAfterFirst = { ...igFakeDb.rows.instagram };
    const callsAfterFirst = fetchMock.mock.calls.length;

    const second = mockRes();
    await callbackHandler(request, second.res);

    expect(second.state.status).toBe(400);
    // La prueba clave del endurecimiento: el 2º intento no llega a tocar a Meta en
    // absoluto (antes, la única barrera era que Meta rechazara el code reutilizado).
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    expect(igFakeDb.upserts).toHaveLength(1); // ninguna segunda escritura
    expect(igFakeDb.rows.instagram).toEqual(savedAfterFirst);
  });

  it("dos callbacks concurrentes con el mismo state: solo uno completa el OAuth, el otro recibe 400 genérico", async () => {
    vi.stubGlobal("fetch", stubMetaFlow());
    const request = await validCallbackReq();

    const a = mockRes();
    const b = mockRes();
    await Promise.all([callbackHandler(request, a.res), callbackHandler(request, b.res)]);

    const statuses = [a.state.status, b.state.status].sort();
    expect(statuses).toEqual([200, 400]);
    expect(igFakeDb.upserts).toHaveLength(1); // solo una escritura real, pese a la carrera
  });

  it("fallo del mecanismo de claim del flujo (fail-closed): 500, sin contactar a Meta ni persistir", async () => {
    flowFake.failOn.claim = { code: "42501", message: "permission denied" };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(await validCallbackReq(), res);

    expect(state.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(igFakeDb.upserts).toHaveLength(0);
  });

  it("una fila de TikTok preexistente no se modifica tras un OAuth de Instagram", async () => {
    igFakeDb.rows.tiktok = { provider: "tiktok", access_token: "act.tiktok-ficticio" };
    vi.stubGlobal("fetch", stubMetaFlow());

    await callbackHandler(await validCallbackReq(), mockRes().res);

    expect(igFakeDb.rows.tiktok).toEqual({
      provider: "tiktok",
      access_token: "act.tiktok-ficticio",
    });
  });

  it("ningún secreto (tokens, app secret, code, state) aparece en el HTML de respuesta ni en los logs", async () => {
    vi.stubGlobal("fetch", stubMetaFlow());
    const request = await validCallbackReq({ code: "CODE-SUPER-SECRETO-DE-PRUEBA" });
    const { res, state } = mockRes();

    await callbackHandler(request, res);

    const everything = `${state.html ?? ""}${JSON.stringify(errorSpy.mock.calls)}`;
    const secrets = [
      "IGAAlong-lived-ficticio",
      "IGAAshort-lived-ficticio",
      APP_SECRET,
      "CODE-SUPER-SECRETO-DE-PRUEBA",
      (request.query as Record<string, string>).state,
    ];
    for (const secret of secrets) expect(everything).not.toContain(secret);
  });
});

describe("api/instagram-callback: capability server-side (Bloque 8D)", () => {
  const TTL = SOCIAL_OAUTH_FLOW_TTL_MS;

  function expectNoExchangeNoPersist(fetchMock: ReturnType<typeof vi.fn>) {
    expect(fetchMock).not.toHaveBeenCalled();
    expect(igFakeDb.upserts).toHaveLength(0);
    expect(flowFake.events).not.toContain("exchange");
    expect(flowFake.events).not.toContain("persist");
  }

  const GENERIC_400 = "La solicitud de autorización no es válida o caducó";

  it("fuera de Production → 403 ANTES de reclamar el flujo (sin claim, roles, exchange ni escritura)", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = await validCallbackReq();
    flowFake.events = [];

    const { res, state } = mockRes();
    await callbackHandler(request, res);

    expect(state.status).toBe(403);
    expect(flowFake.events).toEqual([]);
    expectNoExchangeNoPersist(fetchMock);
  });

  it("state con firma inválida → 400 sin reclamar el flujo; el flujo sigue intacto", async () => {
    const started = await startFlow();
    const [n, expires] = started.state.split(".");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    flowFake.events = [];

    const { res, state } = mockRes();
    await callbackHandler(
      callbackFor({ state: `${n}.${expires}.firma-falsa`, nonce: n }),
      res,
    );

    expect(state.status).toBe(400);
    expect(flowFake.events).toEqual([]);
    expect(flowFake.flows.get("instagram")?.consumed_at).toBeNull();
    expectNoExchangeNoPersist(fetchMock);
  });

  it("cookie ausente o distinta → 400 sin reclamar el flujo", async () => {
    const started = await startFlow();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    flowFake.events = [];

    for (const cookie of [undefined, "instagram_oauth_state=otro-nonce"]) {
      const { res, state } = mockRes();
      await callbackHandler(
        req({
          query: { state: started.state, code: "x" },
          headers: cookie ? { cookie } : {},
        }),
        res,
      );
      expect(state.status).toBe(400);
    }
    expect(flowFake.events).toEqual([]);
    expect(flowFake.flows.get("instagram")?.consumed_at).toBeNull();
    expectNoExchangeNoPersist(fetchMock);
  });

  it("flujo inexistente (state y cookie válidos, pero nunca hubo un inicio autorizado) → 400, sin exchange ni escritura", async () => {
    const { state: st, nonce } = createInstagramState(APP_SECRET);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(callbackFor({ state: st, nonce }), res);

    expect(state.status).toBe(400);
    expect(state.html).toContain(GENERIC_400);
    expect(flowFake.events).toEqual(["claim"]);
    expectNoExchangeNoPersist(fetchMock);
  });

  it("flujo expirado antes del claim → 400, sin exchange ni escritura", async () => {
    const started = await startFlow(Date.now() - TTL - 1_000);
    // El state firmado ahora también expiraría: se rehace con vigencia nueva y el flujo viejo.
    const { state: freshState, nonce } = createInstagramState(APP_SECRET);
    await createSocialOAuthFlow("instagram", nonce, ADMIN_ID, Date.now() - TTL - 1_000);
    void started;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(callbackFor({ state: freshState, nonce }), res);

    expect(state.status).toBe(400);
    expect(flowFake.events).toEqual(["create", "create", "claim"]);
    expect(flowFake.flows.get("instagram")?.consumed_at).toBeNull();
    expectNoExchangeNoPersist(fetchMock);
  });

  it("flujo ya consumido → 400, sin exchange ni escritura", async () => {
    const started = await startFlow();
    await claimSocialOAuthFlow("instagram", started.nonce);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(callbackFor(started), res);

    expect(state.status).toBe(400);
    expectNoExchangeNoPersist(fetchMock);
  });

  it("flujo reemplazado antes del claim (latest-wins) → 400, sin exchange, y NO consume el flujo nuevo", async () => {
    const a = await startFlow();
    const b = await startFlow();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(callbackFor(a), res);

    expect(state.status).toBe(400);
    expect(flowFake.flows.get("instagram")?.consumed_at).toBeNull();
    expectNoExchangeNoPersist(fetchMock);

    // El callback del flujo vigente (B) sí completa.
    vi.stubGlobal("fetch", stubMetaFlow());
    const ok = mockRes();
    await callbackHandler(callbackFor(b), ok.res);
    expect(ok.state.status).toBe(200);
  });

  it("el admin que se comprueba es el del FLUJO (no uno fijo): otro ADMIN con rol → 200", async () => {
    const OTHER_ADMIN = "55555555-5555-4555-8555-555555555555";
    flowFake.roles = { [OTHER_ADMIN]: "admin" }; // ADMIN_ID ya no tiene rol
    const started = await startFlow(undefined, OTHER_ADMIN);
    vi.stubGlobal("fetch", stubMetaFlow());

    const { res, state } = mockRes();
    await callbackHandler(callbackFor(started), res);

    expect(state.status).toBe(200);
    expect(igFakeDb.upserts).toHaveLength(1);
  });

  it.each([
    ["admin revocado (sin rol)", undefined],
    ["degradado a MODERATOR", "moderator"],
  ])(
    "%s → 400 genérico, sin exchange ni escritura; el flujo queda consumido",
    async (_n, role) => {
      const started = await startFlow();
      flowFake.roles[ADMIN_ID] = role;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const { res, state } = mockRes();
      await callbackHandler(callbackFor(started), res);

      expect(state.status).toBe(400);
      expect(state.html).toContain(GENERIC_400);
      expect(flowFake.events).toEqual(["create", "claim", "roles"]);
      expect(flowFake.flows.get("instagram")?.consumed_at).not.toBeNull();
      expectNoExchangeNoPersist(fetchMock);
    },
  );

  it("error de base de datos al comprobar el rol → 500 fail-closed, sin exchange ni escritura", async () => {
    const started = await startFlow();
    flowFake.failOn.roles = { code: "57014", message: "detalle interno" };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(callbackFor(started), res);

    expect(state.status).toBe(500);
    expect(state.html).not.toContain("detalle interno");
    expectNoExchangeNoPersist(fetchMock);
  });

  it("si el intercambio falla tras el claim, el flujo queda consumido y un reintento no puede reclamarlo", async () => {
    const started = await startFlow();
    const failing = vi.fn(async () =>
      jsonResponse({ error_type: "OAuthException" }, 400),
    );
    vi.stubGlobal("fetch", failing);

    const first = mockRes();
    await callbackHandler(callbackFor(started), first.res);
    expect(first.state.status).toBe(502);
    expect(igFakeDb.upserts).toHaveLength(0);
    expect(flowFake.flows.get("instagram")?.consumed_at).not.toBeNull();
    const callsAfterFirst = failing.mock.calls.length;

    const retry = mockRes();
    await callbackHandler(callbackFor(started), retry.res);
    expect(retry.state.status).toBe(400);
    expect(failing.mock.calls.length).toBe(callsAfterFirst);
  });

  it("flujo reemplazado DURANTE el intercambio → current=false, no se persiste y la conexión anterior se conserva", async () => {
    igFakeDb.rows.instagram = {
      provider: "instagram",
      provider_user_id: "OLD",
      access_token: "IGAAtoken-anterior",
      access_token_expires_at: "2026-10-01T00:00:00.000Z",
      scope: "instagram_business_basic",
    };
    const a = await startFlow();
    vi.stubGlobal(
      "fetch",
      stubMetaFlow({
        onExchange: async () => {
          // Otro ADMIN inicia un OAuth nuevo mientras el intercambio de A está en vuelo.
          await createSocialOAuthFlow(
            "instagram",
            "nonce-de-B-durante-el-exchange",
            ADMIN_ID,
          );
        },
      }),
    );

    const { res, state } = mockRes();
    await callbackHandler(callbackFor(a), res);

    expect(state.status).toBe(400);
    expect(state.html).toContain(GENERIC_400);
    expect(igFakeDb.upserts).toHaveLength(0);
    expect(igFakeDb.rows.instagram.access_token).toBe("IGAAtoken-anterior");
    expect(flowFake.events).not.toContain("persist");
  });

  it("orquestación: claim → rol → exchange → current → persistencia, en ese orden", async () => {
    const started = await startFlow();
    flowFake.events = [];
    vi.stubGlobal("fetch", stubMetaFlow());

    const { res, state } = mockRes();
    await callbackHandler(callbackFor(started), res);

    expect(state.status).toBe(200);
    const ev = flowFake.events;
    const at = (name: string) => ev.indexOf(name as never);
    const lastExchange = ev.lastIndexOf("exchange");
    expect(at("claim")).toBeGreaterThan(-1);
    expect(at("claim")).toBeLessThan(at("roles"));
    expect(at("roles")).toBeLessThan(at("exchange"));
    expect(lastExchange).toBeLessThan(at("current"));
    expect(at("current")).toBeLessThan(at("persist"));
    expect(ev.filter((e) => e === "claim")).toHaveLength(1);
    expect(ev.filter((e) => e === "current")).toHaveLength(1);
    expect(ev.filter((e) => e === "persist")).toHaveLength(1);
  });

  it("cruzar el TTL DURANTE el intercambio no invalida el flujo ya reclamado (current no exige expires_at)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.UTC(2026, 8, 25, 12, 0, 0));
      const started = await startFlow();
      vi.stubGlobal(
        "fetch",
        stubMetaFlow({
          // El intercambio con Meta tarda "más que el TTL": cuando termina, expires_at ya pasó.
          onExchange: () => {
            vi.setSystemTime(Date.now() + TTL + 60_000);
          },
        }),
      );

      const { res, state } = mockRes();
      await callbackHandler(callbackFor(started), res);

      expect(state.status).toBe(200);
      expect(igFakeDb.upserts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("todos los rechazos de la capability tienen la MISMA respuesta pública (sin distinguir la causa)", async () => {
    const html: string[] = [];
    vi.stubGlobal("fetch", vi.fn());

    // 1) flujo inexistente
    const { state: st1, nonce: n1 } = createInstagramState(APP_SECRET);
    const r1 = mockRes();
    await callbackHandler(callbackFor({ state: st1, nonce: n1 }), r1.res);
    html.push(String(r1.state.html));
    // 2) consumido
    const s2 = await startFlow();
    await claimSocialOAuthFlow("instagram", s2.nonce);
    const r2 = mockRes();
    await callbackHandler(callbackFor(s2), r2.res);
    html.push(String(r2.state.html));
    // 3) reemplazado
    const s3 = await startFlow();
    await startFlow();
    const r3 = mockRes();
    await callbackHandler(callbackFor(s3), r3.res);
    html.push(String(r3.state.html));
    // 4) admin revocado
    const s4 = await startFlow();
    flowFake.roles = {};
    const r4 = mockRes();
    await callbackHandler(callbackFor(s4), r4.res);
    html.push(String(r4.state.html));

    for (const r of [r1, r2, r3, r4]) expect(r.state.status).toBe(400);
    expect(new Set(html).size).toBe(1);
    // Y todas limpian la cookie de state.
    for (const r of [r1, r2, r3, r4]) {
      expect(r.state.headers["Set-Cookie"]).toContain("Max-Age=0");
    }
  });

  it("ni las respuestas ni los logs contienen nonce, state, hash, id del admin ni el rol", async () => {
    const started = await startFlow();
    flowFake.roles = {};
    vi.stubGlobal("fetch", vi.fn());
    const { res, state } = mockRes();
    await callbackHandler(callbackFor(started), res);

    const wire = `${state.html ?? ""}${JSON.stringify(state.headers)}${JSON.stringify(errorSpy.mock.calls)}`;
    for (const secret of [started.nonce, started.state, ADMIN_ID, "moderator", "aal2"]) {
      expect(wire).not.toContain(secret);
    }
    void MOD_ID;
  });
});
