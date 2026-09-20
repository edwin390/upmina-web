import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TikTokStorageError,
  assertTikTokStorageConfigured,
  getTikTokConnection,
  saveTikTokConnection,
} from "./tiktok-connection";
import type { TikTokTokenSet } from "./tiktok-shared";

// Fijan la capa de persistencia de la conexión TikTok: upsert por proveedor,
// expiraciones absolutas, lectura server-side y errores sin tokens.

// Tabla en memoria con la restricción única en `provider`, como la migración.
const store = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  upserts: [] as { row: Record<string, unknown>; options: unknown }[],
  failWith: undefined as unknown,
  throwWith: undefined as unknown,
  selectResult: undefined as unknown,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      upsert: async (row: Record<string, unknown>, options: unknown) => {
        if (store.throwWith) throw store.throwWith;
        store.upserts.push({ row, options });
        if (store.failWith) return { error: store.failWith };
        const provider = row.provider as string;
        const existing = store.rows.get(provider);
        // created_at solo se fija al insertar; en conflicto se actualiza el resto.
        store.rows.set(provider, {
          created_at: existing?.created_at ?? "primera-vez",
          ...existing,
          ...row,
        });
        return { error: null };
      },
      select: () => ({
        eq: (_column: string, provider: string) => ({
          maybeSingle: async () => {
            if (store.throwWith) throw store.throwWith;
            if (store.failWith) return { data: null, error: store.failWith };
            const data =
              store.selectResult !== undefined
                ? store.selectResult
                : (store.rows.get(provider) ?? null);
            return { data, error: null };
          },
        }),
      }),
    }),
  }),
}));

const ACCESS = "act.access-ficticio";
const REFRESH = "rft.refresh-ficticio";
const SUPABASE_URL = "https://proyecto-ficticio.supabase.co";
const SERVICE_ROLE_KEY = "srk-service-role-ficticia";
const NOW = Date.parse("2026-09-20T12:00:00.000Z");

