import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InstagramConnectionError,
  InstagramConnectionFormatError,
  InstagramStorageError,
  acquireInstagramRefreshLease,
  assertInstagramStorageConfigured,
  claimInstagramOAuthNonce,
  getInstagramConnection,
  getUsableInstagramAccessToken,
  saveInstagramConnection,
  type InstagramTokenSet,
} from "./instagram-connection";
import { countIgOps, igFakeDb, resetIgFakeDb } from "./instagram-supabase-fake";

// Fijan la lectura de la conexión de Instagram y la prioridad de resolución del token:
// Supabase primero y, solo mientras no exista fila, INSTAGRAM_ACCESS_TOKEN (temporal).

vi.mock("@supabase/supabase-js", async () => {
  const { fakeInstagramCreateClient } = await import("./instagram-supabase-fake");
  return { createClient: fakeInstagramCreateClient };
});

const DB_TOKEN = "IGAA-token-de-supabase-ficticio";
const ENV_TOKEN = "IGAA-token-de-env-ficticio";
const TIKTOK_TOKEN = "act.token-de-tiktok-ficticio";
const SUPABASE_URL = "https://proyecto-ficticio.supabase.co";
const SERVICE_ROLE_KEY = "srk-service-role-ficticia";
const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const HOUR = 3_600_000;

const igRow = (overrides: Record<string, unknown> = {}) => ({
  provider: "instagram",
  provider_user_id: "17841400000000000",
  access_token: DB_TOKEN,
  access_token_expires_at: new Date(NOW + 30 * 24 * HOUR).toISOString(),
  scope: "instagram_business_basic",
  ...overrides,
});

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetIgFakeDb();
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", ENV_TOKEN);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const logged = () => JSON.stringify(errorSpy.mock.calls);

const DAY = 24 * HOUR;
const RENEWAL_THRESHOLD_MS = 7 * DAY;
const noSleep = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const REFRESH_URL = "https://graph.instagram.com/refresh_access_token";
const NEW_DB_TOKEN = "IGAA-token-renovado-ficticio";

/** Simula graph.instagram.com/refresh_access_token; cualquier otra URL no debería
 *  llamarse desde estos tests. */
