import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createInstagramState } from "./instagram-oauth-shared";
import { igFakeDb, resetIgFakeDb } from "./instagram-supabase-fake";

// Fijan el contrato de los dos endpoints del OAuth de Instagram: inicio (redirect +
// cookie), y callback (validación de state, intercambio de tokens, persistencia). Usa el
// mismo estilo que twitch-handlers.test.ts (importa el handler real de api/, con
// req/res de prueba) y el fake de Supabase ya usado por instagram-connection.test.ts.

vi.mock("@supabase/supabase-js", async () => {
  const { fakeInstagramCreateClient } = await import("./instagram-supabase-fake");
  return { createClient: fakeInstagramCreateClient };
});

const authHandler = (await import("../../api/instagram-auth")).default;
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
  } = {},
) {
  return vi.fn(async (url: string) => {
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

function validCallbackReq(overrides: Partial<{ code: string }> = {}) {
  const { state, nonce } = createInstagramState(APP_SECRET);
  return req({
    query: { state, code: overrides.code ?? "AQC-code-de-un-solo-uso-ficticio" },
    headers: { cookie: `instagram_oauth_state=${nonce}` },
  });
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("INSTAGRAM_APP_ID", APP_ID);
  vi.stubEnv("INSTAGRAM_APP_SECRET", APP_SECRET);
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-service-role-ficticia");
  resetIgFakeDb();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("api/instagram-auth", () => {
  it("Production: 302 a la URL de autorización con la cookie de state segura", async () => {
    const { res, state } = mockRes();
    await authHandler(req(), res);

    expect(state.redirectStatus).toBe(302);
    const url = new URL(state.redirectedTo!);
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(APP_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://upmina-web.vercel.app/api/instagram-callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_manage_comments",
    );
    expect(url.searchParams.get("state")).toBeTruthy();

    const cookie = state.headers["Set-Cookie"];
    expect(cookie).toContain("instagram_oauth_state=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/api/instagram-callback");
    expect(cookie).toContain("Max-Age=600");
    expect(state.headers["Cache-Control"]).toBe("no-store");
  });

  it("Preview: 403 sin generar cookie ni contactar a Meta", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await authHandler(req(), res);

    expect(state.status).toBe(403);
    expect(state.headers["Set-Cookie"]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Development (VERCEL_ENV ausente): 403", async () => {
    delete process.env.VERCEL_ENV;
    const { res, state } = mockRes();
    await authHandler(req(), res);
    expect(state.status).toBe(403);
  });

  it("método distinto de GET → 405", async () => {
    const { res, state } = mockRes();
    await authHandler(req({ method: "POST" }), res);
    expect(state.status).toBe(405);
    expect(state.headers.Allow).toBe("GET");
  });

  it("credenciales de Meta faltantes → 503, sin cookie", async () => {
    vi.stubEnv("INSTAGRAM_APP_SECRET", "");
    const { res, state } = mockRes();
    await authHandler(req(), res);
    expect(state.status).toBe(503);
    expect(state.headers["Set-Cookie"]).toBeUndefined();
  });
});

describe("api/instagram-callback", () => {
  it("OAuth exitoso: 200, guarda la conexión y borra la cookie de state", async () => {
    vi.stubGlobal("fetch", stubMetaFlow());
    const { res, state } = mockRes();

    await callbackHandler(validCallbackReq(), res);

    expect(state.status).toBe(200);
    expect(state.html).toContain("Instagram conectado correctamente");
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
    vi.stubEnv("VERCEL_ENV", "preview");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(validCallbackReq(), res);

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
    expect(igFakeDb.nonceInserts).toHaveLength(0);
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
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(validCallbackReq(), res);

    expect(state.status).toBe(503);
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
    await callbackHandler(validCallbackReq(), res);

    expect(state.status).toBe(502);
    expect(igFakeDb.upserts).toHaveLength(0);
  });

  it("la conversión a token de larga duración falla → 502, no persiste nada", async () => {
    vi.stubGlobal(
      "fetch",
      stubMetaFlow({ longLived: { error_type: "OAuthException" }, longLivedStatus: 400 }),
    );
    const { res, state } = mockRes();
    await callbackHandler(validCallbackReq(), res);

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
    await callbackHandler(validCallbackReq(), res);

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
    await callbackHandler(validCallbackReq(), res);

    expect(state.status).toBe(500);
    expect(state.html).not.toContain("IGAAlong-lived-ficticio");
    expect(igFakeDb.rows.instagram.access_token).toBe("IGAAtoken-anterior");
  });

  it("primer callback válido continúa y completa el OAuth", async () => {
    vi.stubGlobal("fetch", stubMetaFlow());
    const { res, state } = mockRes();

    await callbackHandler(validCallbackReq(), res);

    expect(state.status).toBe(200);
    expect(igFakeDb.upserts).toHaveLength(1);
  });

  it("callback repetido: el 2º intento con el mismo state se rechaza en NUESTRA app (409) SIN contactar a Meta", async () => {
    const fetchMock = stubMetaFlow();
    vi.stubGlobal("fetch", fetchMock);

    // Mismo req (mismo code + state + cookie) para simular el reenvío exacto del callback.
    const request = validCallbackReq();

    const first = mockRes();
    await callbackHandler(request, first.res);
    expect(first.state.status).toBe(200);
    expect(igFakeDb.upserts).toHaveLength(1);
    const savedAfterFirst = { ...igFakeDb.rows.instagram };
    const callsAfterFirst = fetchMock.mock.calls.length;

    const second = mockRes();
    await callbackHandler(request, second.res);

    expect(second.state.status).toBe(409);
    // La prueba clave del endurecimiento: el 2º intento no llega a tocar a Meta en
    // absoluto (antes, la única barrera era que Meta rechazara el code reutilizado).
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    expect(igFakeDb.upserts).toHaveLength(1); // ninguna segunda escritura
    expect(igFakeDb.rows.instagram).toEqual(savedAfterFirst);
  });

  it("dos callbacks concurrentes con el mismo state: solo uno completa el OAuth, el otro recibe 409", async () => {
    vi.stubGlobal("fetch", stubMetaFlow());
    const request = validCallbackReq();

    const a = mockRes();
    const b = mockRes();
    await Promise.all([callbackHandler(request, a.res), callbackHandler(request, b.res)]);

    const statuses = [a.state.status, b.state.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(igFakeDb.upserts).toHaveLength(1); // solo una escritura real, pese a la carrera
  });

  it("fallo del mecanismo de consumo del nonce (fail-closed): 500, sin contactar a Meta ni persistir", async () => {
    igFakeDb.nonceInsertFailWith = { code: "42501", message: "permission denied" };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { res, state } = mockRes();
    await callbackHandler(validCallbackReq(), res);

    expect(state.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(igFakeDb.upserts).toHaveLength(0);
  });

  it("una fila de TikTok preexistente no se modifica tras un OAuth de Instagram", async () => {
    igFakeDb.rows.tiktok = { provider: "tiktok", access_token: "act.tiktok-ficticio" };
    vi.stubGlobal("fetch", stubMetaFlow());

    await callbackHandler(validCallbackReq(), mockRes().res);

    expect(igFakeDb.rows.tiktok).toEqual({
      provider: "tiktok",
      access_token: "act.tiktok-ficticio",
    });
  });

  it("ningún secreto (tokens, app secret, code, state) aparece en el HTML de respuesta ni en los logs", async () => {
    vi.stubGlobal("fetch", stubMetaFlow());
    const request = validCallbackReq({ code: "CODE-SUPER-SECRETO-DE-PRUEBA" });
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