function tokens(overrides: Partial<TikTokTokenSet> = {}): TikTokTokenSet {
  return {
    accessToken: ACCESS,
    refreshToken: REFRESH,
    openId: "open-id-1",
    expiresIn: 86400,
    refreshExpiresIn: 31536000,
    scope: "user.info.basic,video.list",
    ...overrides,
  };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  store.rows.clear();
  store.upserts.length = 0;
  store.failWith = undefined;
  store.throwWith = undefined;
  store.selectResult = undefined;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function catchError(fn: () => Promise<unknown>): Promise<TikTokStorageError> {
  try {
    await fn();
  } catch (err) {
    return err as TikTokStorageError;
  }
  throw new Error("se esperaba un error");
}

describe("saveTikTokConnection", () => {
  it("guarda con upsert por proveedor y devuelve solo metadatos (sin tokens)", async () => {
    const saved = await saveTikTokConnection(tokens(), NOW);

    expect(store.upserts).toHaveLength(1);
    expect(store.upserts[0].options).toEqual({ onConflict: "provider" });
    expect(store.upserts[0].row).toMatchObject({
      provider: "tiktok",
      provider_user_id: "open-id-1",
      access_token: ACCESS,
      refresh_token: REFRESH,
      scope: "user.info.basic,video.list",
    });
    expect(saved).toEqual({
      openId: "open-id-1",
      accessTokenExpiresAt: "2026-09-21T12:00:00.000Z",
      refreshTokenExpiresAt: "2027-09-20T12:00:00.000Z",
    });
    expect(JSON.stringify(saved)).not.toMatch(/act\.|rft\./);
  });

  it("calcula expiraciones absolutas a partir de expires_in / refresh_expires_in", async () => {
    await saveTikTokConnection(tokens({ expiresIn: 3600, refreshExpiresIn: 7200 }), NOW);
    const { row } = store.upserts[0];
    expect(row.access_token_expires_at).toBe("2026-09-20T13:00:00.000Z");
    expect(row.refresh_token_expires_at).toBe("2026-09-20T14:00:00.000Z");
    expect(row.updated_at).toBe("2026-09-20T12:00:00.000Z");
  });

  it("re-autorizar la misma cuenta actualiza la fila única (no duplica) y conserva created_at", async () => {
    await saveTikTokConnection(tokens(), NOW);
    await saveTikTokConnection(
      tokens({ accessToken: "act.nuevo", refreshToken: "rft.nuevo" }),
      NOW + 60_000,
    );

    expect(store.rows.size).toBe(1);
    const row = store.rows.get("tiktok")!;
    expect(row.access_token).toBe("act.nuevo");
    expect(row.refresh_token).toBe("rft.nuevo");
    expect(row.updated_at).toBe("2026-09-20T12:01:00.000Z");
    expect(row.created_at).toBe("primera-vez");
    // Nunca se envía created_at en el upsert.
    for (const { row: sent } of store.upserts)
      expect(sent).not.toHaveProperty("created_at");
  });

  it("otra cuenta de TikTok reemplaza a la anterior (una sola conexión por proveedor)", async () => {
    await saveTikTokConnection(tokens({ openId: "open-id-1" }), NOW);
    await saveTikTokConnection(tokens({ openId: "open-id-2" }), NOW);
    expect(store.rows.size).toBe(1);
    expect(store.rows.get("tiktok")!.provider_user_id).toBe("open-id-2");
  });

  it("error de Supabase → TikTokStorageError 500 con solo el código, sin tokens", async () => {
    store.failWith = {
      code: "23505",
      message: `duplicate key value ${ACCESS} ${REFRESH}`,
      details: `Key (refresh_token)=(${REFRESH})`,
    };

    const err = await catchError(() => saveTikTokConnection(tokens(), NOW));

    expect(err).toBeInstanceOf(TikTokStorageError);
    expect(err.status).toBe(500);
    expect(err.code).toBe("23505");
    const everything = JSON.stringify([err.message, err.code, errorSpy.mock.calls]);
    expect(everything).not.toMatch(/act\.|rft\.|duplicate/);
  });

  it("un código de error con forma sospechosa se descarta", async () => {
    store.failWith = { code: `x ${ACCESS}\nFAKE`, message: "boom" };
    const err = await catchError(() => saveTikTokConnection(tokens(), NOW));
    expect(err.code).toBeUndefined();
    expect(JSON.stringify([err.message, err.code])).not.toContain(ACCESS);
  });

  it("excepción de red del cliente → TikTokStorageError sin filtrar el mensaje original", async () => {
    store.throwWith = new TypeError(`fetch failed ${ACCESS} ${SERVICE_ROLE_KEY}`);
    const err = await catchError(() => saveTikTokConnection(tokens(), NOW));
    expect(err).toBeInstanceOf(TikTokStorageError);
    expect(JSON.stringify([err.message, err.code])).not.toMatch(/act\.|srk-/);
  });

  it("503 sin URL o sin service_role key, sin nombrar valores", async () => {
    for (const name of ["VITE_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
      vi.stubEnv(name, "");
      const err = await catchError(() => saveTikTokConnection(tokens(), NOW));
      expect(err.status).toBe(503);
      expect(() => assertTikTokStorageConfigured()).toThrow(TikTokStorageError);
      expect(err.message).not.toContain(SERVICE_ROLE_KEY);
      vi.stubEnv(name, name === "VITE_SUPABASE_URL" ? SUPABASE_URL : SERVICE_ROLE_KEY);
    }
    expect(store.upserts).toHaveLength(0);
  });

  it("assertTikTokStorageConfigured no lanza con la configuración presente", () => {
    expect(() => assertTikTokStorageConfigured()).not.toThrow();
  });
});

describe("getTikTokConnection", () => {
  it("devuelve la conexión guardada (con tokens, solo para servidor)", async () => {
    await saveTikTokConnection(tokens(), NOW);
    expect(await getTikTokConnection()).toEqual({
      openId: "open-id-1",
      accessToken: ACCESS,
      refreshToken: REFRESH,
      accessTokenExpiresAt: "2026-09-21T12:00:00.000Z",
      refreshTokenExpiresAt: "2027-09-20T12:00:00.000Z",
      scope: "user.info.basic,video.list",
    });
  });

  it("devuelve null si todavía no hay ninguna cuenta autorizada", async () => {
    expect(await getTikTokConnection()).toBeNull();
  });

  it("error de lectura → TikTokStorageError sin tokens; fila con formato inválido → error", async () => {
    store.failWith = { code: "PGRST301", message: `jwt ${ACCESS}` };
    let err = await catchError(() => getTikTokConnection());
    expect(err).toBeInstanceOf(TikTokStorageError);
    expect(err.code).toBe("PGRST301");
    expect(JSON.stringify([err.message, err.code])).not.toContain(ACCESS);

    store.failWith = undefined;
    store.selectResult = { provider_user_id: "x", access_token: 1 };
    err = await catchError(() => getTikTokConnection());
    expect(err).toBeInstanceOf(TikTokStorageError);
  });

  it("503 sin configuración", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const err = await catchError(() => getTikTokConnection());
    expect(err.status).toBe(503);
  });
});