function stubInstagramRefresh(
  respond: () => Promise<Response> | Response = () =>
    jsonResponse({ access_token: NEW_DB_TOKEN, expires_in: 60 * 24 * 3600 }),
) {
  const fetchMock = vi.fn(async (url: string) => {
    if (!url.startsWith(REFRESH_URL)) {
      throw new Error(`llamada de red inesperada en el test: ${url}`);
    }
    return respond();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("getInstagramConnection", () => {
  it("devuelve la fila de Instagram con los campos del contrato", async () => {
    igFakeDb.rows.instagram = igRow();

    expect(await getInstagramConnection()).toEqual({
      providerUserId: "17841400000000000",
      accessToken: DB_TOKEN,
      accessTokenExpiresAt: new Date(NOW + 30 * 24 * HOUR).toISOString(),
      scope: "instagram_business_basic",
    });
  });

  it("devuelve null si no hay fila de Instagram", async () => {
    expect(await getInstagramConnection()).toBeNull();
  });

  it("solo consulta provider = instagram y no lee las columnas de refresh", async () => {
    igFakeDb.rows.instagram = igRow();
    await getInstagramConnection();

    expect(igFakeDb.queries).toHaveLength(1);
    const [query] = igFakeDb.queries;
    expect(query.table).toBe("social_connections");
    expect(query.filters).toEqual([["provider", "instagram"]]);
    expect(query.columns).not.toMatch(/refresh/);
    expect(query.columns).not.toContain("*");
  });

  it("la fila de TikTok nunca se usa como conexión de Instagram", async () => {
    igFakeDb.rows.tiktok = {
      provider: "tiktok",
      provider_user_id: "open-id",
      access_token: TIKTOK_TOKEN,
      refresh_token: "rft.ficticio",
      access_token_expires_at: new Date(NOW + 24 * HOUR).toISOString(),
      refresh_token_expires_at: new Date(NOW + 48 * HOUR).toISOString(),
    };

    expect(await getInstagramConnection()).toBeNull();
    expect(await getUsableInstagramAccessToken(NOW)).toBe(ENV_TOKEN);
    expect(igFakeDb.queries.every((q) => q.filters[0][1] === "instagram")).toBe(true);
  });

  it("defensa en profundidad: una fila devuelta con otro provider se rechaza", async () => {
    igFakeDb.rows.instagram = igRow({ provider: "tiktok", access_token: TIKTOK_TOKEN });

    await expect(getInstagramConnection()).rejects.toBeInstanceOf(
      InstagramConnectionFormatError,
    );
  });

  it.each([
    ["sin provider_user_id", { provider_user_id: "" }],
    ["provider_user_id que no es texto", { provider_user_id: 42 }],
    ["sin access_token", { access_token: "" }],
    ["access_token que no es texto", { access_token: null }],
    ["sin fecha de caducidad", { access_token_expires_at: null }],
    ["fecha de caducidad ilegible", { access_token_expires_at: "no-es-fecha" }],
  ])("fila inválida (%s) → error 500 sin datos de la fila", async (_name, override) => {
    igFakeDb.rows.instagram = igRow(override);

    const error = await getInstagramConnection().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramStorageError);
    expect((error as InstagramStorageError).status).toBe(500);
    expect((error as Error).message).not.toContain(DB_TOKEN);
  });

  it("scope ausente se normaliza a cadena vacía", async () => {
    igFakeDb.rows.instagram = igRow({ scope: null });
    expect((await getInstagramConnection())?.scope).toBe("");
  });

  it("Supabase sin configurar → 503 sin crear cliente ni tocar la red", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

    const error = await getInstagramConnection().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramStorageError);
    expect((error as InstagramStorageError).status).toBe(503);
    expect(igFakeDb.clients).toHaveLength(0);
  });

  it("crea el cliente admin sin persistir sesión y con la service_role key", async () => {
    await getInstagramConnection();

    expect(igFakeDb.clients[0][0]).toBe(SUPABASE_URL);
    expect(igFakeDb.clients[0][1]).toBe(SERVICE_ROLE_KEY);
    expect(igFakeDb.clients[0][2]).toEqual({
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  it("un error de Supabase se reduce a un código saneado (sin mensaje ni detalles)", async () => {
    igFakeDb.failWith = {
      code: "42501",
      message: `permission denied ${DB_TOKEN}`,
      details: SERVICE_ROLE_KEY,
    };

    const error = await getInstagramConnection().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramStorageError);
    expect((error as InstagramStorageError).code).toBe("42501");
    expect((error as Error).message).toBe("Error de almacenamiento (get)");
  });

  it("un código con forma extraña se descarta", async () => {
    igFakeDb.failWith = { code: `código con ${DB_TOKEN} y espacios` };

    const error = (await getInstagramConnection().catch(
      (e: unknown) => e,
    )) as InstagramStorageError;
    expect(error.code).toBeUndefined();
  });
});

describe("getUsableInstagramAccessToken: prioridad de resolución", () => {
  it("A) fila con más de 60 s de vigencia → token de Supabase, sin mirar el env", async () => {
    igFakeDb.rows.instagram = igRow();
    vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "");

    expect(await getUsableInstagramAccessToken(NOW)).toBe(DB_TOKEN);
  });

  it("A) con la fila vigente gana Supabase aunque exista el env", async () => {
    igFakeDb.rows.instagram = igRow();

    expect(await getUsableInstagramAccessToken(NOW)).toBe(DB_TOKEN);
  });

  it("A) con 61 s de margen todavía se usa", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 61_000).toISOString(),
    });

    expect(await getUsableInstagramAccessToken(NOW)).toBe(DB_TOKEN);
  });

  it("B) sin fila de Instagram → fallback al env", async () => {
    expect(await getUsableInstagramAccessToken(NOW)).toBe(ENV_TOKEN);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("C) Supabase sin configurar → env, sin llamadas de red ni ruido en los logs", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");

    expect(await getUsableInstagramAccessToken(NOW)).toBe(ENV_TOKEN);
    expect(igFakeDb.clients).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("D) error al leer Supabase → env, con un log saneado", async () => {
    igFakeDb.failWith = { code: "08006", message: `caída con ${DB_TOKEN}` };

    expect(await getUsableInstagramAccessToken(NOW)).toBe(ENV_TOKEN);
    expect(errorSpy).toHaveBeenCalledWith(
      "[instagram-connection] Error de almacenamiento (get) (code=08006); usando INSTAGRAM_ACCESS_TOKEN",
    );
  });

  it("D) excepción de red al leer Supabase → env", async () => {
    igFakeDb.throwWith = new Error(`fetch failed ${SUPABASE_URL} ${SERVICE_ROLE_KEY}`);

    expect(await getUsableInstagramAccessToken(NOW)).toBe(ENV_TOKEN);
    expect(logged()).not.toContain(SERVICE_ROLE_KEY);
    expect(logged()).not.toContain(SUPABASE_URL);
  });

  it("D) error de lectura y sin env → error de almacenamiento saneado (500)", async () => {
    vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "");
    igFakeDb.failWith = { code: "08006", message: "caída" };

    const error = await getUsableInstagramAccessToken(NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramStorageError);
    expect((error as InstagramStorageError).status).toBe(500);
    expect((error as Error).message).toBe("Error de almacenamiento (get)");
    expect((error as InstagramStorageError).code).toBe("08006");
  });

  it("F) sin fila y sin env → 503 con el mensaje de siempre", async () => {
    vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "");

    const error = await getUsableInstagramAccessToken(NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramConnectionError);
    expect((error as InstagramConnectionError).status).toBe(503);
    expect((error as Error).message).toBe(
      "Falta la variable de entorno de Instagram: INSTAGRAM_ACCESS_TOKEN",
    );
  });

  it("F) Supabase sin configurar y sin env → 503 (comportamiento anterior)", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "   ");

    const error = await getUsableInstagramAccessToken(NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramConnectionError);
    expect((error as InstagramConnectionError).reason).toBe("missing_token");
  });

  it("el env se recorta como antes (espacios alrededor del token)", async () => {
    vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", `  ${ENV_TOKEN}  `);
    expect(await getUsableInstagramAccessToken(NOW)).toBe(ENV_TOKEN);
  });
});

