import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import router from "../../api/admin/[action]";

// GET /api/admin/social-status (Bloque 8E). Se ejecutan el router, el handler y requireAdmin
// (autorización REAL: getClaims + admin_roles + aal2); solo el cliente de Supabase es un falso
// en memoria. El falso PROYECTA solo las columnas pedidas (como PostgREST), así se comprueba
// que el handler nunca solicita tokens ni datos de la cuenta.

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const MOD_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const DEV_ID = "55555555-5555-4555-8555-555555555555";

// El reloj de este archivo está fijado (ver NOW más abajo): los timestamps AMR se calculan contra él.
const TOKENS_NOW_SECONDS = Date.UTC(2026, 8, 25, 12, 0, 0) / 1000;

const TOKENS: Record<string, { sub: string; aal: string; amr?: unknown }> = {
  "jwt-admin-aal2": {
    sub: ADMIN_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: TOKENS_NOW_SECONDS }],
  },
  "jwt-admin-aal1": { sub: ADMIN_ID, aal: "aal1" },
  // 9G-1: aal2 pero el último TOTP venció (fuera de la ventana), o sin amr en absoluto.
  "jwt-admin-aal2-stale": {
    sub: ADMIN_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: TOKENS_NOW_SECONDS - 3600 }],
  },
  "jwt-admin-aal2-noamr": { sub: ADMIN_ID, aal: "aal2" },
  "jwt-moderator-aal2-stale": {
    sub: MOD_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: TOKENS_NOW_SECONDS - 3600 }],
  },
  "jwt-user-aal2-stale": {
    sub: USER_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: TOKENS_NOW_SECONDS - 3600 }],
  },
  "jwt-moderator-aal2": {
    sub: MOD_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: TOKENS_NOW_SECONDS }],
  },
  "jwt-developer-aal2": {
    sub: DEV_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: TOKENS_NOW_SECONDS }],
  },
  "jwt-user-aal2": {
    sub: USER_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: TOKENS_NOW_SECONDS }],
  },
};
const ROLES: Record<string, string> = {
  [ADMIN_ID]: "admin",
  [MOD_ID]: "moderator",
  [DEV_ID]: "developer",
};

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

const fake = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  rolesError: undefined as unknown,
  connectionsError: undefined as unknown,
  connectionsThrow: undefined as unknown,
  connectionsQueries: [] as { columns: string; providers: unknown }[],
  claimsCalls: 0,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      async getClaims(jwt: string) {
        fake.claimsCalls++;
        const claims = TOKENS[jwt];
        return claims
          ? { data: { claims }, error: null }
          : { data: null, error: { message: "jwt inválido" } };
      },
    },
    from: (table: string) => {
      if (table === "admin_roles") {
        return {
          select: () => {
            let userId = "";
            const builder = {
              eq(_c: string, value: string) {
                userId = value;
                return builder;
              },
              async maybeSingle() {
                if (fake.rolesError) return { data: null, error: fake.rolesError };
                const role = ROLES[userId];
                return { data: role ? { role } : null, error: null };
              },
            };
            return builder;
          },
        };
      }
      if (table === "social_connections") {
        return {
          select: (columns: string) => ({
            async in(_column: string, providers: string[]) {
              fake.connectionsQueries.push({ columns, providers });
              if (fake.connectionsThrow) throw fake.connectionsThrow;
              if (fake.connectionsError)
                return { data: null, error: fake.connectionsError };
              const wanted = columns.split(",").map((c) => c.trim());
              const data = fake.rows
                .filter((r) => providers.includes(String(r.provider)))
                .map((r) => Object.fromEntries(wanted.map((c) => [c, r[c]])));
              return { data, error: null };
            },
          }),
        };
      }
      throw new Error(`tabla inesperada: ${table}`);
    },
  }),
}));

interface Captured {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
}

