import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INSTAGRAM_REDIRECT_URI,
  INSTAGRAM_STATE_TTL_MS,
  InstagramOAuthError,
  buildInstagramAuthorizeUrl,
  clearStateCookie,
  createInstagramState,
  exchangeForLongLivedToken,
  exchangeInstagramCode,
  getInstagramOAuthCredentials,
  instagramOAuthErrorStatus,
  isProductionEnvironment,
  logInstagramOAuthError,
  readStateCookie,
  refreshInstagramAccessToken,
  safeCode,
  stateCookie,
  verifyInstagramState,
} from "./instagram-oauth-shared";

// Fijan la infraestructura OAuth de Instagram: URL/parámetros de autorización, state
// anti-CSRF, intercambio de tokens contra Meta y saneado de logs/errores. Independiente
// de instagram-connection.ts (persistencia) y de tiktok-shared.ts.

const APP_ID = "1234567890";
const APP_SECRET = "secreto-de-app-ficticio";
const CODE = "AQC-code-de-un-solo-uso-ficticio";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isProductionEnvironment", () => {
  it("solo es true cuando VERCEL_ENV = 'production'", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(isProductionEnvironment()).toBe(true);
  });

  it.each([["preview"], ["development"], [""], [undefined]])(
    "es false para VERCEL_ENV = %p",
    (value) => {
      if (value === undefined) vi.stubEnv("VERCEL_ENV", "");
      else vi.stubEnv("VERCEL_ENV", value);
      if (value === undefined) delete process.env.VERCEL_ENV;
      expect(isProductionEnvironment()).toBe(false);
    },
  );
});

describe("getInstagramOAuthCredentials", () => {
  it("devuelve appId/appSecret recortados", () => {
    vi.stubEnv("INSTAGRAM_APP_ID", `  ${APP_ID}  `);
    vi.stubEnv("INSTAGRAM_APP_SECRET", `  ${APP_SECRET}  `);
    expect(getInstagramOAuthCredentials()).toEqual({
      appId: APP_ID,
      appSecret: APP_SECRET,
    });
  });

  it.each([
    ["sin INSTAGRAM_APP_ID", "", APP_SECRET],
    ["sin INSTAGRAM_APP_SECRET", APP_ID, ""],
    ["sin ninguna", "", ""],
  ])("%s → 503", (_name, appId, appSecret) => {
    vi.stubEnv("INSTAGRAM_APP_ID", appId);
    vi.stubEnv("INSTAGRAM_APP_SECRET", appSecret);
    const error = (() => {
      try {
        getInstagramOAuthCredentials();
        return undefined;
      } catch (e) {
        return e as InstagramOAuthError;
      }
    })();
    expect(error).toBeInstanceOf(InstagramOAuthError);
    expect(error?.status).toBe(503);
  });
});

