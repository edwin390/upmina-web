import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import router from "../../api/admin/[action]";

// POST /api/admin/social-disconnect (Fase 9H-3). Se ejecutan el router, el handler y la
// autorización REAL (getClaims + admin_roles + capacidad social_admin + MFA reciente); solo el
// cliente de Supabase es un falso en memoria con un DELETE atómico. Sin red real.

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const MOD_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const DEV_ID = "55555555-5555-4555-8555-555555555555";
const REVOKED_ID = "66666666-6666-4666-8666-666666666666";

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const NOW_S = NOW / 1000;
const fresh = [{ method: "totp", timestamp: NOW_S }];
const stale = [{ method: "totp", timestamp: NOW_S - 3600 }];

const TOKENS: Record<string, { sub: string; aal: string; amr?: unknown }> = {
  "jwt-admin-fresh": { sub: ADMIN_ID, aal: "aal2", amr: fresh },
  "jwt-admin-stale": { sub: ADMIN_ID, aal: "aal2", amr: stale },
  "jwt-admin-noamr": { sub: ADMIN_ID, aal: "aal2" },
  "jwt-admin-aal1": { sub: ADMIN_ID, aal: "aal1" },
  "jwt-moderator-fresh": { sub: MOD_ID, aal: "aal2", amr: fresh },
  "jwt-moderator-stale": { sub: MOD_ID, aal: "aal2", amr: stale },
  "jwt-developer-fresh": { sub: DEV_ID, aal: "aal2", amr: fresh },
  "jwt-user-fresh": { sub: USER_ID, aal: "aal2", amr: fresh },
  "jwt-user-stale": { sub: USER_ID, aal: "aal2", amr: stale },
  // ADMIN revocado: el JWT sigue vigente pero admin_roles ya no tiene su fila.
  "jwt-revoked-fresh": { sub: REVOKED_ID, aal: "aal2", amr: fresh },
  "jwt-revoked-stale": { sub: REVOKED_ID, aal: "aal2", amr: stale },
};
const ROLES: Record<string, string> = {
  [ADMIN_ID]: "admin",
  [MOD_ID]: "moderator",
  [DEV_ID]: "developer",
};

const IG_TOKEN = "IGAA-token-ficticio-secreto";
const TT_ACCESS = "act.access-ficticio-secreto";
const TT_REFRESH = "rft.refresh-ficticio-secreto";
const SERVICE_ROLE = "srk-service-role-ficticia";
const CLIENT_SECRET = "cs-secreto-ficticio";