describe("getUsableInstagramAccessToken: fila expirada o inválida (sin fallback)", () => {
  it("E) fila expirada → 503 SIN usar el env", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW - HOUR).toISOString(),
    });

    const error = await getUsableInstagramAccessToken(NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramConnectionError);
    expect((error as InstagramConnectionError).status).toBe(503);
    expect((error as InstagramConnectionError).reason).toBe("expired");
    expect((error as Error).message).not.toContain(ENV_TOKEN);
    expect((error as Error).message).not.toContain(DB_TOKEN);
  });

  it("E) fila a exactamente 60 s de caducar → 503 SIN fallback", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 60_000).toISOString(),
    });

    await expect(getUsableInstagramAccessToken(NOW)).rejects.toMatchObject({
      status: 503,
      reason: "expired",
    });
  });

  it("E) fila a menos de 60 s de caducar → 503 SIN fallback", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 30_000).toISOString(),
    });

    await expect(getUsableInstagramAccessToken(NOW)).rejects.toMatchObject({
      status: 503,
      reason: "expired",
    });
  });

  it("fila inválida → 500, tampoco hay fallback al env", async () => {
    igFakeDb.rows.instagram = igRow({ access_token: "" });

    const error = await getUsableInstagramAccessToken(NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramConnectionFormatError);
    expect((error as InstagramStorageError).status).toBe(500);
  });

  it("sin fecha explícita usa la hora actual", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(Date.now() - HOUR).toISOString(),
    });

    await expect(getUsableInstagramAccessToken()).rejects.toMatchObject({
      reason: "expired",
    });
  });
});

// Renovación automática (auto-refresh) del token largo persistido. Independiente de la
// prioridad de resolución de arriba: estos tests fijan solo lo que ocurre CON una fila
// de Instagram ya válida (no expirada) cuando está dentro del umbral de renovación.

