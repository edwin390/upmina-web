import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleAdminActivate, handleAdminMe } from "./admin-handlers";
import { AdminAuthError, AdminAuthInfrastructureError } from "./admin-auth";

// Fija el contrato de seguridad de POST /api/admin/activate (Bloque 2C): consumir una
// admin_invitations bootstrap y conceder el rol vía la RPC atómica
// consume_admin_invitation (ver supabase/migrations/20260923120000_admin_invitations.sql),
// SIEMPRE con el user_id que viene del JWT ya verificado, nunca del body. No repite las
// pruebas de requireAuthenticated en sí (ya cubiertas por admin-auth.test.ts): aquí solo
// importa cómo handleAdminActivate reacciona a lo que ese helper devuelve/lanza, y cómo
// arma la llamada a la RPC.

const SUPABASE_URL = "https://proyecto.supabase.co";
const SERVICE_ROLE_KEY = "service-role-key-de-prueba";

// Token sintético con la MISMA forma que produce generateBootstrapToken() en
// scripts/lib/admin-bootstrap-invitation.mjs: randomBytes(32).toString("base64url").
// Nunca un secreto real ni derivado de una invitación real.
const VALID_TOKEN = randomBytes(32).toString("base64url");
const VALID_TOKEN_HASH = createHash("sha256").update(VALID_TOKEN).digest("hex");

const authFakes = vi.hoisted(() => ({
  /** Identidad que devuelve requireAuthenticated, o undefined para usar throwWith. */
  identity: undefined as { userId: string; aal: string } | undefined,
  /** Si está definido, requireAuthenticated lanza esto en vez de devolver identity. */
  throwWith: undefined as unknown,
  calls: 0,
}));

// Fakes independientes de requireAdmin, usados solo por los tests de handleAdminMe (más
// abajo): handleAdminMe llama a requireAdmin directamente, no a requireAuthenticated, así
// que reutilizar authFakes mezclaría dos contratos distintos.
const adminFakes = vi.hoisted(() => ({
  /** Valor que devuelve requireAdmin, o undefined para usar throwWith. */
  identity: undefined as { userId: string } | undefined,
  /** Si está definido, requireAdmin lanza esto en vez de devolver identity. */
  throwWith: undefined as unknown,
  calls: 0,
}));

vi.mock("./admin-auth", async () => {
  const actual = await vi.importActual<typeof import("./admin-auth")>("./admin-auth");
  return {
    ...actual,
    requireAuthenticated: vi.fn(async () => {
      authFakes.calls++;
      if (authFakes.throwWith !== undefined) throw authFakes.throwWith;
      if (!authFakes.identity) {
        throw new Error("test mal configurado: falta authFakes.identity");
      }
      return authFakes.identity;
    }),
    requireAdmin: vi.fn(async () => {
      adminFakes.calls++;
      if (adminFakes.throwWith !== undefined) throw adminFakes.throwWith;
      if (!adminFakes.identity) {
        throw new Error("test mal configurado: falta adminFakes.identity");
      }
      return adminFakes.identity;
    }),
  };
});

const rpcFakes = vi.hoisted(() => ({
  /** { data, error } que devuelve rpc(), o undefined para usar el default. */
  result: undefined as { data: unknown; error: unknown } | undefined,
  /** Si está definido, rpc() lanza esto en vez de devolver un resultado. */
  throwWith: undefined as unknown,
  calls: [] as { name: string; params: unknown }[],
}));

const clientFakes = vi.hoisted(() => ({
  /** Cada createClient(url, key) real: permite comprobar qué key usó el cliente RPC. */
  calls: [] as { url: string; key: string }[],
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (url: string, key: string) => {
    clientFakes.calls.push({ url, key });
    return {
      rpc: async (name: string, params: unknown) => {
        rpcFakes.calls.push({ name, params });
        if (rpcFakes.throwWith !== undefined) throw rpcFakes.throwWith;
        return rpcFakes.result ?? { data: null, error: { message: "sin configurar" } };
      },
    };
  },
}));

function resetFakes() {
  authFakes.identity = undefined;
  authFakes.throwWith = undefined;
  authFakes.calls = 0;
  rpcFakes.result = undefined;
  rpcFakes.throwWith = undefined;
  rpcFakes.calls = [];
  clientFakes.calls = [];
  adminFakes.identity = undefined;
  adminFakes.throwWith = undefined;
  adminFakes.calls = 0;
}