describe("buildInstagramAuthorizeUrl", () => {
  it("incluye exactamente los parámetros requeridos por Instagram Login", () => {
    const url = new URL(buildInstagramAuthorizeUrl(APP_ID, "el-state"));

    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(APP_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(INSTAGRAM_REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("el-state");
    expect(url.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_manage_comments",
    );
  });

  it("nunca usa scopes o hosts de la API antigua/deprecada", () => {
    const url = buildInstagramAuthorizeUrl(APP_ID, "el-state");
    expect(url).not.toContain("instagram_basic");
    expect(url).not.toContain("instagram_manage_comments,");
    expect(url).not.toContain("business_basic,");
    expect(url).not.toContain("graph.facebook.com");
  });
});

describe("state anti-CSRF", () => {
  const NOW = Date.parse("2026-09-21T12:00:00.000Z");

  it("createInstagramState produce un state con 3 partes y el nonce de la cookie", () => {
    const { state, nonce } = createInstagramState(APP_SECRET, NOW);
    expect(state.split(".")).toHaveLength(3);
    expect(state.startsWith(`${nonce}.`)).toBe(true);
  });

  it("state válido, con su cookie y sin expirar → devuelve { nonce, expiresAt }", () => {
    const { state, nonce } = createInstagramState(APP_SECRET, NOW);
    const expiresAtMs = NOW + INSTAGRAM_STATE_TTL_MS;
    expect(verifyInstagramState(state, nonce, APP_SECRET, NOW + 60_000)).toEqual({
      nonce,
      expiresAt: expiresAtMs,
    });
  });

  it("nonce de otra cookie (CSRF) → null", () => {
    const { state } = createInstagramState(APP_SECRET, NOW);
    expect(
      verifyInstagramState(state, "otro-nonce-cualquiera", APP_SECRET, NOW),
    ).toBeNull();
  });

  it("firma alterada (tampering) → null", () => {
    const { state, nonce } = createInstagramState(APP_SECRET, NOW);
    const [n, expires] = state.split(".");
    const tampered = `${n}.${expires}.firma-falsa`;
    expect(verifyInstagramState(tampered, nonce, APP_SECRET, NOW)).toBeNull();
  });

  it("state expirado → null", () => {
    const { state, nonce } = createInstagramState(APP_SECRET, NOW);
    expect(
      verifyInstagramState(state, nonce, APP_SECRET, NOW + 10 * 60_000 + 1),
    ).toBeNull();
  });

  it("exactamente en el borde de expiración (expiresAt === now) → null", () => {
    const { state, nonce } = createInstagramState(APP_SECRET, NOW);
    const expiresAt = NOW + 10 * 60_000;
    expect(verifyInstagramState(state, nonce, APP_SECRET, expiresAt)).toBeNull();
  });

  it("sin cookie (nonce ausente) → null", () => {
    const { state } = createInstagramState(APP_SECRET, NOW);
    expect(verifyInstagramState(state, undefined, APP_SECRET, NOW)).toBeNull();
  });

  it("state ausente o con forma inválida → null", () => {
    expect(verifyInstagramState(undefined, "nonce", APP_SECRET, NOW)).toBeNull();
    expect(verifyInstagramState(42, "nonce", APP_SECRET, NOW)).toBeNull();
    expect(verifyInstagramState("solo.dospartes", "nonce", APP_SECRET, NOW)).toBeNull();
  });

  it("firmado con otro secret (app distinta) → null", () => {
    const { state, nonce } = createInstagramState(APP_SECRET, NOW);
    expect(verifyInstagramState(state, nonce, "otro-secreto", NOW)).toBeNull();
  });

  it("stateCookie: HttpOnly, Secure, SameSite=Lax, Path restringido al callback y Max-Age coherente con el TTL", () => {
    const cookie = stateCookie("un-nonce");
    expect(cookie).toContain("instagram_oauth_state=un-nonce");
    expect(cookie).toContain("Path=/api/instagram-callback");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=600");
  });

  it("clearStateCookie: Max-Age=0", () => {
    expect(clearStateCookie()).toContain("Max-Age=0");
  });

  it("readStateCookie extrae el nonce entre otras cookies", () => {
    expect(readStateCookie("a=1; instagram_oauth_state=el-nonce; b=2")).toBe("el-nonce");
  });

  it("readStateCookie sin la cookie → undefined", () => {
    expect(readStateCookie("a=1; b=2")).toBeUndefined();
    expect(readStateCookie(undefined)).toBeUndefined();
  });
});

describe("exchangeInstagramCode (code -> short-lived token)", () => {
  const credentials = { appId: APP_ID, appSecret: APP_SECRET };

  it("camino feliz: POST a api.instagram.com con los parámetros correctos, respuesta en data[0]", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({
        data: [
          {
            access_token: "IGAAshort-lived-ficticio",
            user_id: "17841400000000000",
            permissions: "instagram_business_basic,instagram_business_manage_comments",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeInstagramCode(CODE, credentials);

    expect(result).toEqual({
      accessToken: "IGAAshort-lived-ficticio",
      providerUserId: "17841400000000000",
      permissions: "instagram_business_basic,instagram_business_manage_comments",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.instagram.com/oauth/access_token");
    expect(init.method).toBe("POST");
    const body = init.body as URLSearchParams;
    expect(body.get("client_id")).toBe(APP_ID);
    expect(body.get("client_secret")).toBe(APP_SECRET);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("redirect_uri")).toBe(INSTAGRAM_REDIRECT_URI);
    expect(body.get("code")).toBe(CODE);
  });

  it("acepta user_id como number JSON (se convierte a string)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            { access_token: "IGAAtoken", user_id: 17841400000000000, permissions: "" },
          ],
        }),
      ),
    );
    const result = await exchangeInstagramCode(CODE, credentials);
    expect(result.providerUserId).toBe("17841400000000000");
  });

  // Compatibilidad: la documentación describe la respuesta envuelta en data[0], pero no
  // puede descartarse que llegue como objeto plano en la raíz (Production rechazó una
  // respuesta HTTP 200 real con el parser que solo aceptaba data[0], y no hay forma de
  // confirmar cuál forma envía Instagram sin repetir el OAuth). Se aceptan ambas de forma
  // estricta: sin relajar ninguna validación ni permitir que la raíz sirva de "bypass"
  // cuando data está presente pero es inválido.

  it("B) forma plana válida (sin envoltorio data[]) → funciona igual que la forma envuelta", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          access_token: "IGAAshort-lived-ficticio",
          user_id: "17841400000000000",
          permissions: "instagram_business_basic,instagram_business_manage_comments",
        }),
      ),
    );

    const result = await exchangeInstagramCode(CODE, credentials);

    expect(result).toEqual({
      accessToken: "IGAAshort-lived-ficticio",
      providerUserId: "17841400000000000",
      permissions: "instagram_business_basic,instagram_business_manage_comments",
    });
  });

  it("B) forma plana: user_id como number JSON también se acepta (se convierte a string)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ access_token: "IGAAtoken", user_id: 17841400000000000 }),
      ),
    );
    const result = await exchangeInstagramCode(CODE, credentials);
    expect(result.providerUserId).toBe("17841400000000000");
    expect(result.permissions).toBe("");
  });

  it("C) forma plana sin access_token → rechazada", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ user_id: "17841400000000000", permissions: "" })),
    );
    await expect(exchangeInstagramCode(CODE, credentials)).rejects.toBeInstanceOf(
      InstagramOAuthError,
    );
  });

  it.each([
    ["ausente", undefined],
    ["vacío", ""],
    ["con letras", "abc123"],
  ])("D) forma plana con user_id inválido (%s) → rechazada", async (_name, userId) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ access_token: "IGAAtoken", user_id: userId })),
    );
    await expect(exchangeInstagramCode(CODE, credentials)).rejects.toBeInstanceOf(
      InstagramOAuthError,
    );
  });

  it("E) data es un array vacío: NO cae al body raíz aunque este tenga campos válidos", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [],
          // Campos válidos "a la vista" en la raíz: no deben usarse como bypass.
          access_token: "IGAAtoken-de-la-raiz-no-deberia-usarse",
          user_id: "17841400000000000",
        }),
      ),
    );
    await expect(exchangeInstagramCode(CODE, credentials)).rejects.toBeInstanceOf(
      InstagramOAuthError,
    );
  });

  it("F) data[0] existe pero es inválido: NO usa los campos de la raíz como bypass", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [{ access_token: "", user_id: "no-es-numerico" }],
          // Campos válidos "a la vista" en la raíz: no deben usarse como bypass.
          access_token: "IGAAtoken-de-la-raiz-no-deberia-usarse",
          user_id: "17841400000000000",
          permissions: "instagram_business_basic",
        }),
      ),
    );
    await expect(exchangeInstagramCode(CODE, credentials)).rejects.toBeInstanceOf(
      InstagramOAuthError,
    );
  });

  it("data no es un array (objeto suelto) → rechazada, no se trata como forma plana", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: { access_token: "IGAAtoken", user_id: "17841400000000000" },
        }),
      ),
    );
    await expect(exchangeInstagramCode(CODE, credentials)).rejects.toBeInstanceOf(
      InstagramOAuthError,
    );
  });

  it("data[0] no es un objeto (p. ej. string) → rechazada", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: ["no-es-un-objeto"] })),
    );
    await expect(exchangeInstagramCode(CODE, credentials)).rejects.toBeInstanceOf(
      InstagramOAuthError,
    );
  });

  it("Instagram rechaza el code (error_message en el cuerpo) → InstagramOAuthError 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error_type: "OAuthException", code: 400, error_message: "Invalid code" },
          400,
        ),
      ),
    );
    const error = await exchangeInstagramCode(CODE, credentials).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramOAuthError);
    expect((error as InstagramOAuthError).status).toBe(502);
    expect((error as InstagramOAuthError).providerCode).toBe("OAuthException");
  });

  it("callback reutilizado: el mismo code ya consumido es rechazado por Instagram (2ª llamada falla)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ access_token: "IGAAprimero", user_id: "178414", permissions: "" }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error_type: "OAuthException",
            error_message: "This authorization code has been used",
          },
          400,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeInstagramCode(CODE, credentials)).resolves.toMatchObject({
      accessToken: "IGAAprimero",
    });
    await expect(exchangeInstagramCode(CODE, credentials)).rejects.toBeInstanceOf(
      InstagramOAuthError,
    );
  });

  it("respuesta sin access_token → inválida", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ user_id: "178414", permissions: "" }] })),
    );
    await expect(exchangeInstagramCode(CODE, credentials)).rejects.toBeInstanceOf(
      InstagramOAuthError,
    );
  });

  it.each([
    ["ausente", undefined],
    ["vacío", ""],
    ["con letras", "abc123"],
    ["con signo", "-178414"],
  ])(
    "provider_user_id %s → identidad no fiable, no se persiste nada",
    async (_name, userId) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({
            data: [{ access_token: "IGAAtoken", user_id: userId, permissions: "" }],
          }),
        ),
      );
      await expect(exchangeInstagramCode(CODE, credentials)).rejects.toBeInstanceOf(
        InstagramOAuthError,
      );
    },
  );

  it("data ausente o vacío → inválida", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [] })),
    );
    await expect(exchangeInstagramCode(CODE, credentials)).rejects.toBeInstanceOf(
      InstagramOAuthError,
    );
  });

  it("cuerpo no JSON → inválida (502), no truena", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no es json", { status: 200 })),
    );
    await expect(exchangeInstagramCode(CODE, credentials)).rejects.toBeInstanceOf(
      InstagramOAuthError,
    );
  });

  it("fallo de red → 502 sin exponer el error original", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`ECONNRESET con ${APP_SECRET}`);
      }),
    );
    const error = await exchangeInstagramCode(CODE, credentials).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramOAuthError);
    expect((error as Error).message).not.toContain(APP_SECRET);
  });

  it("timeout de red (AbortSignal) → 502", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) return reject(signal.reason);
            signal?.addEventListener("abort", () => reject(signal.reason));
          }),
      ),
    );

    const pending = exchangeInstagramCode(CODE, credentials);
    controller.abort(new DOMException("tiempo agotado", "TimeoutError"));
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramOAuthError);
    expect((error as InstagramOAuthError).status).toBe(502);
  });

  it("nunca registra el code ni el app secret aunque Instagram rechace la petición", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error_type: "OAuthException", error_message: `code ${CODE} inválido` },
          400,
        ),
      ),
    );
    const error = await exchangeInstagramCode(CODE, credentials).catch((e: unknown) => e);
    logInstagramOAuthError("test", error);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain(CODE);
    expect(logged).not.toContain(APP_SECRET);
  });
});