const db = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  deletes: [] as string[],
  upserts: 0,
  deleteError: undefined as unknown,
  deleteThrow: undefined as unknown,
  rolesError: undefined as unknown,
  claimsCalls: 0,
  // public.public_content_snapshots (9H-4): filas por resource, borrados pedidos (lista de
  // recursos) y cronología respecto del borrado de la conexión.
  snapshotRows: new Map<string, Record<string, unknown>>(),
  snapshotDeletes: [] as string[][],
  snapshotDeleteError: undefined as unknown,
  snapshotDeleteThrow: undefined as unknown,
  events: [] as string[],
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      async getClaims(jwt: string) {
        db.claimsCalls++;
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
                if (db.rolesError) return { data: null, error: db.rolesError };
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
          upsert: async () => {
            db.upserts++;
            return { error: null };
          },
          delete: () => {
            let provider = "";
            const builder = {
              eq(_c: string, value: string) {
                provider = value;
                return builder;
              },
              select(columns: string) {
                return {
                  then(
                    resolve: (v: unknown) => unknown,
                    reject: (e: unknown) => unknown,
                  ) {
                    return (async () => {
                      // Cede el turno: dos DELETE "simultáneos" se intercalan antes de mutar.
                      await Promise.resolve();
                      if (db.deleteThrow) throw db.deleteThrow;
                      db.deletes.push(provider);
                      db.events.push("connection-delete");
                      if (db.deleteError) return { data: null, error: db.deleteError };
                      const row = db.rows.get(provider);
                      if (!row) return { data: [], error: null };
                      db.rows.delete(provider); // check + mutación atómicos
                      const wanted = columns.split(",").map((c) => c.trim());
                      return {
                        data: [Object.fromEntries(wanted.map((c) => [c, row[c]]))],
                        error: null,
                      };
                    })().then(resolve, reject);
                  },
                };
              },
            };
            return builder;
          },
        };
      }
      if (table === "public_content_snapshots") {
        return {
          delete: () => ({
            in(_column: string, values: string[]) {
              return {
                abortSignal: () => ({
                  then(
                    resolve: (v: unknown) => unknown,
                    reject: (e: unknown) => unknown,
                  ) {
                    return (async () => {
                      await Promise.resolve();
                      db.events.push("snapshots-delete");
                      if (db.snapshotDeleteThrow) throw db.snapshotDeleteThrow;
                      db.snapshotDeletes.push([...values]);
                      if (db.snapshotDeleteError) {
                        return { error: db.snapshotDeleteError };
                      }
                      for (const key of [...db.snapshotRows.keys()]) {
                        if (values.includes(key)) db.snapshotRows.delete(key);
                      }
                      return { error: null };
                    })().then(resolve, reject);
                  },
                }),
              };
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

function req(
  opts: { method?: string; token?: string | null; body?: unknown; action?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.token !== null)
    headers.authorization = `Bearer ${opts.token ?? "jwt-admin-fresh"}`;
  return {
    method: opts.method ?? "POST",
    headers,
    body: "body" in opts ? opts.body : { provider: "instagram" },
    query: { action: opts.action ?? "social-disconnect" },
  } as unknown as VercelRequest;
}

async function call(request: VercelRequest) {
  const { res, state } = mockRes();
  await router(request, res);
  return state;
}

const igRow = () => ({
  provider: "instagram",
  provider_user_id: "17841400000000000",
  access_token: IG_TOKEN,
  access_token_expires_at: new Date(NOW + 30 * 86_400_000).toISOString(),
});
const ttRow = () => ({
  provider: "tiktok",
  provider_user_id: "open-id-ficticio",
  access_token: TT_ACCESS,
  refresh_token: TT_REFRESH,
  access_token_expires_at: new Date(NOW + 3_600_000).toISOString(),
  refresh_token_expires_at: new Date(NOW + 300 * 86_400_000).toISOString(),
});

let errorSpy: ReturnType<typeof vi.spyOn>;
let fetchMock: ReturnType<typeof vi.fn>;
const logged = () => JSON.stringify(errorSpy.mock.calls);

beforeEach(() => {
  db.rows = new Map([
    ["instagram", igRow()],
    ["tiktok", ttRow()],
  ]);
  db.deletes = [];
  db.upserts = 0;
  db.deleteError = undefined;
  db.deleteThrow = undefined;
  db.rolesError = undefined;
  db.claimsCalls = 0;
  db.snapshotRows = new Map();
  db.snapshotDeletes = [];
  db.snapshotDeleteError = undefined;
  db.snapshotDeleteThrow = undefined;
  db.events = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key-ficticia");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("TIKTOK_CLIENT_KEY", "ck-ficticio");
  vi.stubEnv("TIKTOK_CLIENT_SECRET", CLIENT_SECRET);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  fetchMock = vi.fn(async () => new Response("", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const untouched = () => {
  expect(db.deletes).toHaveLength(0);
  expect(db.rows.has("instagram")).toBe(true);
  expect(db.rows.has("tiktok")).toBe(true);
  // 9H-4: tampoco se limpian snapshots si no se llegó a desconectar.
  expect(db.snapshotDeletes).toHaveLength(0);
};

const ALL_SNAPSHOT_RESOURCES = [
  "twitch-clips",
  "twitch-latest-video",
  "youtube-latest",
  "youtube-videos",
  "youtube-shorts",
  "instagram-feed",
  "instagram-profile",
  "tiktok-videos",
];
const seedAllSnapshots = () => {
  for (const resource of ALL_SNAPSHOT_RESOURCES) {
    db.snapshotRows.set(resource, { resource, source_id: `origen-${resource}` });
  }
};

describe("autorización: orden y rechazos (nunca borra)", () => {
  it.each(["GET", "PUT", "PATCH", "DELETE"])(
    "%s → 405 + Allow: POST, antes de autenticar",
    async (method) => {
      const state = await call(req({ method }));
      expect(state.status).toBe(405);
      expect(state.headers.Allow).toBe("POST");
      expect(db.claimsCalls).toBe(0);
      untouched();
    },
  );

  it.each([
    { name: "anónimo (sin Bearer)", token: null },
    { name: "JWT inválido", token: "jwt-que-no-existe" },
  ])("$name → 401", async ({ token }) => {
    const state = await call(req({ token }));
    expect(state.status).toBe(401);
    untouched();
  });

  it.each([
    "jwt-user-fresh",
    "jwt-user-stale", // USER sin MFA reciente: 403 GENÉRICO, nunca step_up (MFA no concede permisos)
    "jwt-revoked-fresh",
    "jwt-revoked-stale", // ADMIN revocado con MFA vencido: genérico ANTES de MFA
    "jwt-moderator-fresh", // sin la capacidad social_admin aunque el MFA sea reciente
    "jwt-moderator-stale",
    "jwt-developer-fresh",
  ])("%s → 403 genérico (sin step_up_required) y no borra", async (token) => {
    const state = await call(req({ token }));
    expect(state.status).toBe(403);
    expect(JSON.stringify(state.body)).not.toContain("step_up_required");
    untouched();
  });

  it.each(["jwt-admin-stale", "jwt-admin-noamr", "jwt-admin-aal1"])(
    "ADMIN con MFA no reciente (%s) → 403 step_up_required y no borra",
    async (token) => {
      const state = await call(req({ token }));
      expect(state.status).toBe(403);
      expect((state.body as { code?: string }).code).toBe("step_up_required");
      untouched();
    },
  );

  it("error de infraestructura al leer admin_roles → 500 genérico (nunca 'sin rol') y no borra", async () => {
    db.rolesError = { code: "57014", message: "detalle interno de postgres" };
    const state = await call(req());
    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
    untouched();
  });

  it("ADMIN + social_admin + MFA reciente → puede proceder (200)", async () => {
    expect((await call(req())).status).toBe(200);
  });

  it("MFA reciente en el límite exacto de la ventana (1800 s) todavía autoriza; 1801 s no", async () => {
    TOKENS["jwt-edge"] = {
      sub: ADMIN_ID,
      aal: "aal2",
      amr: [{ method: "totp", timestamp: NOW_S - 1800 }],
    };
    TOKENS["jwt-edge-over"] = {
      sub: ADMIN_ID,
      aal: "aal2",
      amr: [{ method: "totp", timestamp: NOW_S - 1801 }],
    };
    expect((await call(req({ token: "jwt-edge" }))).status).toBe(200);
    db.rows.set("instagram", igRow());
    const over = await call(req({ token: "jwt-edge-over" }));
    expect(over.status).toBe(403);
    expect((over.body as { code?: string }).code).toBe("step_up_required");
  });
});

describe("validación del cuerpo y del entorno (tras autorizar)", () => {
  it.each([
    ["provider desconocido", { provider: "youtube" }],
    ["provider ausente", {}],
    ["provider no string", { provider: 5 }],
    ["campos extra", { provider: "instagram", extra: true }],
    ["array", [{ provider: "instagram" }]],
    ["null", null],
    ["string no JSON", "esto no es json"],
    ["prototype pollution", '{"provider":"instagram","__proto__":{"a":1}}'],
  ])("%s → 400 y no borra", async (_n, body) => {
    const state = await call(req({ body }));
    expect(state.status).toBe(400);
    expect(state.body).toEqual({ error: "Solicitud inválida" });
    untouched();
  });

  it("body como string JSON válido también se acepta", async () => {
    const state = await call(req({ body: JSON.stringify({ provider: "instagram" }) }));
    expect(state.status).toBe(200);
  });

  it.each(["preview", "development", ""])(
    "fuera de Production (VERCEL_ENV=%s) → 403 'No disponible en este entorno' y no borra",
    async (env) => {
      vi.stubEnv("VERCEL_ENV", env);
      const state = await call(req());
      expect(state.status).toBe(403);
      expect(state.body).toEqual({ error: "No disponible en este entorno" });
      untouched();
    },
  );

  it("el guard de entorno va DESPUÉS de la autorización: anónimo sigue siendo 401", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await call(req({ token: null }))).status).toBe(401);
  });
});

describe("desconexión de Instagram (solo local)", () => {
  it("borra la fila de Instagram, deja la de TikTok, y responde solo lo necesario", async () => {
    const state = await call(req({ body: { provider: "instagram" } }));

    expect(state.status).toBe(200);
    expect(state.body).toEqual({
      provider: "instagram",
      status: "not_connected",
      was_connected: true,
    });
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(db.rows.has("instagram")).toBe(false);
    expect(db.rows.has("tiktok")).toBe(true);
    expect(db.deletes).toEqual(["instagram"]);
  });

  it("no contacta a ningún proveedor (política LOCAL-ONLY) ni crea/restaura credenciales", async () => {
    await call(req({ body: { provider: "instagram" } }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.upserts).toBe(0);
  });

  it("ya desconectado → 200 idempotente con was_connected=false, sin efectos", async () => {
    db.rows.delete("instagram");

    const state = await call(req({ body: { provider: "instagram" } }));

    expect(state.status).toBe(200);
    expect(state.body).toEqual({
      provider: "instagram",
      status: "not_connected",
      was_connected: false,
    });
    expect(db.upserts).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dos desconexiones simultáneas: exactamente una tiene was_connected=true", async () => {
    const [a, b] = await Promise.all([
      call(req({ body: { provider: "instagram" } })),
      call(req({ body: { provider: "instagram" } })),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    const flags = [a, b].map((s) => (s.body as { was_connected: boolean }).was_connected);
    expect(flags.filter(Boolean)).toHaveLength(1);
    expect(db.rows.has("instagram")).toBe(false);
    expect(db.upserts).toBe(0);
  });

  it("la fila desaparece entre la confirmación y la operación → 200 idempotente", async () => {
    db.rows.delete("instagram");
    const state = await call(req({ body: { provider: "instagram" } }));
    expect((state.body as { was_connected: boolean }).was_connected).toBe(false);
  });
});

describe("desconexión de TikTok (local + revocación remota best effort)", () => {
  const tiktok = () => req({ body: { provider: "tiktok" } });
  const revokeCalls = () =>
    fetchMock.mock.calls.filter((c) => String(c[0]).includes("/v2/oauth/revoke/"));

  it("borra localmente y DESPUÉS revoca el access token en el endpoint documentado", async () => {
    const state = await call(tiktok());

    expect(state.status).toBe(200);
    expect(state.body).toEqual({
      provider: "tiktok",
      status: "not_connected",
      was_connected: true,
    });
    expect(db.rows.has("tiktok")).toBe(false);
    expect(db.rows.has("instagram")).toBe(true);
    expect(revokeCalls()).toHaveLength(1);
    const [url, init] = revokeCalls()[0] as [string, RequestInit];
    expect(url).toBe("https://open.tiktokapis.com/v2/oauth/revoke/");
    expect(init.method).toBe("POST");
    const body = init.body as URLSearchParams;
    expect(body.get("token")).toBe(TT_ACCESS);
    expect(body.get("client_key")).toBe("ck-ficticio");
    // Solo el access token viaja a TikTok; el refresh token no.
    expect(String(body)).not.toContain(TT_REFRESH);
  });

  it.each([
    ["HTTP 500", () => new Response("", { status: 500 })],
    ["HTTP 429", () => new Response("", { status: 429 })],
    [
      "error en el cuerpo",
      () => new Response(JSON.stringify({ error: "invalid_token" })),
    ],
    ["cuerpo no JSON", () => new Response("<html>", { status: 200 })],
    [
      "fallo de red",
      () => {
        throw new Error(`ECONNRESET ${TT_ACCESS} ${CLIENT_SECRET}`);
      },
    ],
  ])(
    "fallo de la revocación remota (%s): la desconexión LOCAL se mantiene, 200, log genérico",
    async (_n, respond) => {
      fetchMock.mockImplementation(async () => respond());

      const state = await call(tiktok());

      expect(state.status).toBe(200);
      expect((state.body as { was_connected: boolean }).was_connected).toBe(true);
      expect(db.rows.has("tiktok")).toBe(false);
      expect(logged()).toContain("revocación remota de TikTok no confirmada");
      expect(logged()).not.toContain(TT_ACCESS);
      expect(logged()).not.toContain(CLIENT_SECRET);
      expect(JSON.stringify(state)).not.toContain(TT_ACCESS);
    },
  );

  it("respuesta vacía de TikTok = éxito: no se registra ningún fallo", async () => {
    await call(tiktok());
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("sin credenciales de la app no se puede revocar: se desconecta localmente igualmente", async () => {
    vi.stubEnv("TIKTOK_CLIENT_SECRET", "");

    const state = await call(tiktok());

    expect(state.status).toBe(200);
    expect(db.rows.has("tiktok")).toBe(false);
    expect(revokeCalls()).toHaveLength(0);
  });

  it("ya desconectado → 200 idempotente y SIN llamar a TikTok", async () => {
    db.rows.delete("tiktok");

    const state = await call(tiktok());

    expect((state.body as { was_connected: boolean }).was_connected).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dos desconexiones simultáneas: una sola revocación remota", async () => {
    await Promise.all([call(tiktok()), call(tiktok())]);

    expect(revokeCalls()).toHaveLength(1);
    expect(db.rows.has("tiktok")).toBe(false);
  });

  it("la revocación lenta se corta por timeout (AbortSignal) sin bloquear el resultado", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    });

    const state = await call(tiktok());

    expect(state.status).toBe(200);
    expect(db.rows.has("tiktok")).toBe(false);
  });
});

describe("fallos de almacenamiento: nunca se afirma 'desconectado'", () => {
  it("error de Supabase en el DELETE → 500 genérico, la fila sigue, sin revocar", async () => {
    db.deleteError = { code: "57014", message: `detalle ${TT_ACCESS} ${SERVICE_ROLE}` };

    const state = await call(req({ body: { provider: "tiktok" } }));

    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
    expect(db.rows.has("tiktok")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(state)).not.toContain("57014");
  });

  it("excepción de red en el DELETE → 500 genérico sin filtrar el mensaje original", async () => {
    db.deleteThrow = new Error(`fetch failed ${SERVICE_ROLE}`);

    const state = await call(req({ body: { provider: "instagram" } }));

    expect(state.status).toBe(500);
    expect(JSON.stringify(state)).not.toContain(SERVICE_ROLE);
    expect(db.rows.has("instagram")).toBe(true);
  });

  it("Supabase sin configurar → 500 genérico (la autorización falla cerrada) y no borra", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

    const state = await call(req());

    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
    expect(db.deletes).toHaveLength(0);
  });
});

describe("limpieza de snapshots (9H-4): secundaria, acotada y nunca deshace la desconexión", () => {
  const instagram = () => req({ body: { provider: "instagram" } });
  const tiktok = () => req({ body: { provider: "tiktok" } });

  it("Instagram: borra SOLO instagram-feed e instagram-profile", async () => {
    seedAllSnapshots();
    const state = await call(instagram());

    expect(state.status).toBe(200);
    expect(db.snapshotDeletes).toEqual([["instagram-feed", "instagram-profile"]]);
    expect([...db.snapshotRows.keys()].sort()).toEqual(
      ALL_SNAPSHOT_RESOURCES.filter((r) => !r.startsWith("instagram")).sort(),
    );
  });

  it("TikTok: borra SOLO tiktok-videos", async () => {
    seedAllSnapshots();
    const state = await call(tiktok());

    expect(state.status).toBe(200);
    expect(db.snapshotDeletes).toEqual([["tiktok-videos"]]);
    expect([...db.snapshotRows.keys()].sort()).toEqual(
      ALL_SNAPSHOT_RESOURCES.filter((r) => r !== "tiktok-videos").sort(),
    );
  });

  it("el borrado de la conexión es PRIMERO (autoritativo), la limpieza después y la revocación de TikTok la última", async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes("/v2/oauth/revoke/")) db.events.push("revoke");
      return new Response("", { status: 200 });
    });
    await call(tiktok());

    expect(db.events).toEqual(["connection-delete", "snapshots-delete", "revoke"]);
  });

  it.each([
    [
      "error de Supabase",
      () => (db.snapshotDeleteError = { code: "57014", message: "detalle" }),
    ],
    [
      "excepción",
      () => (db.snapshotDeleteThrow = new Error(`fetch failed ${SERVICE_ROLE}`)),
    ],
  ])(
    "si la limpieza falla (%s) la desconexión sigue siendo efectiva y responde 200",
    async (_n, inject) => {
      seedAllSnapshots();
      inject();
      const state = await call(instagram());

      expect(state.status).toBe(200);
      expect(state.body).toEqual({
        provider: "instagram",
        status: "not_connected",
        was_connected: true,
      });
      // La conexión ya no existe: es lo que impide servir el snapshot que quedó.
      expect(db.rows.has("instagram")).toBe(false);
      expect(db.rows.has("tiktok")).toBe(true);
      expect(db.snapshotRows.has("instagram-feed")).toBe(true);
      expect(logged()).toContain("limpieza de snapshots no confirmada");
      expect(logged()).not.toContain(SERVICE_ROLE);
      expect(JSON.stringify(state)).not.toMatch(/snapshot/i);
    },
  );

  it("si la limpieza falla, TikTok igualmente se revoca y responde 200", async () => {
    db.snapshotDeleteError = { code: "57014" };
    const state = await call(tiktok());

    expect(state.status).toBe(200);
    expect(db.rows.has("tiktok")).toBe(false);
    expect(
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("/v2/oauth/revoke/")),
    ).toHaveLength(1);
  });

  it("si el borrado de la conexión NO se confirma, no se toca ningún snapshot (sigue conectado)", async () => {
    seedAllSnapshots();
    db.deleteError = { code: "57014" };
    const state = await call(instagram());

    expect(state.status).toBe(500);
    expect(db.rows.has("instagram")).toBe(true);
    expect(db.snapshotDeletes).toHaveLength(0);
    expect(db.snapshotRows.size).toBe(ALL_SNAPSHOT_RESOURCES.length);
  });

  it("la respuesta es idéntica con o sin snapshots (no revela nada de la limpieza)", async () => {
    const without = await call(instagram());
    db.rows.set("instagram", igRow());
    seedAllSnapshots();
    const withSnapshots = await call(instagram());

    expect(withSnapshots.body).toEqual(without.body);
    expect(withSnapshots.headers).toEqual(without.headers);
  });

  it("desconexión repetida: idempotente (was_connected=false) y vuelve a limpiar", async () => {
    seedAllSnapshots();
    const first = await call(instagram());
    // Un snapshot huérfano que una petición en vuelo escribió después de desconectar.
    db.snapshotRows.set("instagram-feed", {
      resource: "instagram-feed",
      source_id: "huerfano",
    });
    const second = await call(instagram());

    expect((first.body as { was_connected: boolean }).was_connected).toBe(true);
    expect(second.status).toBe(200);
    expect((second.body as { was_connected: boolean }).was_connected).toBe(false);
    expect(db.snapshotDeletes).toHaveLength(2);
    expect(db.snapshotRows.has("instagram-feed")).toBe(false);
  });

  it("dos desconexiones simultáneas: ambas 200 y los snapshots quedan borrados", async () => {
    seedAllSnapshots();
    const [a, b] = await Promise.all([call(tiktok()), call(tiktok())]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.snapshotRows.has("tiktok-videos")).toBe(false);
  });

  it.each([
    ["USER", "jwt-user-fresh"],
    ["MODERATOR (sin social_admin)", "jwt-moderator-fresh"],
    ["ADMIN revocado", "jwt-revoked-fresh"],
    ["ADMIN revocado con MFA vencido", "jwt-revoked-stale"],
    ["DEVELOPER", "jwt-developer-fresh"],
    ["anónimo", null],
  ])(
    "%s NO puede provocar la limpieza (falla antes de cualquier acción destructiva)",
    async (_n, token) => {
      seedAllSnapshots();
      const state = await call(req({ token }));

      expect(state.status).toBeGreaterThanOrEqual(401);
      expect(db.snapshotDeletes).toHaveLength(0);
      expect(db.snapshotRows.size).toBe(ALL_SNAPSHOT_RESOURCES.length);
      untouched();
    },
  );

  it("ADMIN sin MFA reciente recibe step_up_required ANTES de desconectar y no hay reproducción tras el MFA", async () => {
    seedAllSnapshots();
    const state = await call(req({ token: "jwt-admin-stale" }));

    expect(state.status).toBe(403);
    expect((state.body as { code?: string }).code).toBe("step_up_required");
    untouched();
    // Completar el MFA no reproduce nada: sin una nueva petición confirmada no hay borrado.
    expect(db.snapshotRows.size).toBe(ALL_SNAPSHOT_RESOURCES.length);
    expect(db.deletes).toHaveLength(0);
  });

  it("fuera de Production o con cuerpo inválido no se limpia nada", async () => {
    seedAllSnapshots();
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await call(instagram())).status).toBe(403);
    vi.stubEnv("VERCEL_ENV", "production");
    expect((await call(req({ body: { provider: "youtube" } }))).status).toBe(400);
    untouched();
  });
});

describe("secretos", () => {
  it("ninguna respuesta ni log contiene tokens, secretos ni la service_role key", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 500 }));
    const results = [
      await call(req({ body: { provider: "instagram" } })),
      await call(req({ body: { provider: "tiktok" } })),
      await call(req({ body: { provider: "tiktok" } })),
      await call(req({ token: "jwt-admin-stale" })),
    ];
    const everything = JSON.stringify([results, errorSpy.mock.calls]);
    for (const secret of [
      IG_TOKEN,
      TT_ACCESS,
      TT_REFRESH,
      CLIENT_SECRET,
      SERVICE_ROLE,
      "jwt-admin-fresh",
      ADMIN_ID,
    ]) {
      expect(everything).not.toContain(secret);
    }
  });
});