function mockRes() {
  const state: Captured = { headers: {} };
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

function req(opts: { method?: string; token?: string | null; action?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token !== null)
    headers.authorization = `Bearer ${opts.token ?? "jwt-admin-aal2"}`;
  return {
    method: opts.method ?? "GET",
    headers,
    query: { action: opts.action ?? "social-status" },
  } as unknown as VercelRequest;
}

async function call(request: VercelRequest) {
  const { res, state } = mockRes();
  await router(request, res);
  return state;
}

/** Filas con TODAS las columnas de la tabla real, tokens incluidos. */
const igRow = (expiresInMs: number) => ({
  provider: "instagram",
  provider_user_id: "17841400000000000",
  access_token: "IGAA-token-ficticio-secreto",
  access_token_expires_at: iso(NOW + expiresInMs),
  refresh_token: null,
  refresh_token_expires_at: null,
  scope: "instagram_business_basic",
});
const ttRow = (refreshExpiresInMs: number, accessExpiresInMs = 3_600_000) => ({
  provider: "tiktok",
  provider_user_id: "open-id-ficticio",
  access_token: "act.token-ficticio-secreto",
  access_token_expires_at: iso(NOW + accessExpiresInMs),
  refresh_token: "rft.refresh-ficticio-secreto",
  refresh_token_expires_at: iso(NOW + refreshExpiresInMs),
  scope: "user.info.basic,video.list",
});

type Body = { connections: Record<"instagram" | "tiktok", { status: string }> };
const statuses = (state: Captured) => {
  const c = (state.body as Body).connections;
  return { instagram: c.instagram.status, tiktok: c.tiktok.status };
};

beforeEach(() => {
  fake.rows = [];
  fake.rolesError = undefined;
  fake.connectionsError = undefined;
  fake.connectionsThrow = undefined;
  fake.connectionsQueries = [];
  fake.claimsCalls = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key-ficticia");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-service-role-ficticia");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("autorización (requireCapability social_admin real)", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "%s → 405 + Allow: GET, antes de autenticar ni leer datos",
    async (method) => {
      const state = await call(req({ method }));
      expect(state.status).toBe(405);
      expect(state.headers.Allow).toBe("GET");
      expect(fake.claimsCalls).toBe(0);
      expect(fake.connectionsQueries).toHaveLength(0);
    },
  );

  it.each([
    { name: "sin Bearer", token: null, status: 401 },
    { name: "JWT inválido", token: "jwt-que-no-existe", status: 401 },
    { name: "USER (sin rol) con AAL2", token: "jwt-user-aal2", status: 403 },
    { name: "MODERATOR con AAL2", token: "jwt-moderator-aal2", status: 403 },
    { name: "DEVELOPER con AAL2", token: "jwt-developer-aal2", status: 403 },
    { name: "ADMIN con AAL1", token: "jwt-admin-aal1", status: 403 },
  ])("$name → $status, sin leer social_connections", async ({ token, status }) => {
    const state = await call(req({ token }));
    expect(state.status).toBe(status);
    expect(fake.connectionsQueries).toHaveLength(0);
    expect(JSON.stringify(state.body)).not.toContain("connections");
  });

  it("error de infraestructura al leer admin_roles → 500 genérico (nunca 'sin rol')", async () => {
    fake.rolesError = { code: "57014", message: "detalle interno de postgres" };
    const state = await call(req());
    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
    expect(fake.connectionsQueries).toHaveLength(0);
  });

  it("ADMIN con AAL2 → 200", async () => {
    expect((await call(req())).status).toBe(200);
  });

  it("una acción parecida sigue dando 404", async () => {
    expect((await call(req({ action: "social_status" }))).status).toBe(404);
  });
});

describe("estado de las conexiones", () => {
  it("ninguna conexión → ambas not_connected", async () => {
    const state = await call(req());
    expect(state.status).toBe(200);
    expect(statuses(state)).toEqual({
      instagram: "not_connected",
      tiktok: "not_connected",
    });
  });

  it("solo Instagram vigente → connected + not_connected", async () => {
    fake.rows = [igRow(30 * DAY)];
    expect(statuses(await call(req()))).toEqual({
      instagram: "connected",
      tiktok: "not_connected",
    });
  });

  it("solo TikTok vigente → not_connected + connected", async () => {
    fake.rows = [ttRow(300 * DAY)];
    expect(statuses(await call(req()))).toEqual({
      instagram: "not_connected",
      tiktok: "connected",
    });
  });

  it("ambas vigentes → connected + connected", async () => {
    fake.rows = [igRow(30 * DAY), ttRow(300 * DAY)];
    expect(statuses(await call(req()))).toEqual({
      instagram: "connected",
      tiktok: "connected",
    });
  });

  it("la fila de un proveedor nunca cuenta para el otro", async () => {
    fake.rows = [ttRow(300 * DAY)];
    expect((await call(req())).body).toEqual({
      connections: {
        instagram: { status: "not_connected" },
        tiktok: { status: "connected" },
      },
    });
  });

  it("Cache-Control: no-store", async () => {
    expect((await call(req())).headers["Cache-Control"]).toBe("no-store");
  });
});