describe("exchangeForLongLivedToken (short-lived -> long-lived)", () => {
  const credentials = { appId: APP_ID, appSecret: APP_SECRET };
  const SHORT_LIVED = "IGAAshort-lived-ficticio";

  it("camino feliz: GET a graph.instagram.com con ig_exchange_token y expires_in real", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      jsonResponse({
        access_token: "IGAAlong-lived-ficticio",
        token_type: "bearer",
        expires_in: 5_184_000,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeForLongLivedToken(SHORT_LIVED, credentials);

    expect(result).toEqual({
      accessToken: "IGAAlong-lived-ficticio",
      expiresIn: 5_184_000,
    });
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://graph.instagram.com/access_token",
    );
    expect(parsed.searchParams.get("grant_type")).toBe("ig_exchange_token");
    expect(parsed.searchParams.get("client_secret")).toBe(APP_SECRET);
    expect(parsed.searchParams.get("access_token")).toBe(SHORT_LIVED);
  });

  it("Instagram rechaza la conversión → InstagramOAuthError 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error_type: "OAuthException" }, 400)),
    );
    const error = await exchangeForLongLivedToken(SHORT_LIVED, credentials).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InstagramOAuthError);
    expect((error as InstagramOAuthError).status).toBe(502);
  });

  it.each([
    ["sin access_token", { token_type: "bearer", expires_in: 100 }],
    ["sin expires_in", { access_token: "IGAAlong", token_type: "bearer" }],
    ["expires_in cero", { access_token: "IGAAlong", expires_in: 0 }],
    ["expires_in negativo", { access_token: "IGAAlong", expires_in: -10 }],
    ["expires_in no numérico", { access_token: "IGAAlong", expires_in: "sesenta días" }],
  ])("respuesta inválida (%s) → rechazada", async (_name, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(body)),
    );
    await expect(
      exchangeForLongLivedToken(SHORT_LIVED, credentials),
    ).rejects.toBeInstanceOf(InstagramOAuthError);
  });

  it("fallo de red → 502 sin exponer el token corto ni el secret", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`fallo con ${SHORT_LIVED} y ${APP_SECRET}`);
      }),
    );
    const error = await exchangeForLongLivedToken(SHORT_LIVED, credentials).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InstagramOAuthError);
    expect((error as Error).message).not.toContain(SHORT_LIVED);
    expect((error as Error).message).not.toContain(APP_SECRET);
  });

  it("timeout de red → 502", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) return reject(signal.reason);
            signal?.addEventListener("abort", () => reject(signal.reason));
          }),
      ),
    );

    const pending = exchangeForLongLivedToken(SHORT_LIVED, credentials);
    controller.abort(new DOMException("tiempo agotado", "TimeoutError"));
    await expect(pending).rejects.toBeInstanceOf(InstagramOAuthError);
  });
});