describe("getUsableInstagramAccessToken: renovación automática", () => {
  it("A) más de 7 días de vigencia → no llama a Meta, devuelve el token guardado", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + RENEWAL_THRESHOLD_MS + 1000).toISOString(),
    });
    const fetchMock = stubInstagramRefresh();

    expect(await getUsableInstagramAccessToken(NOW)).toBe(DB_TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(countIgOps("lease")).toBe(0);
  });

  it("exactamente a 7 días → SÍ se considera dentro del umbral (intenta renovar)", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + RENEWAL_THRESHOLD_MS).toISOString(),
    });
    const fetchMock = stubInstagramRefresh();

    expect(await getUsableInstagramAccessToken(NOW)).toBe(NEW_DB_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("dentro de los 7 días → renueva bajo lease y devuelve el token nuevo", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
    const fetchMock = stubInstagramRefresh();

    const token = await getUsableInstagramAccessToken(NOW);

    expect(token).toBe(NEW_DB_TOKEN);
    const [url] = fetchMock.mock.calls[0];
    expect(new URL(url as string).searchParams.get("access_token")).toBe(DB_TOKEN);
    expect(countIgOps("lease")).toBe(1);
  });

  it("refresh exitoso: persiste access_token y nueva expiración, libera el lease", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
    stubInstagramRefresh(() =>
      jsonResponse({ access_token: NEW_DB_TOKEN, expires_in: 60 * 24 * 3600 }),
    );

    await getUsableInstagramAccessToken(NOW);

    expect(igFakeDb.rows.instagram).toMatchObject({
      provider: "instagram",
      access_token: NEW_DB_TOKEN,
      access_token_expires_at: new Date(NOW + 60 * 24 * HOUR).toISOString(),
      refresh_lock_until: null,
    });
    expect(countIgOps("refresh-save")).toBe(1);
  });

  it("refresh_token / refresh_token_expires_at nunca se escriben (siguen NULL)", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
    stubInstagramRefresh();

    await getUsableInstagramAccessToken(NOW);

    expect(igFakeDb.rows.instagram).not.toHaveProperty("refresh_token");
    expect(igFakeDb.rows.instagram).not.toHaveProperty("refresh_token_expires_at");
  });

  it("fallo de red de Meta con el token actual todavía vigente → usa el token actual, registra el error saneado", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
    stubInstagramRefresh(() => {
      throw new Error(`ECONNRESET con ${DB_TOKEN}`);
    });

    const token = await getUsableInstagramAccessToken(NOW);

    expect(token).toBe(DB_TOKEN);
    expect(countIgOps("refresh-save")).toBe(0);
    expect(errorSpy).toHaveBeenCalled();
    expect(logged()).not.toContain(DB_TOKEN);
  });

  it("HTTP error de Meta con el token actual todavía vigente → usa el token actual", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
    stubInstagramRefresh(() => jsonResponse({ error_type: "OAuthException" }, 400));

    expect(await getUsableInstagramAccessToken(NOW)).toBe(DB_TOKEN);
    expect(countIgOps("refresh-save")).toBe(0);
  });

  it("JSON malformado en la respuesta de Meta → tratado como fallo, usa el token actual", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
    stubInstagramRefresh(() => new Response("no es json", { status: 200 }));

    expect(await getUsableInstagramAccessToken(NOW)).toBe(DB_TOKEN);
  });

  it("access_token ausente en la respuesta → tratado como fallo, usa el token actual", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
    stubInstagramRefresh(() => jsonResponse({ expires_in: 100 }));

    expect(await getUsableInstagramAccessToken(NOW)).toBe(DB_TOKEN);
  });

  it("expires_in inválido en la respuesta → tratado como fallo, usa el token actual", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
    stubInstagramRefresh(() => jsonResponse({ access_token: "IGAAx", expires_in: 0 }));

    expect(await getUsableInstagramAccessToken(NOW)).toBe(DB_TOKEN);
  });

  it("timeout de Meta con el token actual todavía vigente → usa el token actual", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
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

    const pending = getUsableInstagramAccessToken(NOW);
    controller.abort(new DOMException("tiempo agotado", "TimeoutError"));
    expect(await pending).toBe(DB_TOKEN);
  });

  it("Meta falla y el token ya no es utilizable (carrera con otra escritura) → 503, sin fallback al env", async () => {
    // Justo antes de tomar el lease, otra operación deja la fila con el MISMO
    // access_token pero ya a menos de 60 s de expirar (simula una situación donde el
    // margen duro se cruza entre la lectura inicial y la renovación).
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
    igFakeDb.before.lease = () => {
      igFakeDb.rows.instagram = igRow({
        access_token: DB_TOKEN,
        access_token_expires_at: new Date(NOW + 30_000).toISOString(),
      });
    };
    stubInstagramRefresh(() => jsonResponse({ error_type: "OAuthException" }, 400));

    const error = await getUsableInstagramAccessToken(NOW).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InstagramConnectionError);
    expect((error as InstagramConnectionError).status).toBe(503);
    expect((error as InstagramConnectionError).reason).toBe("expired");
  });

  it("fallo al persistir tras un refresh exitoso: NO da la renovación por completada, conserva la fila anterior, usa el token actual", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
    igFakeDb.failOn["refresh-save"] = {
      code: "57014",
      message: `canceling statement ${NEW_DB_TOKEN}`,
    };
    stubInstagramRefresh();

    const token = await getUsableInstagramAccessToken(NOW);

    expect(token).toBe(DB_TOKEN);
    expect(igFakeDb.rows.instagram.access_token).toBe(DB_TOKEN);
    expect(logged()).toMatch(/57014/);
    expect(logged()).not.toContain(NEW_DB_TOKEN);
  });

  it("fallo al persistir Y el token actual ya no es utilizable → se propaga el error de almacenamiento", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
    igFakeDb.before.lease = () => {
      igFakeDb.rows.instagram = igRow({
        access_token: DB_TOKEN,
        access_token_expires_at: new Date(NOW + 30_000).toISOString(),
      });
    };
    igFakeDb.failOn["refresh-save"] = { code: "57014", message: "boom" };
    stubInstagramRefresh();

    const error = await getUsableInstagramAccessToken(NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramStorageError);
    expect((error as InstagramStorageError).code).toBe("57014");
  });

  it("UPDATE condicionado evita sobrescribir una conexión que cambió (reautorización durante el refresh)", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
    igFakeDb.before["refresh-save"] = () => {
      // Otra autorización completa reemplaza la fila mientras Meta respondía.
      igFakeDb.rows.instagram = igRow({
        provider_user_id: "17841400000000099",
        access_token: "IGAA-token-de-otra-reautorizacion",
        access_token_expires_at: new Date(NOW + 60 * DAY).toISOString(),
      });
    };
    stubInstagramRefresh();

    const token = await getUsableInstagramAccessToken(NOW);

    // No se pisa: se sirve lo que quedó tras la reautorización, no el token que
    // esta petición había renovado.
    expect(token).toBe("IGAA-token-de-otra-reautorizacion");
    expect(igFakeDb.rows.instagram.access_token).toBe(
      "IGAA-token-de-otra-reautorizacion",
    );
  });

  it("dos peticiones concurrentes dentro del umbral → un único refresh contra Meta", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
    // El refresh "ganador" tarda 5 ms; la petición que pierde el lease espera 30 ms
    // (bastante más) antes de releer, así que su única relectura ya ve el token nuevo:
    // el resultado es determinista sin necesitar un bucle de reintentos.
    const fetchMock = stubInstagramRefresh(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve(jsonResponse({ access_token: NEW_DB_TOKEN, expires_in: 100 })),
            5,
          ),
        ),
    );
    const slowerWait = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

    const [a, b] = await Promise.all([
      getUsableInstagramAccessToken(NOW, { sleep: slowerWait }),
      getUsableInstagramAccessToken(NOW, { sleep: slowerWait }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([a, b].sort()).toEqual([NEW_DB_TOKEN, NEW_DB_TOKEN]);
    expect(igFakeDb.rows.instagram.refresh_lock_until).toBeNull();
  });

  it("dos peticiones concurrentes: la que pierde el lease puede seguir usando el token todavía válido sin esperar a que la otra termine", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
    // El refresh "ganador" tarda más que la espera de la petición que pierde el lease:
    // esta última no debe bloquearse hasta que termine, sino servir el token actual
    // (todavía válido) tras su única relectura.
    const fetchMock = stubInstagramRefresh(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve(jsonResponse({ access_token: NEW_DB_TOKEN, expires_in: 100 })),
            50,
          ),
        ),
    );
    const fasterWait = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

    const [a, b] = await Promise.all([
      getUsableInstagramAccessToken(NOW, { sleep: fasterWait }),
      getUsableInstagramAccessToken(NOW, { sleep: fasterWait }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Una de las dos ganó el lease y devuelve el token nuevo; la otra, al releer antes
    // de que el refresh terminara, sigue sirviendo el token original (todavía válido).
    expect([a, b].sort()).toEqual([DB_TOKEN, NEW_DB_TOKEN].sort());
  });

  it("lease perdido: espera un turno corto, relee y usa el token que la otra petición ya renovó", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
      refresh_lock_until: new Date(NOW + 20_000).toISOString(),
    });
    const fetchMock = stubInstagramRefresh();
    // Durante la espera, la otra petición (dueña del lease) termina y guarda el nuevo.
    const original = igFakeDb.rows.instagram;
    const sleepAndFinish = async () => {
      igFakeDb.rows.instagram = {
        ...original,
        access_token: NEW_DB_TOKEN,
        access_token_expires_at: new Date(NOW + 60 * DAY).toISOString(),
        refresh_lock_until: null,
      };
    };

    const token = await getUsableInstagramAccessToken(NOW, { sleep: sleepAndFinish });

    expect(token).toBe(NEW_DB_TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lease perdido y la otra petición no terminó: se sigue usando el token original mientras sea válido", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
      refresh_lock_until: new Date(NOW + 20_000).toISOString(),
    });
    const fetchMock = stubInstagramRefresh();

    const token = await getUsableInstagramAccessToken(NOW, { sleep: noSleep });

    expect(token).toBe(DB_TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lease perdido y, tras la espera, el token original ya expiró → 503", async () => {
    igFakeDb.rows.instagram = igRow({
      // Vigente en el momento de la lectura inicial (por encima del margen duro), pero
      // la relectura tras la espera lo muestra ya vencido (otra petición lo consumió sin
      // renovarlo a tiempo, o el reloj avanzó lo suficiente).
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
      refresh_lock_until: new Date(NOW + 20_000).toISOString(),
    });
    stubInstagramRefresh();
    const original = igFakeDb.rows.instagram;
    const sleepAndExpire = async () => {
      igFakeDb.rows.instagram = {
        ...original,
        access_token_expires_at: new Date(NOW - 1000).toISOString(),
      };
    };

    const error = await getUsableInstagramAccessToken(NOW, {
      sleep: sleepAndExpire,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InstagramConnectionError);
    expect((error as InstagramConnectionError).reason).toBe("expired");
  });

  it("lease abandonado (dueño anterior murió a mitad) caduca solo y puede volver a tomarse", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
    expect(await acquireInstagramRefreshLease(DB_TOKEN, NOW)).toBe(true);
    // Todavía vigente (30 s): una segunda adquisición falla.
    expect(await acquireInstagramRefreshLease(DB_TOKEN, NOW + 10_000)).toBe(false);
    // Pasados los 30 s, el lease caducó solo y puede volver a tomarse.
    expect(await acquireInstagramRefreshLease(DB_TOKEN, NOW + 31_000)).toBe(true);
  });

  it("el lease es atómico: entre varias adquisiciones concurrentes solo una prospera", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
    const results = await Promise.all([
      acquireInstagramRefreshLease(DB_TOKEN, NOW),
      acquireInstagramRefreshLease(DB_TOKEN, NOW),
      acquireInstagramRefreshLease(DB_TOKEN, NOW),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("el lease nunca se condiciona por refresh_token (Instagram no lo usa)", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
    // Con un access_token que no coincide, la adquisición falla aunque el resto de la
    // fila sea idéntico: la condición es por access_token, no por otra columna.
    expect(await acquireInstagramRefreshLease("otro-token-cualquiera", NOW)).toBe(false);
  });

  it("TikTok permanece intacto: la renovación de Instagram nunca toca la fila de TikTok", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
    });
    igFakeDb.rows.tiktok = {
      provider: "tiktok",
      access_token: TIKTOK_TOKEN,
      refresh_token: "rft.ficticio",
    };
    stubInstagramRefresh();

    await getUsableInstagramAccessToken(NOW);

    expect(igFakeDb.rows.tiktok).toEqual({
      provider: "tiktok",
      access_token: TIKTOK_TOKEN,
      refresh_token: "rft.ficticio",
    });
  });

  it("ningún token (actual, renovado o de entorno) aparece en logs ante ningún fallo de renovación", async () => {
    const scenarios: (() => void)[] = [
      () => stubInstagramRefresh(() => jsonResponse({ error_type: "x" }, 400)),
      () =>
        stubInstagramRefresh(() => {
          throw new Error(`${DB_TOKEN}`);
        }),
      () => {
        igFakeDb.failOn["refresh-save"] = { code: "XX000", message: NEW_DB_TOKEN };
        stubInstagramRefresh();
      },
    ];
    for (const setup of scenarios) {
      resetIgFakeDb();
      vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_URL);
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
      vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", ENV_TOKEN);
      errorSpy.mockClear();
      igFakeDb.rows.instagram = igRow({
        access_token_expires_at: new Date(NOW + 3 * DAY).toISOString(),
      });
      setup();
      await getUsableInstagramAccessToken(NOW);
      expect(logged()).not.toContain(DB_TOKEN);
      expect(logged()).not.toContain(NEW_DB_TOKEN);
      expect(logged()).not.toContain(ENV_TOKEN);
    }
  });
});