describe("reauth_required (solo a partir de fechas absolutas persistidas)", () => {
  it("Instagram: access token caducado → reauth_required", async () => {
    fake.rows = [igRow(-DAY)];
    expect(statuses(await call(req())).instagram).toBe("reauth_required");
  });

  it("Instagram: a ≤ 60 s de caducar → reauth_required (misma regla que el feed); con 61 s → connected", async () => {
    fake.rows = [igRow(60_000)];
    expect(statuses(await call(req())).instagram).toBe("reauth_required");
    fake.rows = [igRow(61_000)];
    expect(statuses(await call(req())).instagram).toBe("connected");
  });

  it("TikTok: refresh token caducado → reauth_required; en el instante exacto también", async () => {
    fake.rows = [ttRow(-DAY)];
    expect(statuses(await call(req())).tiktok).toBe("reauth_required");
    fake.rows = [ttRow(0)];
    expect(statuses(await call(req())).tiktok).toBe("reauth_required");
  });

  it("TikTok: access token caducado pero refresh vigente → connected (se renueva solo)", async () => {
    fake.rows = [ttRow(300 * DAY, -3_600_000)];
    expect(statuses(await call(req())).tiktok).toBe("connected");
  });

  it("fecha de expiración ilegible o ausente → reauth_required (la conexión no es utilizable)", async () => {
    fake.rows = [
      { ...igRow(30 * DAY), access_token_expires_at: "no-es-una-fecha" },
      { ...ttRow(300 * DAY), refresh_token_expires_at: null },
    ];
    expect(statuses(await call(req()))).toEqual({
      instagram: "reauth_required",
      tiktok: "reauth_required",
    });
  });
});

describe("fail-closed y secretos", () => {
  it("error de Supabase al leer social_connections → 500 genérico, NUNCA 'not_connected'", async () => {
    fake.connectionsError = { code: "42501", message: "detalle interno" };
    const state = await call(req());
    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
    expect(JSON.stringify(state)).not.toContain("not_connected");
    expect(JSON.stringify(state)).not.toContain("detalle interno");
  });

  it("excepción del cliente (red) → 500 genérico", async () => {
    fake.connectionsThrow = new Error("ECONNRESET interno");
    const state = await call(req());
    expect(state.status).toBe(500);
    expect(JSON.stringify(state)).not.toContain("ECONNRESET");
  });

  it("sin configuración de Supabase → 500 genérico tras autenticar", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const state = await call(req());
    // requireAdmin ya falla por infraestructura (misma variable): 500 genérico.
    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
  });

  it("solo pide las columnas de expiración: nunca tokens, ids de cuenta ni scopes", async () => {
    fake.rows = [igRow(30 * DAY), ttRow(300 * DAY)];
    await call(req());
    expect(fake.connectionsQueries).toHaveLength(1);
    const columns = fake.connectionsQueries[0].columns.split(",").map((c) => c.trim());
    expect(columns.sort()).toEqual(
      ["access_token_expires_at", "provider", "refresh_token_expires_at"].sort(),
    );
    expect(fake.connectionsQueries[0].providers).toEqual(["instagram", "tiktok"]);
  });

  it("la respuesta contiene EXACTAMENTE {connections:{instagram:{status},tiktok:{status}}}, sin tokens ni datos de cuenta", async () => {
    fake.rows = [igRow(30 * DAY), ttRow(300 * DAY)];
    const state = await call(req());
    expect(Object.keys(state.body as object)).toEqual(["connections"]);
    const connections = (state.body as Body).connections;
    expect(Object.keys(connections).sort()).toEqual(["instagram", "tiktok"]);
    for (const provider of ["instagram", "tiktok"] as const) {
      expect(Object.keys(connections[provider])).toEqual(["status"]);
    }
    const wire = JSON.stringify(state);
    for (const secret of [
      "IGAA-token-ficticio-secreto",
      "act.token-ficticio-secreto",
      "rft.refresh-ficticio-secreto",
      "17841400000000000",
      "open-id-ficticio",
      "srk-service-role-ficticia",
      "jwt-admin-aal2",
      ADMIN_ID,
      "access_token",
      "refresh_token",
    ]) {
      expect(wire).not.toContain(secret);
    }
  });

  it("no registra nada en consola", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    fake.connectionsError = { code: "42501" };
    await call(req());
    fake.connectionsError = undefined;
    await call(req({ token: "jwt-user-aal2" }));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("9G-1 — MFA reciente: capacidad ANTES del step-up", () => {
  it.each([
    ["ADMIN aal2 con TOTP vencido", "jwt-admin-aal2-stale"],
    ["ADMIN aal2 sin amr", "jwt-admin-aal2-noamr"],
    ["ADMIN con aal1", "jwt-admin-aal1"],
  ])("%s → 403 step_up_required, sin leer social_connections", async (_n, token) => {
    const state = await call(req({ token }));
    expect(state.status).toBe(403);
    expect(state.body).toEqual({ error: "No autorizado", code: "step_up_required" });
    expect(fake.connectionsQueries).toHaveLength(0);
  });

  it.each([
    ["MODERATOR con MFA vencido", "jwt-moderator-aal2-stale"],
    ["USER con MFA vencido", "jwt-user-aal2-stale"],
    ["USER con aal2 y MFA reciente", "jwt-user-aal2"],
  ])("%s → 403 genérico SIN code", async (_n, token) => {
    const state = await call(req({ token }));
    expect(state.status).toBe(403);
    expect(state.body).toEqual({ error: "No autorizado" });
    expect(fake.connectionsQueries).toHaveLength(0);
  });
});