describe("refreshInstagramAccessToken (renovación del token largo)", () => {
  const CURRENT_TOKEN = "IGAAtoken-largo-a-renovar-ficticio";

  it("camino feliz: GET a graph.instagram.com/refresh_access_token con ig_refresh_token", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      jsonResponse({
        access_token: "IGAAtoken-renovado-ficticio",
        token_type: "bearer",
        expires_in: 5_184_000,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshInstagramAccessToken(CURRENT_TOKEN);

    expect(result).toEqual({
      accessToken: "IGAAtoken-renovado-ficticio",
      expiresIn: 5_184_000,
    });
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://graph.instagram.com/refresh_access_token",
    );
    expect(parsed.searchParams.get("grant_type")).toBe("ig_refresh_token");
    expect(parsed.searchParams.get("access_token")).toBe(CURRENT_TOKEN);
    // Nunca lleva client_secret: a diferencia del intercambio inicial, la renovación
    // solo requiere el propio access token vigente.
    expect(parsed.searchParams.has("client_secret")).toBe(false);
  });

  it("Instagram rechaza la renovación → InstagramOAuthError 502 con el código del proveedor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error_type: "OAuthException" }, 400)),
    );
    const error = await refreshInstagramAccessToken(CURRENT_TOKEN).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InstagramOAuthError);
    expect((error as InstagramOAuthError).status).toBe(502);
    expect((error as InstagramOAuthError).httpStatus).toBe(400);
    expect((error as InstagramOAuthError).providerCode).toBe("OAuthException");
  });

  it.each([
    ["sin access_token", { token_type: "bearer", expires_in: 100 }],
    ["sin expires_in", { access_token: "IGAAnuevo", token_type: "bearer" }],
    ["expires_in cero", { access_token: "IGAAnuevo", expires_in: 0 }],
    ["expires_in negativo", { access_token: "IGAAnuevo", expires_in: -10 }],
    ["expires_in no numérico", { access_token: "IGAAnuevo", expires_in: "sesenta días" }],
    ["access_token vacío", { access_token: "", expires_in: 100 }],
  ])("respuesta inválida (%s) → rechazada", async (_name, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(body)),
    );
    await expect(refreshInstagramAccessToken(CURRENT_TOKEN)).rejects.toBeInstanceOf(
      InstagramOAuthError,
    );
  });

  it("cuerpo no JSON → inválida (502), no truena", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no es json", { status: 200 })),
    );
    await expect(refreshInstagramAccessToken(CURRENT_TOKEN)).rejects.toBeInstanceOf(
      InstagramOAuthError,
    );
  });

  it("fallo de red → 502 sin exponer el token en el mensaje", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`ECONNRESET con ${CURRENT_TOKEN}`);
      }),
    );
    const error = await refreshInstagramAccessToken(CURRENT_TOKEN).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InstagramOAuthError);
    expect((error as Error).message).not.toContain(CURRENT_TOKEN);
  });

  it("timeout de red (AbortSignal) → 502", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) return reject(signal.reason);
            signal?.addEventListener("abort", () => reject(signal.reason));
          }),
      ),
    );

    const pending = refreshInstagramAccessToken(CURRENT_TOKEN);
    controller.abort(new DOMException("tiempo agotado", "TimeoutError"));
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramOAuthError);
    expect((error as InstagramOAuthError).status).toBe(502);
  });

  it("nunca registra el token renovado ni el que se está renovando", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error_type: "OAuthException", error_message: "rejected" }, 400),
      ),
    );
    const error = await refreshInstagramAccessToken(CURRENT_TOKEN).catch(
      (e: unknown) => e,
    );
    logInstagramOAuthError("test", error);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain(CURRENT_TOKEN);
  });
});