// Fallback INSTAGRAM_ACCESS_TOKEN: la renovación automática de arriba SOLO existe para
// una conexión ya persistida. Estos casos (sin fila, o error de lectura) siguen
// resolviéndose exactamente como antes de introducir el auto-refresh.

describe("getUsableInstagramAccessToken: el fallback al env es ajeno a la renovación", () => {
  it("sin fila persistida, el env sigue funcionando sin tocar Meta", async () => {
    const fetchMock = stubInstagramRefresh();
    expect(await getUsableInstagramAccessToken(NOW)).toBe(ENV_TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("conexión persistida expirada nunca cae al fallback, aunque esté dentro de lo que sería el umbral de renovación", async () => {
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW - HOUR).toISOString(),
    });
    const fetchMock = stubInstagramRefresh();

    const error = await getUsableInstagramAccessToken(NOW).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InstagramConnectionError);
    expect((error as InstagramConnectionError).reason).toBe("expired");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("secretos", () => {
  it("ningún log ni error contiene tokens ni la service_role key", async () => {
    igFakeDb.failWith = {
      code: "42501",
      message: `${DB_TOKEN} ${ENV_TOKEN} ${SERVICE_ROLE_KEY}`,
      details: `${DB_TOKEN} ${SERVICE_ROLE_KEY}`,
    };
    const errors: unknown[] = [];

    await getUsableInstagramAccessToken(NOW); // fallback: se registra
    vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "");
    errors.push(await getUsableInstagramAccessToken(NOW).catch((e: unknown) => e));

    igFakeDb.failWith = undefined;
    igFakeDb.rows.instagram = igRow({
      access_token_expires_at: new Date(NOW - HOUR).toISOString(),
    });
    errors.push(await getUsableInstagramAccessToken(NOW).catch((e: unknown) => e));
    igFakeDb.rows.instagram = igRow({ access_token: "" });
    errors.push(await getUsableInstagramAccessToken(NOW).catch((e: unknown) => e));

    const everything = JSON.stringify([
      errorSpy.mock.calls,
      errors.map((e) => ({ name: (e as Error).name, message: (e as Error).message })),
    ]);
    for (const secret of [DB_TOKEN, ENV_TOKEN, SERVICE_ROLE_KEY, SUPABASE_URL]) {
      expect(everything).not.toContain(secret);
    }
  });
});

// Persistencia OAuth (Lote 3B): guardado de la conexión de Instagram tras un authorization
// code exchange exitoso. Independiente de la lectura de arriba: fija el contrato de
// saveInstagramConnection (upsert por proveedor, campos exactos, sin refresh_token, y que
// un fallo de escritura nunca destruye una conexión previa válida).

describe("saveInstagramConnection", () => {
  const tokenSet = (overrides: Partial<InstagramTokenSet> = {}): InstagramTokenSet => ({
    accessToken: "IGAA-token-largo-ficticio",
    providerUserId: "17841400000000000",
    expiresIn: 60 * 24 * 3600, // 60 días, como documenta Meta para el token largo
    scope: "instagram_business_basic,instagram_business_manage_comments",
    ...overrides,
  });

  it("guarda con upsert por proveedor y devuelve solo metadatos (sin el token)", async () => {
    const saved = await saveInstagramConnection(tokenSet(), NOW);

    expect(igFakeDb.upserts).toHaveLength(1);
    expect(igFakeDb.upserts[0].options).toEqual({ onConflict: "provider" });
    expect(igFakeDb.upserts[0].row).toMatchObject({
      provider: "instagram",
      provider_user_id: "17841400000000000",
      access_token: "IGAA-token-largo-ficticio",
      scope: "instagram_business_basic,instagram_business_manage_comments",
    });
    expect(saved).toEqual({
      providerUserId: "17841400000000000",
      accessTokenExpiresAt: new Date(NOW + 60 * 24 * HOUR).toISOString(),
    });
    expect(JSON.stringify(saved)).not.toContain("IGAA-token-largo-ficticio");
  });

  it("nunca envía refresh_token ni refresh_token_expires_at (Instagram no los usa)", async () => {
    await saveInstagramConnection(tokenSet(), NOW);

    const { row } = igFakeDb.upserts[0];
    expect(row).not.toHaveProperty("refresh_token");
    expect(row).not.toHaveProperty("refresh_token_expires_at");
  });

  it("calcula access_token_expires_at a partir de expiresIn", async () => {
    await saveInstagramConnection(tokenSet({ expiresIn: 3600 }), NOW);
    const { row } = igFakeDb.upserts[0];
    expect(row.access_token_expires_at).toBe(new Date(NOW + HOUR).toISOString());
    expect(row.updated_at).toBe(new Date(NOW).toISOString());
  });

  it("re-autorizar la misma cuenta actualiza la fila única (no duplica) y conserva created_at", async () => {
    await saveInstagramConnection(tokenSet(), NOW);
    await saveInstagramConnection(
      tokenSet({ accessToken: "IGAA-token-nuevo" }),
      NOW + 60_000,
    );

    expect(Object.keys(igFakeDb.rows)).toEqual(["instagram"]);
    expect(igFakeDb.rows.instagram.access_token).toBe("IGAA-token-nuevo");
    expect(igFakeDb.rows.instagram.created_at).toBe("primera-vez");
    for (const { row } of igFakeDb.upserts) expect(row).not.toHaveProperty("created_at");
  });

  it("una cuenta distinta reemplaza a la anterior (una sola conexión por proveedor)", async () => {
    await saveInstagramConnection(tokenSet({ providerUserId: "17841400000000001" }), NOW);
    await saveInstagramConnection(tokenSet({ providerUserId: "17841400000000002" }), NOW);

    expect(Object.keys(igFakeDb.rows)).toEqual(["instagram"]);
    expect(igFakeDb.rows.instagram.provider_user_id).toBe("17841400000000002");
  });

  it("la fila de TikTok nunca se toca al guardar Instagram", async () => {
    igFakeDb.rows.tiktok = { provider: "tiktok", access_token: TIKTOK_TOKEN };
    await saveInstagramConnection(tokenSet(), NOW);

    expect(igFakeDb.rows.tiktok).toEqual({
      provider: "tiktok",
      access_token: TIKTOK_TOKEN,
    });
    expect(igFakeDb.upserts.every((u) => u.row.provider === "instagram")).toBe(true);
  });

  it.each([
    ["accessToken vacío", { accessToken: "" }],
    ["providerUserId vacío", { providerUserId: "" }],
    ["providerUserId con letras", { providerUserId: "abc123" }],
    ["expiresIn cero", { expiresIn: 0 }],
    ["expiresIn negativo", { expiresIn: -10 }],
    ["expiresIn NaN", { expiresIn: NaN }],
  ])("entrada inválida (%s) → rechazada sin tocar Supabase", async (_name, override) => {
    await expect(
      saveInstagramConnection(tokenSet(override as Partial<InstagramTokenSet>), NOW),
    ).rejects.toThrow();
    expect(igFakeDb.upserts).toHaveLength(0);
    expect(igFakeDb.clients).toHaveLength(0);
  });

  it("Supabase sin configurar → 503 sin intentar el upsert", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

    const error = await saveInstagramConnection(tokenSet(), NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramStorageError);
    expect((error as InstagramStorageError).status).toBe(503);
    expect(igFakeDb.upserts).toHaveLength(0);
  });

  it("error de Supabase en el upsert se reduce a un código saneado y la fila anterior se conserva", async () => {
    igFakeDb.rows.instagram = igRow();
    igFakeDb.upsertFailWith = {
      code: "23505",
      message: `conflicto ${DB_TOKEN}`,
      details: SERVICE_ROLE_KEY,
    };

    const error = await saveInstagramConnection(
      tokenSet({ accessToken: "IGAA-token-que-no-se-guarda" }),
      NOW,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InstagramStorageError);
    expect((error as InstagramStorageError).code).toBe("23505");
    expect((error as Error).message).toBe("Error de almacenamiento (save)");
    // La fila previa sigue intacta: el fallo del upsert no la borró ni la sustituyó.
    expect(igFakeDb.rows.instagram.access_token).toBe(DB_TOKEN);
  });

  it("excepción de red en el upsert conserva la fila anterior y no filtra secretos", async () => {
    igFakeDb.rows.instagram = igRow();
    igFakeDb.upsertThrowWith = new Error(
      `fetch failed ${SUPABASE_URL} ${SERVICE_ROLE_KEY}`,
    );

    const error = await saveInstagramConnection(tokenSet(), NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramStorageError);
    expect(igFakeDb.rows.instagram.access_token).toBe(DB_TOKEN);
    expect((error as Error).message).not.toContain(SERVICE_ROLE_KEY);
    expect((error as Error).message).not.toContain(SUPABASE_URL);
  });
});

describe("assertInstagramStorageConfigured", () => {
  it("no lanza si Supabase está configurado", () => {
    expect(() => assertInstagramStorageConfigured()).not.toThrow();
  });

  it("lanza 503 si falta la service_role key, sin tocar la red", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(() => assertInstagramStorageConfigured()).toThrow(InstagramStorageError);
    expect(igFakeDb.clients).toHaveLength(0);
  });
});

