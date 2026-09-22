import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InstagramConnectionError,
  InstagramConnectionFormatError,
  InstagramStorageError,
  getInstagramConnection,
  getUsableInstagramAccessToken,
} from "./instagram-connection";
import { igFakeDb, resetIgFakeDb } from "./instagram-supabase-fake";

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
  vi.restoreAllMocks();
});

const logged = () => JSON.stringify(errorSpy.mock.calls);

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
