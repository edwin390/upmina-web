import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
// Los 3 endpoints de TikTok los atiende ahora una única Serverless Function
// (api/tiktok/[resource].ts, ver vercel.json) por el límite de 12 funciones del plan
// Hobby de Vercel; la lógica de /api/tiktok-videos no cambió, solo se movió a un export
// nombrado en src/lib/tiktok-handlers.ts. Se renombra en el import para no tocar el
// resto del archivo (mismo nombre local que ya usaban los tests).
import { handleTikTokVideos as handler } from "./tiktok-handlers";
import {
  TikTokConnectionError,
  acquireTikTokRefreshLease,
  getUsableTikTokAccessToken,
} from "./tiktok-connection";
import { countOps, fakeDb, resetFakeDb } from "./tiktok-supabase-fake";

// Fijan /api/tiktok-videos y el refresh automático: el access token sale solo de la
// conexión guardada en Supabase (sin fallback a env), se refresca con lease atómico y
// ningún token llega a respuestas ni logs.

vi.mock("@supabase/supabase-js", async () => {
  const { fakeCreateClient } = await import("./tiktok-supabase-fake");
  return { createClient: fakeCreateClient };
});

const ACCESS = "act.access-guardado-ficticio";
const REFRESH = "rft.refresh-guardado-ficticio";
const NEW_ACCESS = "act.access-nuevo-ficticio";
const NEW_REFRESH = "rft.refresh-nuevo-ficticio";
const ENV_ACCESS = "act.token-de-entorno-ficticio";
const ENV_REFRESH = "rft.refresh-de-entorno-ficticio";
const CLIENT_KEY = "ck-ficticio";
const CLIENT_SECRET = "cs-secreto-ficticio";
const SERVICE_ROLE_KEY = "srk-service-role-ficticia";
const SECRETS = [
  ACCESS,
  REFRESH,
  NEW_ACCESS,
  NEW_REFRESH,
  ENV_ACCESS,
  ENV_REFRESH,
  CLIENT_SECRET,
  SERVICE_ROLE_KEY,
];

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ERROR_BODY = { error: "No se pudieron obtener los videos de TikTok" };

function iso(offsetMs: number) {
  return new Date(NOW + offsetMs).toISOString();
}

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    provider: "tiktok",
    provider_user_id: "open-id-1",
    access_token: ACCESS,
    refresh_token: REFRESH,
    access_token_expires_at: iso(6 * HOUR),
    refresh_token_expires_at: iso(300 * DAY),
    scope: "user.info.basic,video.list",
    refresh_lock_until: null,
    ...overrides,
  };
}

/** Conexión con el access token ya vencido. */
function expiredRow(overrides: Record<string, unknown> = {}) {
  return storedRow({ access_token_expires_at: iso(-1000), ...overrides });
}

interface MockState {
  status: number;
  headers: Record<string, string>;
  body: unknown;
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
  };
  return { res: res as unknown as VercelResponse, state };
}

