import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchTwitchHelix,
  getAppAccessToken,
  getBroadcasterId,
  getTwitchConfig,
  resetTwitchCacheForTests,
  TwitchApiError,
} from "./twitch-shared";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CREDS = {
  TWITCH_CLIENT_ID: "test-client-id",
  TWITCH_CLIENT_SECRET: "test-client-secret",
};

describe("getTwitchConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    resetTwitchCacheForTests();
  });

  it("lanza TwitchApiError 503 si faltan credenciales", () => {
    delete process.env.TWITCH_CLIENT_ID;
    delete process.env.TWITCH_CLIENT_SECRET;

    expect(() => getTwitchConfig()).toThrow(TwitchApiError);
    try {
      getTwitchConfig();
    } catch (err) {
      expect(err).toBeInstanceOf(TwitchApiError);
      expect((err as TwitchApiError).status).toBe(503);
    }
  });

  it("usa 'upminaa' como canal por defecto si TWITCH_CHANNEL no está definida", () => {
    Object.assign(process.env, CREDS);
    delete process.env.TWITCH_CHANNEL;

    expect(getTwitchConfig().channel).toBe("upminaa");
  });

  it("usa TWITCH_CHANNEL cuando está definida", () => {
    Object.assign(process.env, CREDS, { TWITCH_CHANNEL: "otro_canal" });

    expect(getTwitchConfig().channel).toBe("otro_canal");
  });
});

describe("fetchTwitchHelix — invalidación de token", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    Object.assign(process.env, CREDS);
    resetTwitchCacheForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    resetTwitchCacheForTests();
  });

  it("primera llamada: pide token y llama a Helix una vez", async () => {
    const oauthCalls: string[] = [];
    const helixCalls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("oauth2/token")) {
        oauthCalls.push(url);
        return jsonResponse({ access_token: "token-1", expires_in: 3600 });
      }
      helixCalls.push(url);
      return jsonResponse({ data: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchTwitchHelix("streams?user_login=upminaa");

    expect(response.ok).toBe(true);
    expect(oauthCalls).toHaveLength(1);
    expect(helixCalls).toHaveLength(1);
  });

  it("token cacheado: no vuelve a pedir un token en la siguiente llamada", async () => {
    let oauthCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("oauth2/token")) {
        oauthCalls++;
        return jsonResponse({ access_token: "token-1", expires_in: 3600 });
      }
      return jsonResponse({ data: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchTwitchHelix("streams?user_login=upminaa");
    await fetchTwitchHelix("clips?broadcaster_id=1");

    expect(oauthCalls).toBe(1);
  });

  it(
    "Helix responde 401 con el token cacheado: invalida el token, pide uno nuevo " +
      "y reintenta la misma petición una sola vez, que ahora sí funciona",
    async () => {
      let oauthCalls = 0;
      // Simula que Twitch revoca "token-1" en algún momento entre la 1ª y la
      // 2ª llamada a fetchTwitchHelix (rotación de secreto, revocación
      // manual, etc.), sin esperar a que expire por tiempo.
      let tokenRevoked = false;
      const usedTokens: string[] = [];

      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("oauth2/token")) {
          oauthCalls++;
          return jsonResponse({ access_token: `token-${oauthCalls}`, expires_in: 3600 });
        }
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        const token = auth?.replace("Bearer ", "") ?? "";
        usedTokens.push(token);
        if (token === "token-1" && tokenRevoked) {
          return jsonResponse({ message: "Invalid OAuth token" }, 401);
        }
        return jsonResponse({ data: [{ id: "42" }] });
      });
      vi.stubGlobal("fetch", fetchMock);

      // 1ª llamada: pide y cachea "token-1", funciona con normalidad.
      const first = await fetchTwitchHelix("users?login=upminaa");
      expect(first.ok).toBe(true);
      expect(usedTokens).toEqual(["token-1"]);
      expect(oauthCalls).toBe(1);

      tokenRevoked = true;

      // 2ª llamada: el token cacheado ("token-1") ya no sirve. Debe
      // invalidarlo, pedir uno nuevo y reintentar automáticamente.
      const second = await fetchTwitchHelix("users?login=upminaa");

      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ data: [{ id: "42" }] });
      expect(usedTokens).toEqual(["token-1", "token-1", "token-2"]);
      expect(oauthCalls).toBe(2);
    },
  );

  it("si tras refrescar el token Helix sigue devolviendo 401, no reintenta en bucle", async () => {
    let oauthCalls = 0;
    let helixCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("oauth2/token")) {
        oauthCalls++;
        return jsonResponse({ access_token: `token-${oauthCalls}`, expires_in: 3600 });
      }
      helixCalls++;
      return jsonResponse({ message: "Invalid OAuth token" }, 401);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchTwitchHelix("streams?user_login=upminaa");

    expect(response.status).toBe(401);
    // 1 llamada inicial + 1 reintento tras refrescar = 2, nunca más.
    expect(helixCalls).toBe(2);
    expect(oauthCalls).toBe(2);
  });
});

describe("getBroadcasterId", () => {
  beforeEach(() => {
    Object.assign(process.env, CREDS);
    resetTwitchCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetTwitchCacheForTests();
  });

  it("cachea el broadcaster id entre llamadas (no repite la consulta a /users)", async () => {
    let usersCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return jsonResponse({ access_token: "token-1", expires_in: 3600 });
      }
      if (url.includes("/users")) {
        usersCalls++;
        return jsonResponse({ data: [{ id: "99" }] });
      }
      return jsonResponse({ data: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const id1 = await getBroadcasterId();
    const id2 = await getBroadcasterId();

    expect(id1).toBe("99");
    expect(id2).toBe("99");
    expect(usersCalls).toBe(1);
  });

  it("lanza TwitchApiError 404 si el canal no existe", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return jsonResponse({ access_token: "token-1", expires_in: 3600 });
      }
      return jsonResponse({ data: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getBroadcasterId()).rejects.toMatchObject({ status: 404 });
  });
});

describe("getAppAccessToken", () => {
  beforeEach(() => {
    Object.assign(process.env, CREDS);
    resetTwitchCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetTwitchCacheForTests();
  });

  it("lanza TwitchApiError 502 si Twitch devuelve un token sin access_token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ expires_in: 3600 })),
    );

    await expect(getAppAccessToken()).rejects.toMatchObject({ status: 502 });
  });

  it("lanza TwitchApiError 502 si el OAuth de Twitch rechaza las credenciales", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "invalid client secret" }, 403)),
    );

    await expect(getAppAccessToken()).rejects.toMatchObject({ status: 502 });
  });
});