describe("safeCode / logInstagramOAuthError / instagramOAuthErrorStatus", () => {
  it("safeCode solo deja pasar identificadores cortos", () => {
    expect(safeCode("access_denied")).toBe("access_denied");
    expect(safeCode("con espacios y ñ")).toBeUndefined();
    expect(safeCode(42)).toBeUndefined();
    expect(safeCode("x".repeat(65))).toBeUndefined();
  });

  it("logInstagramOAuthError registra solo mensaje propio + http/code, nunca el error crudo", () => {
    logInstagramOAuthError(
      "instagram-auth",
      new InstagramOAuthError("mensaje seguro", 502, 400, "invalid_request"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[instagram-auth] mensaje seguro (http=400 code=invalid_request)",
    );
  });

  it("error inesperado (no InstagramOAuthError) → solo un mensaje genérico", () => {
    logInstagramOAuthError("instagram-auth", new Error(`fuga de ${APP_SECRET}`));
    expect(errorSpy).toHaveBeenCalledWith("[instagram-auth] error inesperado");
  });

  it("instagramOAuthErrorStatus: usa el status propio o 502 por defecto", () => {
    expect(instagramOAuthErrorStatus(new InstagramOAuthError("x", 400))).toBe(400);
    expect(instagramOAuthErrorStatus(new Error("cualquier cosa"))).toBe(502);
    expect(instagramOAuthErrorStatus("no es ni un error")).toBe(502);
  });
});