function req(method = "GET") {
  return { method, query: {}, headers: {} } as unknown as VercelRequest;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const apiVideo = {
  id: "7001",
  title: "Mi video",
  share_url: "https://www.tiktok.com/@upminaa.cos/video/7001",
  cover_image_url: "https://p16.tiktokcdn.com/cover.jpeg",
  create_time: 1_790_000_000,
};
const listOk = { data: { videos: [apiVideo], has_more: false }, error: { code: "ok" } };

const refreshOk = {
  access_token: NEW_ACCESS,
  expires_in: 86400,
  open_id: "open-id-1",
  refresh_expires_in: 31536000,
  refresh_token: NEW_REFRESH,
  scope: "user.info.basic,video.list",
  token_type: "Bearer",
};

const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";

interface FakeTikTok {
  fetchMock: ReturnType<typeof vi.fn>;
  tokenCalls: () => URLSearchParams[];
  listAuthorizations: () => string[];
}

/** Simula los dos endpoints de TikTok: token (refresh) y lista de vídeos. */
function stubTikTok(
  refresh: () => Promise<Response> | Response = () => jsonResponse(refreshOk),
  list: () => Promise<Response> | Response = () => jsonResponse(listOk),
): FakeTikTok {
  const fetchMock = vi.fn(async (url: string) =>
    url === TOKEN_URL ? refresh() : list(),
  );
  vi.stubGlobal("fetch", fetchMock);
  const calls = () => fetchMock.mock.calls as unknown as [string, RequestInit][];
  return {
    fetchMock,
    tokenCalls: () =>
      calls()
        .filter(([url]) => url === TOKEN_URL)
        .map(([, init]) => new URLSearchParams(init.body as URLSearchParams)),
    listAuthorizations: () =>
      calls()
        .filter(([url]) => url !== TOKEN_URL)
        .map(([, init]) => (init.headers as Record<string, string>).Authorization),
  };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

function logged() {
  return errorSpy.mock.calls.flat().join(" ");
}

function leaked(state?: MockState) {
  const haystack = JSON.stringify([state?.body, state?.headers, errorSpy.mock.calls]);
  return SECRETS.some((s) => haystack.includes(s));
}

const noSleep = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  vi.stubEnv("TIKTOK_CLIENT_KEY", CLIENT_KEY);
  vi.stubEnv("TIKTOK_CLIENT_SECRET", CLIENT_SECRET);
  // Variables antiguas presentes: NO deben usarse nunca.
  vi.stubEnv("TIKTOK_ACCESS_TOKEN", ENV_ACCESS);
  vi.stubEnv("TIKTOK_REFRESH_TOKEN", ENV_REFRESH);
  resetFakeDb();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("api/tiktok-videos: conexión guardada", () => {
  it("token válido: llama a TikTok con el access token guardado, sin refresh, y conserva el contrato", async () => {
    fakeDb.row = storedRow();
    const tiktok = stubTikTok();

    const { res, state } = mockRes();
    await handler(req(), res);

    expect(tiktok.tokenCalls()).toHaveLength(0);
    expect(countOps("lease")).toBe(0);
    expect(tiktok.listAuthorizations()).toEqual([`Bearer ${ACCESS}`]);
    const [url, init] = tiktok.fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("https://open.tiktokapis.com/v2/video/list/");
    expect(url).toContain("fields=id,title,cover_image_url,share_url,create_time");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ max_count: 12 });

    expect(state.status).toBe(200);
    expect(state.body).toEqual([
      {
        id: "7001",
        title: "Mi video",
        embedUrl: apiVideo.share_url,
        coverImageUrl: apiVideo.cover_image_url,
        createTime: new Date(1_790_000_000 * 1000).toISOString(),
      },
    ]);
    expect(state.headers["Cache-Control"]).toMatch(/s-maxage=1800/);
    expect(leaked(state)).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("descarta vídeos incompletos o con URLs no https; sin vídeos → lista vacía", async () => {
    fakeDb.row = storedRow();
    stubTikTok(undefined, () =>
      jsonResponse({
        data: {
          videos: [
            apiVideo,
            { ...apiVideo, id: "7002", share_url: "http://x.test/v" },
            { ...apiVideo, id: "7003", cover_image_url: undefined },
            { ...apiVideo, id: undefined },
            { ...apiVideo, id: "7004", create_time: "ayer" },
          ],
        },
        error: { code: "ok" },
      }),
    );
    let r = mockRes();
    await handler(req(), r.res);
    expect((r.state.body as { id: string }[]).map((v) => v.id)).toEqual(["7001"]);

    stubTikTok(undefined, () => jsonResponse({ data: {}, error: { code: "ok" } }));
    r = mockRes();
    await handler(req(), r.res);
    expect(r.state.status).toBe(200);
    expect(r.state.body).toEqual([]);
  });

  it("sin conexión guardada → 503 genérico, sin llamar a TikTok ni usar las variables antiguas", async () => {
    const tiktok = stubTikTok();

    const { res, state } = mockRes();
    await handler(req(), res);

    expect(state.status).toBe(503);
    expect(state.body).toEqual(ERROR_BODY);
    expect(tiktok.fetchMock).not.toHaveBeenCalled();
    expect(state.headers["Cache-Control"]).toBeUndefined();
    expect(logged()).toMatch(/reason=missing/);
    expect(leaked(state)).toBe(false);
  });

  it("fallo de Supabase al leer (error) → 500 genérico, solo código en logs, sin tokens", async () => {
    fakeDb.row = storedRow();
    fakeDb.failOn.select = {
      code: "PGRST301",
      message: `jwt ${ACCESS}`,
      details: REFRESH,
    };
    const tiktok = stubTikTok();

    const { res, state } = mockRes();
    await handler(req(), res);

    expect(state.status).toBe(500);
    expect(state.body).toEqual(ERROR_BODY);
    expect(tiktok.fetchMock).not.toHaveBeenCalled();
    expect(logged()).toMatch(/PGRST301/);
    expect(leaked(state)).toBe(false);
  });

  it("fallo de Supabase al leer (excepción de red) → 500 sin filtrar el mensaje original", async () => {
    fakeDb.throwOn.select = new TypeError(`fetch failed ${ACCESS} ${SERVICE_ROLE_KEY}`);
    const { res, state } = mockRes();
    await handler(req(), res);
    expect(state.status).toBe(500);
    expect(leaked(state)).toBe(false);
  });

  it("Supabase sin configurar → 503 genérico sin llamar a TikTok", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const tiktok = stubTikTok();
    const { res, state } = mockRes();
    await handler(req(), res);
    expect(state.status).toBe(503);
    expect(tiktok.fetchMock).not.toHaveBeenCalled();
    expect(fakeDb.ops).toHaveLength(0);
  });

  it("TikTok rechaza el token (HTTP 401 access_token_invalid) → 502 genérico, sin tokens", async () => {
    fakeDb.row = storedRow();
    stubTikTok(undefined, () =>
      jsonResponse(
        {
          error: {
            code: "access_token_invalid",
            message: `The access token ${ACCESS} is invalid`,
            log_id: "x",
          },
        },
        401,
      ),
    );

    const { res, state } = mockRes();
    await handler(req(), res);

    expect(state.status).toBe(502);
    expect(state.body).toEqual(ERROR_BODY);
    expect(logged()).toMatch(/http=401/);
    expect(logged()).toMatch(/access_token_invalid/);
    expect(logged()).not.toMatch(/is invalid/);
    expect(leaked(state)).toBe(false);
  });

  it("TikTok responde 200 con error, cuerpo no JSON o fallo de red → 502", async () => {
    fakeDb.row = storedRow();
    const cases: (() => Promise<Response> | Response)[] = [
      () => jsonResponse({ error: { code: "rate_limit_exceeded" } }),
      () => new Response("<html>gateway</html>", { status: 502 }),
      () => {
        throw new TypeError(`fetch failed Authorization: Bearer ${ACCESS}`);
      },
    ];
    for (const list of cases) {
      stubTikTok(undefined, list);
      const { res, state } = mockRes();
      await handler(req(), res);
      expect(state.status).toBe(502);
      expect(state.body).toEqual(ERROR_BODY);
      expect(leaked(state)).toBe(false);
    }
  });

  it("405 con métodos distintos de GET, sin leer Supabase ni llamar a TikTok", async () => {
    const tiktok = stubTikTok();
    const { res, state } = mockRes();
    await handler(req("POST"), res);
    expect(state.status).toBe(405);
    expect(tiktok.fetchMock).not.toHaveBeenCalled();
    expect(fakeDb.ops).toHaveLength(0);
  });
});

describe("api/tiktok-videos: refresh automático", () => {
  it("token vencido → refresh → persiste el token set nuevo → usa YA el access token nuevo", async () => {
    fakeDb.row = expiredRow();
    const tiktok = stubTikTok();

    const { res, state } = mockRes();
    await handler(req(), res);

    // Petición de refresh: refresh token guardado + credenciales de la app, nada de env.
    expect(tiktok.tokenCalls()).toHaveLength(1);
    expect(Object.fromEntries(tiktok.tokenCalls()[0])).toEqual({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: REFRESH,
    });
    // Persistencia completa con expiraciones absolutas y lease liberado.
    expect(fakeDb.row).toMatchObject({
      provider_user_id: "open-id-1",
      access_token: NEW_ACCESS,
      refresh_token: NEW_REFRESH,
      access_token_expires_at: iso(86400 * 1000),
      refresh_token_expires_at: iso(31536000 * 1000),
      scope: "user.info.basic,video.list",
      refresh_lock_until: null,
    });
    // La lista de vídeos se pide inmediatamente con el token nuevo.
    expect(tiktok.listAuthorizations()).toEqual([`Bearer ${NEW_ACCESS}`]);
    expect(state.status).toBe(200);
    expect(Array.isArray(state.body)).toBe(true);
    expect(leaked(state)).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("token dentro del margen de 60 s → refresh; fuera del margen → no", async () => {
    fakeDb.row = storedRow({ access_token_expires_at: iso(59_000) });
    let tiktok = stubTikTok();
    await handler(req(), mockRes().res);
    expect(tiktok.tokenCalls()).toHaveLength(1);
    expect(tiktok.listAuthorizations()).toEqual([`Bearer ${NEW_ACCESS}`]);

    resetFakeDb();
    fakeDb.row = storedRow({ access_token_expires_at: iso(61_000) });
    tiktok = stubTikTok();
    await handler(req(), mockRes().res);
    expect(tiktok.tokenCalls()).toHaveLength(0);
    expect(tiktok.listAuthorizations()).toEqual([`Bearer ${ACCESS}`]);
  });

  it("refresh token rotado: se guarda el nuevo y el siguiente refresh usa ese", async () => {
    fakeDb.row = expiredRow();
    stubTikTok();
    await handler(req(), mockRes().res);
    expect(fakeDb.row?.refresh_token).toBe(NEW_REFRESH);

    // Un día después vuelve a caducar: el refresh usa el token ROTADO, no el original.
    fakeDb.row = { ...fakeDb.row!, access_token_expires_at: iso(-1000) };
    const t2 = stubTikTok(() =>
      jsonResponse({
        ...refreshOk,
        access_token: "act.tercero",
        refresh_token: "rft.tercero",
      }),
    );
    await handler(req(), mockRes().res);
    expect(t2.tokenCalls()[0].get("refresh_token")).toBe(NEW_REFRESH);
    expect(fakeDb.row?.refresh_token).toBe("rft.tercero");
  });

  it("TikTok devuelve el MISMO refresh token: también se guarda el set completo", async () => {
    fakeDb.row = expiredRow();
    stubTikTok(() => jsonResponse({ ...refreshOk, refresh_token: REFRESH }));
    await handler(req(), mockRes().res);
    expect(fakeDb.row).toMatchObject({
      access_token: NEW_ACCESS,
      refresh_token: REFRESH,
      refresh_token_expires_at: iso(31536000 * 1000),
    });
  });

  it("si la respuesta de refresh no trae scope, se conserva el guardado", async () => {
    fakeDb.row = expiredRow();
    const { scope: _scope, ...withoutScope } = refreshOk;
    void _scope;
    stubTikTok(() => jsonResponse(withoutScope));
    await handler(req(), mockRes().res);
    expect(fakeDb.row?.scope).toBe("user.info.basic,video.list");
  });

  it("otra petición ya refrescó (refresh token rotado antes de tomar el lease) → sin segundo refresh", async () => {
    fakeDb.row = expiredRow();
    // Justo antes de nuestro lease, otra petición termina su refresh y guarda tokens nuevos.
    fakeDb.before.lease = () => {
      fakeDb.row = storedRow({
        access_token: NEW_ACCESS,
        refresh_token: NEW_REFRESH,
        access_token_expires_at: iso(86400 * 1000),
      });
    };
    const tiktok = stubTikTok();

    const { res, state } = mockRes();
    await handler(req(), res);

    expect(tiktok.tokenCalls()).toHaveLength(0);
    expect(tiktok.listAuthorizations()).toEqual([`Bearer ${NEW_ACCESS}`]);
    expect(state.status).toBe(200);
    expect(leaked(state)).toBe(false);
  });

  it("otra petición ya refrescó (mismo refresh token) → relee con el lease y no llama a TikTok", async () => {
    fakeDb.row = expiredRow();
    // TikTok no rotó el refresh token: el lease se obtiene, pero la relectura ya es válida.
    fakeDb.before.lease = () => {
      fakeDb.row = storedRow({
        access_token: NEW_ACCESS,
        access_token_expires_at: iso(86400 * 1000),
      });
    };
    const tiktok = stubTikTok();

    const { res, state } = mockRes();
    await handler(req(), res);

    expect(tiktok.tokenCalls()).toHaveLength(0);
    expect(tiktok.listAuthorizations()).toEqual([`Bearer ${NEW_ACCESS}`]);
    expect(state.status).toBe(200);
    // El lease tomado se libera.
    expect(fakeDb.row?.refresh_lock_until).toBeNull();
  });

  it("concurrencia: dos peticiones con el token vencido → UN solo refresh; ambas usan el token nuevo", async () => {
    fakeDb.row = expiredRow();
    const tiktok = stubTikTok(
      () =>
        new Promise((resolve) => setTimeout(() => resolve(jsonResponse(refreshOk)), 20)),
    );

    const [a, b] = await Promise.all([
      getUsableTikTokAccessToken(undefined, { sleep: noSleep }),
      getUsableTikTokAccessToken(undefined, { sleep: noSleep }),
    ]);

    expect(tiktok.tokenCalls()).toHaveLength(1);
    expect([a, b]).toEqual([NEW_ACCESS, NEW_ACCESS]);
    expect(fakeDb.row?.refresh_token).toBe(NEW_REFRESH);
    expect(fakeDb.row?.refresh_lock_until).toBeNull();
  });

  it("concurrencia: cinco peticiones simultáneas → un único refresh", async () => {
    fakeDb.row = expiredRow();
    const tiktok = stubTikTok(
      () =>
        new Promise((resolve) => setTimeout(() => resolve(jsonResponse(refreshOk)), 20)),
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        getUsableTikTokAccessToken(undefined, { sleep: noSleep }),
      ),
    );
    expect(tiktok.tokenCalls()).toHaveLength(1);
    expect(new Set(results)).toEqual(new Set([NEW_ACCESS]));
  });

  it("el lease es atómico: solo una adquisición prospera y otra se rechaza mientras esté vigente", async () => {
    fakeDb.row = expiredRow();
    const results = await Promise.all([
      acquireTikTokRefreshLease(REFRESH, NOW),
      acquireTikTokRefreshLease(REFRESH, NOW),
      acquireTikTokRefreshLease(REFRESH, NOW),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    // Un lease caducado (30 s) puede volver a tomarse.
    expect(await acquireTikTokRefreshLease(REFRESH, NOW + 10_000)).toBe(false);
    expect(await acquireTikTokRefreshLease(REFRESH, NOW + 31_000)).toBe(true);
    // Con otro refresh token (ya rotado) no se toma.
    expect(await acquireTikTokRefreshLease("otro", NOW + 99_000)).toBe(false);
  });

  it("lease ocupado por otra petición que no termina → refresh_in_progress (503) sin llamar a TikTok", async () => {
    fakeDb.row = expiredRow({ refresh_lock_until: iso(20_000) });
    const tiktok = stubTikTok();

    const err = await getUsableTikTokAccessToken(undefined, { sleep: noSleep }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TikTokConnectionError);
    expect((err as TikTokConnectionError).reason).toBe("refresh_in_progress");
    expect(tiktok.fetchMock).not.toHaveBeenCalled();
    expect(fakeDb.row?.refresh_token).toBe(REFRESH);
  });

  it("TikTok rechaza el refresh (HTTP 500/otro error) → 502 genérico y la conexión queda intacta", async () => {
    fakeDb.row = expiredRow();
    const before = { ...fakeDb.row };
    stubTikTok(() =>
      jsonResponse(
        { error: "server_error", error_description: `bad ${REFRESH}`, log_id: "x" },
        500,
      ),
    );

    const { res, state } = mockRes();
    await handler(req(), res);

    expect(state.status).toBe(502);
    expect(state.body).toEqual(ERROR_BODY);
    // Nada se borra ni se sobrescribe: mismos tokens y expiraciones.
    expect(fakeDb.row).toMatchObject({
      access_token: before.access_token,
      refresh_token: before.refresh_token,
      access_token_expires_at: before.access_token_expires_at,
      refresh_token_expires_at: before.refresh_token_expires_at,
    });
    expect(countOps("refresh-save")).toBe(0);
    expect(logged()).toMatch(/server_error/);
    expect(logged()).not.toMatch(/bad /);
    expect(leaked(state)).toBe(false);
  });

  it("respuesta de refresh incompleta o inválida → 502 y NO se escribe nada", async () => {
    const { refresh_token: _rt, ...noRefreshToken } = refreshOk;
    const { access_token: _at, ...noAccessToken } = refreshOk;
    void _rt;
    void _at;
    const bad: unknown[] = [
      noRefreshToken,
      noAccessToken,
      { ...refreshOk, open_id: undefined },
      { ...refreshOk, expires_in: 0 },
      { ...refreshOk, refresh_expires_in: "31536000" },
      {},
    ];
    for (const body of bad) {
      resetFakeDb();
      fakeDb.row = expiredRow();
      stubTikTok(() => jsonResponse(body));
      const { res, state } = mockRes();
      await handler(req(), res);
      expect(state.status).toBe(502);
      expect(countOps("refresh-save")).toBe(0);
      expect(fakeDb.row).toMatchObject({ access_token: ACCESS, refresh_token: REFRESH });
      expect(leaked(state)).toBe(false);
    }
  });

  it("cuerpo no JSON o fallo de red en el refresh → 502, conexión intacta, sin filtrar", async () => {
    for (const refresh of [
      () => new Response("<html>gateway</html>", { status: 200 }),
      () => {
        throw new TypeError(`fetch failed client_secret=${CLIENT_SECRET} ${REFRESH}`);
      },
    ]) {
      resetFakeDb();
      fakeDb.row = expiredRow();
      stubTikTok(refresh);
      const { res, state } = mockRes();
      await handler(req(), res);
      expect(state.status).toBe(502);
      expect(countOps("refresh-save")).toBe(0);
      expect(leaked(state)).toBe(false);
    }
  });

  it("refresh token vencido (por fecha) → 503 genérico, reason distinguible y sin llamar a TikTok", async () => {
    fakeDb.row = expiredRow({ refresh_token_expires_at: iso(-1000) });
    const tiktok = stubTikTok();

    const { res, state } = mockRes();
    await handler(req(), res);

    expect(state.status).toBe(503);
    expect(state.body).toEqual(ERROR_BODY);
    expect(tiktok.fetchMock).not.toHaveBeenCalled();
    expect(countOps("lease")).toBe(0);
    expect(logged()).toMatch(/reason=refresh_token_expired/);
    expect(logged()).toMatch(/reautorizar/);
    // Al cliente no le llega nada sobre reautorizar.
    expect(JSON.stringify(state.body)).not.toMatch(/reautoriz|refresh|caduc/i);
    // Los tokens existentes NO se borran.
    expect(fakeDb.row).toMatchObject({ access_token: ACCESS, refresh_token: REFRESH });
    expect(leaked(state)).toBe(false);
  });

  it("TikTok rechaza el refresh token (invalid_grant) → 503 con reason=reauthorization_required, tokens intactos", async () => {
    fakeDb.row = expiredRow();
    stubTikTok(() =>
      jsonResponse(
        {
          error: "invalid_grant",
          error_description: `Refresh token ${REFRESH} is invalid`,
        },
        400,
      ),
    );

    const { res, state } = mockRes();
    await handler(req(), res);

    expect(state.status).toBe(503);
    expect(state.body).toEqual(ERROR_BODY);
    expect(logged()).toMatch(/reason=reauthorization_required/);
    expect(logged()).toMatch(/reautorizar/);
    expect(fakeDb.row).toMatchObject({ access_token: ACCESS, refresh_token: REFRESH });
    expect(countOps("refresh-save")).toBe(0);
    expect(leaked(state)).toBe(false);
  });

  it("fallo de Supabase al guardar los tokens nuevos → 500 genérico, se reintenta una vez y no se filtra nada", async () => {
    fakeDb.row = expiredRow();
    fakeDb.failOn["refresh-save"] = {
      code: "57014",
      message: `canceling statement; ${NEW_ACCESS} ${NEW_REFRESH}`,
    };
    const tiktok = stubTikTok();

    const { res, state } = mockRes();
    await handler(req(), res);

    expect(state.status).toBe(500);
    expect(state.body).toEqual(ERROR_BODY);
    expect(countOps("refresh-save")).toBe(2);
    // No se llegó a pedir la lista de vídeos y la fila no se tocó.
    expect(tiktok.listAuthorizations()).toHaveLength(0);
    expect(fakeDb.row).toMatchObject({ access_token: ACCESS, refresh_token: REFRESH });
    expect(logged()).toMatch(/57014/);
    expect(logged()).not.toMatch(/canceling/);
    expect(leaked(state)).toBe(false);
  });

  it("un fallo transitorio al guardar se recupera con el reintento", async () => {
    fakeDb.row = expiredRow();
    fakeDb.refreshSaveFailures = 1;
    const tiktok = stubTikTok();

    const { res, state } = mockRes();
    await handler(req(), res);

    expect(state.status).toBe(200);
    expect(tiktok.tokenCalls()).toHaveLength(1); // un único refresh contra TikTok
    expect(fakeDb.row).toMatchObject({
      access_token: NEW_ACCESS,
      refresh_token: NEW_REFRESH,
    });
    expect(leaked(state)).toBe(false);
  });

  it("excepción de red de Supabase al guardar → 500 sin filtrar el mensaje original", async () => {
    fakeDb.row = expiredRow();
    fakeDb.throwOn["refresh-save"] = new TypeError(
      `fetch failed ${NEW_REFRESH} ${SERVICE_ROLE_KEY}`,
    );
    stubTikTok();
    const { res, state } = mockRes();
    await handler(req(), res);
    expect(state.status).toBe(500);
    expect(leaked(state)).toBe(false);
  });

  it("fallo de Supabase al tomar el lease → 500 y no se llama a TikTok", async () => {
    fakeDb.row = expiredRow();
    fakeDb.failOn.lease = {
      code: "42703",
      message: "column refresh_lock_until does not exist",
    };
    const tiktok = stubTikTok();
    const { res, state } = mockRes();
    await handler(req(), res);
    expect(state.status).toBe(500);
    expect(tiktok.fetchMock).not.toHaveBeenCalled();
    expect(logged()).toMatch(/42703/);
    expect(leaked(state)).toBe(false);
  });

  it("si la conexión cambió durante el refresh (reautorización) no se sobrescribe y no se reintenta", async () => {
    fakeDb.row = expiredRow();
    fakeDb.before["refresh-save"] = () => {
      fakeDb.row = storedRow({
        access_token: "act.reautorizado",
        refresh_token: "rft.reautorizado",
      });
    };
    stubTikTok();

    const { res, state } = mockRes();
    await handler(req(), res);

    expect(state.status).toBe(500);
    expect(fakeDb.row).toMatchObject({
      access_token: "act.reautorizado",
      refresh_token: "rft.reautorizado",
    });
    expect(countOps("refresh-save")).toBe(1);
    expect(leaked(state)).toBe(false);
  });

  it("tokens de otra cuenta (open_id distinto) → no se guardan", async () => {
    fakeDb.row = expiredRow();
    stubTikTok(() => jsonResponse({ ...refreshOk, open_id: "otra-cuenta" }));
    const { res, state } = mockRes();
    await handler(req(), res);
    expect(state.status).toBe(502);
    expect(countOps("refresh-save")).toBe(0);
    expect(fakeDb.row).toMatchObject({
      access_token: ACCESS,
      provider_user_id: "open-id-1",
    });
  });

  it("sin credenciales de la app → 503, sin lease ni llamada a TikTok, conexión intacta", async () => {
    vi.stubEnv("TIKTOK_CLIENT_SECRET", "");
    fakeDb.row = expiredRow();
    const tiktok = stubTikTok();
    const { res, state } = mockRes();
    await handler(req(), res);
    expect(state.status).toBe(503);
    expect(tiktok.fetchMock).not.toHaveBeenCalled();
    expect(countOps("lease")).toBe(0);
    expect(fakeDb.row).toMatchObject({ access_token: ACCESS, refresh_token: REFRESH });
  });

  it("fecha de expiración ilegible → error de almacenamiento (500), no se usa el token", async () => {
    fakeDb.row = storedRow({ access_token_expires_at: "no-es-fecha" });
    const tiktok = stubTikTok();
    const { res, state } = mockRes();
    await handler(req(), res);
    expect(state.status).toBe(500);
    expect(tiktok.fetchMock).not.toHaveBeenCalled();
  });

  it("nunca usa TIKTOK_ACCESS_TOKEN ni TIKTOK_REFRESH_TOKEN (ni con conexión válida ni al refrescar)", async () => {
    for (const row of [storedRow(), expiredRow()]) {
      resetFakeDb();
      fakeDb.row = row;
      const tiktok = stubTikTok();
      await handler(req(), mockRes().res);
      const sent = JSON.stringify(
        tiktok.fetchMock.mock.calls.map(([url, init]) => [
          url,
          (init as RequestInit).headers,
          String((init as RequestInit).body),
        ]),
      );
      expect(sent).not.toContain(ENV_ACCESS);
      expect(sent).not.toContain(ENV_REFRESH);
    }
    // Sin conexión guardada tampoco hay fallback a las variables antiguas.
    resetFakeDb();
    const tiktok = stubTikTok();
    const { res, state } = mockRes();
    await handler(req(), res);
    expect(state.status).toBe(503);
    expect(tiktok.fetchMock).not.toHaveBeenCalled();
  });

  it("getUsableTikTokAccessToken distingue programáticamente cada motivo", async () => {
    stubTikTok();
    await expect(getUsableTikTokAccessToken(NOW)).rejects.toMatchObject({
      name: "TikTokConnectionError",
      reason: "missing",
    });

    fakeDb.row = expiredRow({ refresh_token_expires_at: iso(-1) });
    const err = await getUsableTikTokAccessToken(NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TikTokConnectionError);
    expect((err as TikTokConnectionError).reason).toBe("refresh_token_expired");
    expect((err as TikTokConnectionError).status).toBe(503);
    expect((err as Error).message).not.toMatch(/act\.|rft\./);

    fakeDb.row = storedRow();
    await expect(getUsableTikTokAccessToken(NOW)).resolves.toBe(ACCESS);
  });

  it("ningún token (viejo, nuevo, de entorno, secret ni service_role) aparece en respuestas ni logs en ningún escenario de fallo", async () => {
    const scenarios: (() => void)[] = [
      () => {
        fakeDb.row = expiredRow();
        stubTikTok(() =>
          jsonResponse({ error: "invalid_grant", error_description: REFRESH }, 400),
        );
      },
      () => {
        fakeDb.row = expiredRow();
        stubTikTok(() => jsonResponse({ ...refreshOk, refresh_token: undefined }));
      },
      () => {
        fakeDb.row = expiredRow();
        fakeDb.failOn["refresh-save"] = {
          code: "XX000",
          message: `${NEW_ACCESS} ${NEW_REFRESH}`,
        };
        stubTikTok();
      },
      () => {
        fakeDb.row = expiredRow();
        stubTikTok(() => {
          throw new Error(`${CLIENT_SECRET} ${REFRESH}`);
        });
      },
    ];
    for (const setup of scenarios) {
      resetFakeDb();
      errorSpy.mockClear();
      setup();
      const { res, state } = mockRes();
      await handler(req(), res);
      expect(state.status).toBeGreaterThanOrEqual(500);
      expect(state.body).toEqual(ERROR_BODY);
      expect(leaked(state)).toBe(false);
    }
  });
});