// Consumo de un solo uso del state/nonce (Lote 3B.1): claimInstagramOAuthNonce debe ser
// la barrera real ante un callback repetido, sin depender de que Meta rechace un
// authorization code ya usado.

describe("claimInstagramOAuthNonce", () => {
  const NONCE = "un-nonce-de-prueba-ficticio";
  const EXPIRES_AT_MS = NOW + 10 * 60_000;

  it("primera reclamación de un nonce nuevo → 'claimed'", async () => {
    expect(await claimInstagramOAuthNonce(NONCE, EXPIRES_AT_MS, NOW)).toBe("claimed");
    expect(igFakeDb.nonceInserts).toHaveLength(1);
  });

  it("segunda reclamación del mismo nonce (repetición secuencial) → 'already_used'", async () => {
    expect(await claimInstagramOAuthNonce(NONCE, EXPIRES_AT_MS, NOW)).toBe("claimed");
    expect(await claimInstagramOAuthNonce(NONCE, EXPIRES_AT_MS, NOW)).toBe(
      "already_used",
    );
    // Solo una fila para este nonce, pase lo que pase.
    expect(Object.keys(igFakeDb.nonces)).toHaveLength(1);
  });

  it("dos reclamaciones concurrentes del mismo nonce: solo una gana", async () => {
    const results = await Promise.all([
      claimInstagramOAuthNonce(NONCE, EXPIRES_AT_MS, NOW),
      claimInstagramOAuthNonce(NONCE, EXPIRES_AT_MS, NOW),
    ]);

    expect(results.sort()).toEqual(["already_used", "claimed"]);
    expect(Object.keys(igFakeDb.nonces)).toHaveLength(1);
  });

  it("nonces distintos se reclaman de forma independiente", async () => {
    expect(await claimInstagramOAuthNonce("nonce-a", EXPIRES_AT_MS, NOW)).toBe("claimed");
    expect(await claimInstagramOAuthNonce("nonce-b", EXPIRES_AT_MS, NOW)).toBe("claimed");
    expect(Object.keys(igFakeDb.nonces)).toHaveLength(2);
  });

  it("Supabase sin configurar → 503 (fail-closed), sin intentar el insert", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

    const error = await claimInstagramOAuthNonce(NONCE, EXPIRES_AT_MS, NOW).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InstagramStorageError);
    expect((error as InstagramStorageError).status).toBe(503);
    expect(igFakeDb.nonceInserts).toHaveLength(0);
  });

  it("un fallo real de Supabase en el insert (no un choque de PK) → fail-closed, nunca 'claimed'", async () => {
    igFakeDb.nonceInsertFailWith = { code: "42501", message: "permission denied" };

    const error = await claimInstagramOAuthNonce(NONCE, EXPIRES_AT_MS, NOW).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InstagramStorageError);
    expect((error as InstagramStorageError).code).toBe("42501");
    expect((error as Error).message).toBe("Error de almacenamiento (claim-nonce)");
    // La tabla queda vacía: un fallo del mecanismo nunca deja el nonce marcado como usado
    // ni permite que el llamador crea que se reclamó.
    expect(Object.keys(igFakeDb.nonces)).toHaveLength(0);
  });

  it("una excepción de red en el insert también es fail-closed y no filtra secretos", async () => {
    igFakeDb.nonceInsertThrowWith = new Error(
      `fetch failed ${SUPABASE_URL} ${SERVICE_ROLE_KEY}`,
    );

    const error = await claimInstagramOAuthNonce(NONCE, EXPIRES_AT_MS, NOW).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InstagramStorageError);
    expect((error as Error).message).not.toContain(SUPABASE_URL);
    expect((error as Error).message).not.toContain(SERVICE_ROLE_KEY);
  });

  it("un fallo en la limpieza de expirados no impide reclamar (best effort)", async () => {
    // La limpieza usa .delete().lt(...), que en el fake nunca falla; este test documenta
    // el contrato: aunque fallara, no debe propagarse como error de la reclamación.
    expect(await claimInstagramOAuthNonce(NONCE, EXPIRES_AT_MS, NOW)).toBe("claimed");
  });

  it("solo se guarda el hash del nonce y su expiración: nunca el nonce en claro, el state completo ni ningún token", async () => {
    await claimInstagramOAuthNonce(NONCE, EXPIRES_AT_MS, NOW);

    expect(igFakeDb.nonceInserts).toHaveLength(1);
    const { row } = igFakeDb.nonceInserts[0];
    expect(Object.keys(row).sort()).toEqual(["expires_at", "nonce_hash"]);
    expect(row.nonce_hash).not.toBe(NONCE);
    expect(row.nonce_hash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 en hex
    expect(row.expires_at).toBe(new Date(EXPIRES_AT_MS).toISOString());
  });

  it("nonces con hash igual pero expires_at distinto siguen chocando por la PK (el hash es la clave, no la expiración)", async () => {
    expect(await claimInstagramOAuthNonce(NONCE, EXPIRES_AT_MS, NOW)).toBe("claimed");
    expect(await claimInstagramOAuthNonce(NONCE, EXPIRES_AT_MS + 60_000, NOW)).toBe(
      "already_used",
    );
  });
});