function okIdentity(overrides: Partial<{ userId: string; aal: string }> = {}) {
  authFakes.identity = {
    userId: "11111111-1111-4111-8111-111111111111",
    aal: "aal2",
    ...overrides,
  };
}

function okRpc(grantedRole: "admin" | "moderator" = "admin") {
  rpcFakes.result = { data: [{ granted_role: grantedRole }], error: null };
}

function req(overrides: Partial<VercelRequest> = {}): VercelRequest {
  return {
    method: "POST",
    headers: { authorization: "Bearer un-jwt-cualquiera" },
    query: {},
    body: { token: VALID_TOKEN },
    ...overrides,
  } as unknown as VercelRequest;
}

function mockRes() {
  const state: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
    setHeader(key: string, value: string) {
      state.headers[key] = value;
      return res;
    },
  };
  return { res: res as unknown as VercelResponse, state };
}

beforeEach(() => {
  resetFakes();
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("handleAdminActivate", () => {
  it("método distinto de POST → 405, no autentica ni llama a la RPC", async () => {
    const { res, state } = mockRes();

    await handleAdminActivate(req({ method: "GET" }), res);

    expect(state.status).toBe(405);
    expect(state.headers.Allow).toBe("POST");
    expect(authFakes.calls).toBe(0);
    expect(rpcFakes.calls).toHaveLength(0);
  });

  it("Authorization ausente → 401 (propagado desde requireAuthenticated), sin llamar a la RPC", async () => {
    authFakes.throwWith = new AdminAuthError("No autenticado", 401);
    const { res, state } = mockRes();

    await handleAdminActivate(req(), res);

    expect(state.status).toBe(401);
    expect(rpcFakes.calls).toHaveLength(0);
  });

  it("JWT inválido → 401, sin llamar a la RPC", async () => {
    authFakes.throwWith = new AdminAuthError("No autenticado", 401);
    const { res, state } = mockRes();

    await handleAdminActivate(req({ headers: { authorization: "Bearer roto" } }), res);

    expect(state.status).toBe(401);
    expect(rpcFakes.calls).toHaveLength(0);
  });

  it("sesión aal1 → 403, sin llamar a la RPC (bootstrap exige aal2, no solo un rol reconocido)", async () => {
    okIdentity({ aal: "aal1" });
    const { res, state } = mockRes();

    await handleAdminActivate(req(), res);

    expect(state.status).toBe(403);
    expect(rpcFakes.calls).toHaveLength(0);
  });

  it("sesión aal2 con token válido → 200 y llama a la RPC", async () => {
    okIdentity({ aal: "aal2" });
    okRpc("admin");
    const { res, state } = mockRes();

    await handleAdminActivate(req(), res);

    expect(state.status).toBe(200);
    expect(rpcFakes.calls).toHaveLength(1);
  });

  it("body ausente → 400, sin autenticar de más ni llamar a la RPC", async () => {
    okIdentity();
    const { res, state } = mockRes();

    await handleAdminActivate(req({ body: undefined }), res);

    expect(state.status).toBe(400);
    expect(rpcFakes.calls).toHaveLength(0);
  });

  it("body malformado (no es un objeto) → 400, sin llamar a la RPC", async () => {
    okIdentity();
    const { res, state } = mockRes();

    await handleAdminActivate(req({ body: "no-soy-json" }), res);

    expect(state.status).toBe(400);
    expect(rpcFakes.calls).toHaveLength(0);
  });

  it("body string con JSON inválido → 400 (no se trata como infraestructura)", async () => {
    okIdentity();
    const { res, state } = mockRes();

    await handleAdminActivate(req({ body: "{token: sin-comillas}" }), res);

    expect(state.status).toBe(400);
    expect(rpcFakes.calls).toHaveLength(0);
  });

  it("token ausente → 400, sin llamar a la RPC", async () => {
    okIdentity();
    const { res, state } = mockRes();

    await handleAdminActivate(req({ body: {} }), res);

    expect(state.status).toBe(400);
    expect(rpcFakes.calls).toHaveLength(0);
  });

  it.each([
    ["demasiado corto", VALID_TOKEN.slice(0, 40)],
    ["con padding '='", `${VALID_TOKEN.slice(0, 42)}=`],
    ["con caracteres base64 no-url ('+' y '/')", `${"+".repeat(21)}/${"a".repeat(21)}`],
    ["no es un string", 12345],
    ["vacío", ""],
  ])(
    "token de formato inválido (%s) → 400, sin llamar a la RPC",
    async (_label, token) => {
      okIdentity();
      const { res, state } = mockRes();

      await handleAdminActivate(req({ body: { token } }), res);

      expect(state.status).toBe(400);
      expect(rpcFakes.calls).toHaveLength(0);
    },
  );

  it("hashea el token con SHA-256 antes de llamar a la RPC, y llama exactamente con p_token_hash + p_user_id del JWT", async () => {
    okIdentity({ userId: "22222222-2222-4222-8222-222222222222" });
    okRpc("admin");
    const { res } = mockRes();

    await handleAdminActivate(req({ body: { token: VALID_TOKEN } }), res);

    expect(rpcFakes.calls).toHaveLength(1);
    expect(rpcFakes.calls[0].name).toBe("consume_admin_invitation");
    expect(rpcFakes.calls[0].params).toEqual({
      p_token_hash: VALID_TOKEN_HASH,
      p_user_id: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("un userId enviado en el body nunca controla la RPC: solo cuenta el del JWT verificado", async () => {
    okIdentity({ userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    okRpc("admin");
    const { res } = mockRes();

    await handleAdminActivate(
      req({
        body: {
          token: VALID_TOKEN,
          userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          user_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        },
      }),
      res,
    );

    expect(rpcFakes.calls[0].params).toMatchObject({
      p_user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
  });

  it("un role enviado en el body nunca llega a la RPC (solo token_hash y user_id)", async () => {
    okIdentity();
    okRpc("admin");
    const { res } = mockRes();

    await handleAdminActivate(
      req({ body: { token: VALID_TOKEN, role: "admin", invitation_type: "standard" } }),
      res,
    );

    expect(Object.keys(rpcFakes.calls[0].params as object)).toEqual([
      "p_token_hash",
      "p_user_id",
    ]);
  });

  it.each([
    "invitation_not_found",
    "invitation_already_consumed",
    "invitation_expired",
    "admin_already_exists",
  ])(
    "rechazo de negocio reconocido de la RPC (code P0001, message=%s) → 400 genérico, nunca el texto de Postgres",
    async (message) => {
      okIdentity();
      rpcFakes.result = { data: null, error: { message, code: "P0001" } };
      const { res, state } = mockRes();

      await handleAdminActivate(req(), res);

      expect(state.status).toBe(400);
      expect(state.body).toEqual({ error: "No se pudo activar la invitación" });
      expect(JSON.stringify(state.body)).not.toMatch(
        /consumed|expired|not_found|already_exists|P0001/,
      );
    },
  );

  it("error RPC desconocido (code P0001 pero message fuera de la lista cerrada) → 500 genérico, fail closed, nunca el texto de Postgres", async () => {
    okIdentity();
    rpcFakes.result = {
      data: null,
      error: { message: "algo_que_la_migracion_actual_nunca_lanza", code: "P0001" },
    };
    const { res, state } = mockRes();

    await handleAdminActivate(req(), res);

    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
    expect(JSON.stringify(state.body)).not.toMatch(/algo_que_la_migracion/);
  });

  it("error RPC desconocido (message reconocido pero code distinto de P0001) → 500 genérico, fail closed", async () => {
    okIdentity();
    rpcFakes.result = {
      data: null,
      error: { message: "invitation_expired", code: "57014" },
    };
    const { res, state } = mockRes();

    await handleAdminActivate(req(), res);

    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
  });

  it("error RPC real de infraestructura (permiso/columna/red, sin relación con el rechazo de negocio) → 500 genérico, nunca details/hint/code", async () => {
    okIdentity();
    rpcFakes.result = {
      data: null,
      error: {
        message: "permission denied for table admin_invitations",
        code: "42501",
        details: "detalle interno de Postgres",
        hint: "revisa los GRANT",
      },
    };
    const { res, state } = mockRes();

    await handleAdminActivate(req(), res);

    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
    expect(JSON.stringify(state.body)).not.toMatch(
      /permission denied|42501|detalle interno|GRANT/,
    );
  });

  it("error RPC sin forma reconocible (no es un objeto) → 500 genérico, fail closed", async () => {
    okIdentity();
    rpcFakes.result = { data: null, error: "fallo string plano, sin code/message" };
    const { res, state } = mockRes();

    await handleAdminActivate(req(), res);

    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
  });

  it("fallo real de infraestructura (rpc() lanza) → 5xx genérico, sin filtrar detalles", async () => {
    okIdentity();
    rpcFakes.throwWith = new Error("ECONNRESET: fallo de red hacia Supabase");
    const { res, state } = mockRes();

    await handleAdminActivate(req(), res);

    expect(state.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(state.body)).not.toMatch(/ECONNRESET|Supabase/);
  });

  it("requireAuthenticated lanza AdminAuthInfrastructureError → 5xx genérico, sin filtrar detalles", async () => {
    authFakes.throwWith = new AdminAuthInfrastructureError(
      "Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY",
    );
    const { res, state } = mockRes();

    await handleAdminActivate(req(), res);

    expect(state.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(state.body)).not.toMatch(/VITE_SUPABASE/);
  });

  it("RPC responde sin error pero con forma inesperada → 5xx genérico (no se trata como éxito)", async () => {
    okIdentity();
    rpcFakes.result = { data: [{ algo: "inesperado" }], error: null };
    const { res, state } = mockRes();

    await handleAdminActivate(req(), res);

    expect(state.status).toBeGreaterThanOrEqual(500);
  });

  it("faltan credenciales service_role → 5xx genérico, sin llamar a createClient con claves vacías", async () => {
    okIdentity();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const { res, state } = mockRes();

    await handleAdminActivate(req(), res);

    expect(state.status).toBeGreaterThanOrEqual(500);
    expect(rpcFakes.calls).toHaveLength(0);
  });

  it("crea el cliente service_role únicamente con SUPABASE_SERVICE_ROLE_KEY (nunca la anon key), y solo después de validar el input", async () => {
    okIdentity();
    okRpc("admin");
    const { res } = mockRes();

    await handleAdminActivate(req(), res);

    expect(clientFakes.calls).toHaveLength(1);
    expect(clientFakes.calls[0]).toEqual({ url: SUPABASE_URL, key: SERVICE_ROLE_KEY });
  });

  it("token inválido → nunca se crea el cliente service_role (input se valida antes)", async () => {
    okIdentity();
    const { res } = mockRes();

    await handleAdminActivate(req({ body: { token: "demasiado-corto" } }), res);

    expect(clientFakes.calls).toHaveLength(0);
  });

  it("aal1 → nunca se crea el cliente service_role (autorización se exige antes que cualquier acceso a datos)", async () => {
    okIdentity({ aal: "aal1" });
    const { res } = mockRes();

    await handleAdminActivate(req(), res);

    expect(clientFakes.calls).toHaveLength(0);
  });

  it("éxito devuelve únicamente el rol concedido, nunca el token/hash/JWT ni detalles internos", async () => {
    okIdentity();
    okRpc("moderator");
    const { res, state } = mockRes();

    await handleAdminActivate(req(), res);

    expect(state.status).toBe(200);
    expect(state.body).toEqual({ role: "moderator" });
    expect(JSON.stringify(state.body)).not.toContain(VALID_TOKEN);
    expect(JSON.stringify(state.body)).not.toContain(VALID_TOKEN_HASH);
  });

  it("ninguna respuesta (éxito o error) contiene el token, su hash o el JWT recibido", async () => {
    okIdentity();
    okRpc("admin");
    const cases: { setup: () => void; request: VercelRequest }[] = [
      { setup: () => {}, request: req() },
      {
        setup: () => {
          rpcFakes.result = { data: null, error: { message: "invitation_expired" } };
        },
        request: req(),
      },
      {
        setup: () => {
          rpcFakes.throwWith = new Error("fallo interno con el token " + VALID_TOKEN);
        },
        request: req(),
      },
    ];

    for (const { setup, request } of cases) {
      resetFakes();
      okIdentity();
      okRpc("admin");
      setup();
      const { res, state } = mockRes();
      await handleAdminActivate(request, res);
      const serialized = JSON.stringify(state.body);
      expect(serialized).not.toContain(VALID_TOKEN);
      expect(serialized).not.toContain(VALID_TOKEN_HASH);
      expect(serialized).not.toContain("un-jwt-cualquiera");
    }
  });
});

// Fija el contrato de seguridad de GET /api/admin/me (Bloque 5A): primera comprobación
// server-side de la identidad administrativa actual. Deliberadamente NO repite las
// pruebas de requireAdmin/requirePrivileged/requireAuthenticated en sí (ya cubiertas por
// admin-auth.test.ts): aquí solo importa cómo handleAdminMe reacciona a lo que
// requireAdmin devuelve/lanza, y qué expone la respuesta 200.
function meReq(overrides: Partial<VercelRequest> = {}): VercelRequest {
  return {
    method: "GET",
    headers: { authorization: "Bearer un-jwt-cualquiera" },
    query: {},
    ...overrides,
  } as unknown as VercelRequest;
}

describe("handleAdminMe", () => {
  it("GET + ADMIN + aal2 (requireAdmin resuelve) → 200 { role: 'admin' }", async () => {
    adminFakes.identity = { userId: "11111111-1111-4111-8111-111111111111" };
    const { res, state } = mockRes();

    await handleAdminMe(meReq(), res);

    expect(state.status).toBe(200);
    expect(state.body).toEqual({ role: "admin" });
  });

  it("sin Bearer (requireAdmin lanza 401) → 401", async () => {
    adminFakes.throwWith = new AdminAuthError("No autenticado", 401);
    const { res, state } = mockRes();

    await handleAdminMe(meReq({ headers: {} }), res);

    expect(state.status).toBe(401);
  });

  it("JWT inválido (requireAdmin lanza 401) → 401", async () => {
    adminFakes.throwWith = new AdminAuthError("No autenticado", 401);
    const { res, state } = mockRes();

    await handleAdminMe(meReq({ headers: { authorization: "Bearer roto" } }), res);

    expect(state.status).toBe(401);
  });

  it("ADMIN con aal1 (requireAdmin lanza 403) → 403", async () => {
    adminFakes.throwWith = new AdminAuthError("No autorizado", 403);
    const { res, state } = mockRes();

    await handleAdminMe(meReq(), res);

    expect(state.status).toBe(403);
  });

  it("USER sin fila en admin_roles, aal2 (requireAdmin lanza 403) → 403", async () => {
    adminFakes.throwWith = new AdminAuthError("No autorizado", 403);
    const { res, state } = mockRes();

    await handleAdminMe(meReq(), res);

    expect(state.status).toBe(403);
  });

  it("MODERATOR con aal2 (requireAdmin lanza 403: no hereda ADMIN) → 403", async () => {
    adminFakes.throwWith = new AdminAuthError("No autorizado", 403);
    const { res, state } = mockRes();

    await handleAdminMe(meReq(), res);

    expect(state.status).toBe(403);
  });

  it("fallo de infraestructura (requireAdmin lanza AdminAuthInfrastructureError) → 500 genérico, sin filtrar detalles", async () => {
    adminFakes.throwWith = new AdminAuthInfrastructureError(
      "Faltan VITE_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY",
    );
    const { res, state } = mockRes();

    await handleAdminMe(meReq(), res);

    expect(state.status).toBe(500);
    expect(JSON.stringify(state.body)).not.toMatch(/VITE_SUPABASE|SERVICE_ROLE/);
  });

  it("fallo inesperado (requireAdmin lanza un Error genérico) → 500 genérico, sin filtrar detalles", async () => {
    adminFakes.throwWith = new Error("ECONNRESET: fallo de red hacia Supabase");
    const { res, state } = mockRes();

    await handleAdminMe(meReq(), res);

    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
    expect(JSON.stringify(state.body)).not.toMatch(/ECONNRESET|Supabase/);
  });

  it("POST /api/admin/me → 405 + Allow: GET, sin llamar a requireAdmin", async () => {
    const { res, state } = mockRes();

    await handleAdminMe(meReq({ method: "POST" }), res);

    expect(state.status).toBe(405);
    expect(state.headers.Allow).toBe("GET");
    expect(adminFakes.calls).toBe(0);
  });

  it("respuesta 200 no expone userId/email/JWT ni información de invitaciones", async () => {
    adminFakes.identity = { userId: "22222222-2222-4222-8222-222222222222" };
    const { res, state } = mockRes();

    await handleAdminMe(meReq(), res);

    expect(state.body).toEqual({ role: "admin" });
    const serialized = JSON.stringify(state.body);
    expect(serialized).not.toContain("22222222-2222-4222-8222-222222222222");
    expect(serialized).not.toMatch(/email|jwt|token|invitation/i);
  });
});
