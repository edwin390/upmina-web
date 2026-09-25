import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import router from "../../api/admin/[action]";

// Bloque 9F. Se ejecutan el despachador, los handlers y requireCapability REALES; el cliente de
// Supabase es un falso que solo expone rpc() (y admin_roles para requireCapability). Las reglas
// de negocio de las RPC (lock, actor ADMIN, actor <> target, último ADMIN, auditoría, revocación
// de invitaciones) NO se reimplementan aquí: se ejercitan contra PostgreSQL real en el harness
// desechable. Este archivo fija el contrato HTTP, la autorización y que no se filtre nada.

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const MOD_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const DEV_ID = "55555555-5555-4555-8555-555555555555";
const TARGET_ID = "66666666-6666-4666-8666-666666666666";

const TOKENS: Record<string, { sub: string; aal: string }> = {
  "jwt-admin-aal2": { sub: ADMIN_ID, aal: "aal2" },
  "jwt-admin-aal1": { sub: ADMIN_ID, aal: "aal1" },
  "jwt-moderator-aal2": { sub: MOD_ID, aal: "aal2" },
  "jwt-developer-aal2": { sub: DEV_ID, aal: "aal2" },
  "jwt-user-aal2": { sub: USER_ID, aal: "aal2" },
};

const fake = vi.hoisted(() => ({
  roles: {} as Record<string, string | undefined>,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  tablesTouched: [] as string[],
  rpcResult: undefined as { data: unknown; error: unknown } | undefined,
  rpcThrow: undefined as unknown,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      async getClaims(jwt: string) {
        const claims = TOKENS[jwt];
        return claims
          ? { data: { claims }, error: null }
          : { data: null, error: { message: "jwt inválido" } };
      },
    },
    from: (table: string) => {
      fake.tablesTouched.push(table);
      if (table !== "admin_roles") throw new Error(`tabla inesperada: ${table}`);
      return {
        select: () => {
          let userId = "";
          const builder = {
            eq(_c: string, v: string) {
              userId = v;
              return builder;
            },
            async maybeSingle() {
              const role = fake.roles[userId];
              return { data: role ? { role } : null, error: null };
            },
          };
          return builder;
        },
      };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      fake.rpcCalls.push({ name, args });
      if (fake.rpcThrow) throw fake.rpcThrow;
      return (
        fake.rpcResult ?? {
          data: null,
          error: { code: "XX000", message: "sin resultado" },
        }
      );
    },
  }),
}));

function mockRes() {
  const state: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
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

function req(opts: {
  method?: string;
  token?: string | null;
  action: string;
  body?: unknown;
}) {
  const headers: Record<string, string> = {};
  if (opts.token !== null)
    headers.authorization = `Bearer ${opts.token ?? "jwt-admin-aal2"}`;
  return {
    method: opts.method ?? "POST",
    headers,
    query: { action: opts.action },
    body: opts.body,
  } as unknown as VercelRequest;
}

async function call(request: VercelRequest) {
  const { res, state } = mockRes();
  await router(request, res);
  return state;
}

const list = (token?: string | null, method = "GET") =>
  call(req({ method, action: "team-members", token }));
const changeRole = (body: unknown, token?: string | null) =>
  call(req({ action: "team-members-role", body, token }));
const remove = (body: unknown, token?: string | null) =>
  call(req({ action: "team-members-remove", body, token }));

const memberRow = (over: Record<string, unknown> = {}) => ({
  out_user_id: TARGET_ID,
  out_role: "moderator",
  out_granted_at: "2026-09-20T12:00:00.000Z",
  out_username: "mina",
  out_display_name: "Mina",
  out_email: "mina@example.invalid",
  out_is_self: false,
  ...over,
});

const ok = (data: unknown) => ({ data, error: null });
const rpcError = (message: string, code = "P0001") => ({
  data: null,
  error: { code, message },
});

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-ficticia");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-service-role-ficticia");
  fake.roles = { [ADMIN_ID]: "admin", [MOD_ID]: "moderator", [DEV_ID]: "developer" };
  fake.rpcCalls = [];
  fake.tablesTouched = [];
  fake.rpcResult = undefined;
  fake.rpcThrow = undefined;
});

const ENDPOINTS: {
  name: string;
  run: (token?: string | null) => Promise<{ status?: number }>;
}[] = [
  { name: "listado", run: (t) => list(t) },
  {
    name: "cambio de rol",
    run: (t) => changeRole({ user_id: TARGET_ID, role: "developer" }, t),
  },
  { name: "quitar acceso", run: (t) => remove({ user_id: TARGET_ID }, t) },
];

describe("autorización (team_admin + AAL2) — antes de cualquier RPC", () => {
  for (const ep of ENDPOINTS) {
    describe(ep.name, () => {
      it.each([
        ["sin Authorization", null, 401],
        ["JWT inválido", "jwt-basura", 401],
        ["ADMIN con AAL1", "jwt-admin-aal1", 403],
        ["MODERATOR con AAL2", "jwt-moderator-aal2", 403],
        ["DEVELOPER con AAL2", "jwt-developer-aal2", 403],
        ["USER sin rol", "jwt-user-aal2", 403],
      ])("%s → %i y no se llama a la RPC", async (_n, token, status) => {
        const state = await ep.run(token);
        expect(state.status).toBe(status);
        expect(fake.rpcCalls).toHaveLength(0);
      });
    });
  }
});

describe("métodos", () => {
  it("el listado solo admite GET (405 con Allow) y no autentica", async () => {
    const state = await list("jwt-admin-aal2", "POST");
    expect(state.status).toBe(405);
    expect(state.headers.Allow).toBe("GET");
    expect(fake.rpcCalls).toHaveLength(0);
    expect(fake.tablesTouched).toHaveLength(0);
  });

  it.each(["team-members-role", "team-members-remove"])(
    "%s solo admite POST (405 con Allow) y no autentica",
    async (action) => {
      const state = await call(req({ method: "GET", action }));
      expect(state.status).toBe(405);
      expect(state.headers.Allow).toBe("POST");
      expect(fake.rpcCalls).toHaveLength(0);
      expect(fake.tablesTouched).toHaveLength(0);
    },
  );
});

describe("GET /api/admin/team-members", () => {
  it("llama a list_admin_team_members con el actor del JWT y devuelve solo la lista blanca", async () => {
    fake.rpcResult = ok([
      memberRow({
        // Campos que una RPC futura pudiera devolver de más: jamás deben llegar al cliente.
        granted_by: ADMIN_ID,
        out_phone: "+000",
        out_identities: [{}],
        out_last_sign_in_at: "2026-01-01T00:00:00Z",
        out_avatar_path: "a/b.png",
      }),
      memberRow({
        out_user_id: ADMIN_ID,
        out_role: "admin",
        out_username: null,
        out_display_name: null,
        out_email: null,
        out_is_self: true,
      }),
    ]);

    const state = await list();

    expect(state.status).toBe(200);
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(fake.rpcCalls).toEqual([
      { name: "list_admin_team_members", args: { p_actor_user_id: ADMIN_ID } },
    ]);
    expect(state.body).toEqual({
      members: [
        {
          user_id: TARGET_ID,
          role: "moderator",
          granted_at: "2026-09-20T12:00:00.000Z",
          username: "mina",
          display_name: "Mina",
          email: "mina@example.invalid",
          is_self: false,
        },
        {
          user_id: ADMIN_ID,
          role: "admin",
          granted_at: "2026-09-20T12:00:00.000Z",
          username: null,
          display_name: null,
          email: null,
          is_self: true,
        },
      ],
    });
    const serialized = JSON.stringify(state.body);
    for (const leak of ["phone", "identities", "last_sign_in", "avatar", "granted_by"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("lista vacía → 200 con members: []", async () => {
    fake.rpcResult = ok([]);
    const state = await list();
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ members: [] });
  });

  it.each([
    ["rol desconocido", memberRow({ out_role: "user" })],
    ["user_id no UUID", memberRow({ out_user_id: "no-uuid" })],
    ["granted_at inválido", memberRow({ out_granted_at: "ayer" })],
    ["is_self no booleano", memberRow({ out_is_self: "false" })],
    ["email de tipo inesperado", memberRow({ out_email: 5 })],
    ["fila que no es objeto", "fila"],
  ])("fila malformada (%s) → 500 genérico", async (_n, row) => {
    fake.rpcResult = ok([row]);
    const state = await list();
    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
  });

  it("data que no es un arreglo → 500", async () => {
    fake.rpcResult = ok(null);
    expect((await list()).status).toBe(500);
  });

  it("actor_not_admin en la RPC (degradado tras la autorización) → 403", async () => {
    fake.rpcResult = rpcError("actor_not_admin");
    const state = await list();
    expect(state.status).toBe(403);
    expect(state.body).toEqual({ error: "No autorizado" });
  });

  it("el email no aparece en errores ni en mensajes de otros endpoints", async () => {
    fake.rpcResult = rpcError("boom mina@example.invalid", "XX000");
    const state = await list();
    expect(state.status).toBe(500);
    expect(JSON.stringify(state.body)).not.toContain("example.invalid");
  });
});

describe("POST /api/admin/team-members-role", () => {
  const success = (over: Record<string, unknown> = {}) =>
    ok([
      {
        out_old_role: "moderator",
        out_new_role: "developer",
        out_changed_at: "2026-09-28T10:00:00.000Z",
        out_revoked_invitations: 0,
        ...over,
      },
    ]);

  it("llama a la RPC con actor del JWT, target y rol del body; respuesta por lista blanca", async () => {
    fake.rpcResult = success();
    const state = await changeRole({
      user_id: TARGET_ID,
      role: "developer",
      // Ignorados por completo:
      actor: MOD_ID,
      p_actor_user_id: MOD_ID,
      is_self: false,
    });

    expect(state.status).toBe(200);
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(fake.rpcCalls).toEqual([
      {
        name: "change_admin_member_role",
        args: {
          p_actor_user_id: ADMIN_ID,
          p_target_user_id: TARGET_ID,
          p_new_role: "developer",
        },
      },
    ]);
    expect(state.body).toEqual({
      user_id: TARGET_ID,
      role: "developer",
      previous_role: "moderator",
      changed_at: "2026-09-28T10:00:00.000Z",
      revoked_invitations: 0,
    });
  });

  it.each(["admin", "moderator", "developer"])("acepta el rol %s", async (role) => {
    fake.rpcResult = success({
      out_old_role: role === "admin" ? "moderator" : "admin",
      out_new_role: role,
    });
    expect((await changeRole({ user_id: TARGET_ID, role })).status).toBe(200);
  });

  it("informa cuántas invitaciones pendientes se revocaron", async () => {
    fake.rpcResult = success({
      out_old_role: "admin",
      out_new_role: "moderator",
      out_revoked_invitations: 3,
    });
    const state = await changeRole({ user_id: TARGET_ID, role: "moderator" });
    expect(state.body).toMatchObject({ previous_role: "admin", revoked_invitations: 3 });
  });

  it.each([
    ["sin body", undefined],
    ["body no objeto", "texto"],
    ["JSON inválido", "{no-json"],
    ["arreglo", []],
    ["sin user_id", { role: "admin" }],
    ["user_id no UUID", { user_id: "123", role: "admin" }],
    ["user_id no string", { user_id: 5, role: "admin" }],
    ["sin role", { user_id: TARGET_ID }],
    ["rol user", { user_id: TARGET_ID, role: "user" }],
    ["rol en mayúsculas", { user_id: TARGET_ID, role: "ADMIN" }],
    ["rol de objeto", { user_id: TARGET_ID, role: { r: "admin" } }],
    ["rol null", { user_id: TARGET_ID, role: null }],
  ])("body inválido (%s) → 400 y no se llama a la RPC", async (_n, body) => {
    const state = await changeRole(body);
    expect(state.status).toBe(400);
    expect(state.body).toEqual({ error: "Solicitud inválida" });
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("acepta el body como string JSON", async () => {
    fake.rpcResult = success();
    const state = await changeRole(
      JSON.stringify({ user_id: TARGET_ID, role: "developer" }),
    );
    expect(state.status).toBe(200);
  });

  it("una respuesta de la RPC con rol distinto al pedido → 500", async () => {
    fake.rpcResult = success({ out_new_role: "admin" });
    expect((await changeRole({ user_id: TARGET_ID, role: "developer" })).status).toBe(
      500,
    );
  });

  it("una respuesta sin fila o con forma inesperada → 500", async () => {
    fake.rpcResult = ok([]);
    expect((await changeRole({ user_id: TARGET_ID, role: "developer" })).status).toBe(
      500,
    );
    fake.rpcResult = success({ out_changed_at: "nunca" });
    expect((await changeRole({ user_id: TARGET_ID, role: "developer" })).status).toBe(
      500,
    );
    fake.rpcResult = success({ out_revoked_invitations: "0" });
    expect((await changeRole({ user_id: TARGET_ID, role: "developer" })).status).toBe(
      500,
    );
  });
});

describe("POST /api/admin/team-members-remove", () => {
  it("llama a la RPC con actor del JWT y target del body; respuesta por lista blanca", async () => {
    fake.rpcResult = ok([
      {
        out_old_role: "developer",
        out_removed_at: "2026-09-28T10:00:00.000Z",
        out_revoked_invitations: 0,
      },
    ]);
    const state = await remove({ user_id: TARGET_ID, actor: MOD_ID, role: "admin" });

    expect(state.status).toBe(200);
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(fake.rpcCalls).toEqual([
      {
        name: "remove_admin_member",
        args: { p_actor_user_id: ADMIN_ID, p_target_user_id: TARGET_ID },
      },
    ]);
    expect(state.body).toEqual({
      user_id: TARGET_ID,
      previous_role: "developer",
      removed_at: "2026-09-28T10:00:00.000Z",
      revoked_invitations: 0,
    });
  });

  it.each([
    ["sin body", undefined],
    ["sin user_id", {}],
    ["user_id no UUID", { user_id: "x" }],
    ["user_id no string", { user_id: { id: TARGET_ID } }],
  ])("body inválido (%s) → 400 y no se llama a la RPC", async (_n, body) => {
    const state = await remove(body);
    expect(state.status).toBe(400);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("respuesta de la RPC malformada → 500", async () => {
    fake.rpcResult = ok([
      { out_old_role: "root", out_removed_at: "2026-09-28T10:00:00Z" },
    ]);
    expect((await remove({ user_id: TARGET_ID })).status).toBe(500);
  });
});

describe("matriz de errores de las mutaciones", () => {
  const mutations: {
    name: string;
    run: () => Promise<{ status?: number; body?: unknown }>;
  }[] = [
    {
      name: "cambio de rol",
      run: () => changeRole({ user_id: TARGET_ID, role: "developer" }),
    },
    { name: "quitar acceso", run: () => remove({ user_id: TARGET_ID }) },
  ];

  for (const m of mutations) {
    describe(m.name, () => {
      it.each([
        ["actor_not_admin", "P0001", 403, "No autorizado"],
        ["member_not_found", "P0001", 404, "No encontrado"],
        ["self_change_not_allowed", "P0001", 409, "Operación no permitida"],
        ["role_unchanged", "P0001", 409, "Operación no permitida"],
        ["last_admin_protected", "23001", 409, "Operación no permitida"],
      ])("%s → %i", async (message, code, status, publicMessage) => {
        fake.rpcResult = rpcError(message, code);
        const state = await m.run();
        expect(state.status).toBe(status);
        expect(state.body).toEqual({ error: publicMessage });
      });

      it.each([
        ["invalid_role (P0001)", "invalid_role", "P0001"],
        ["invalid_argument (P0001)", "invalid_argument", "P0001"],
        ["literal reconocido pero con código ajeno", "actor_not_admin", "42501"],
        ["last_admin_protected con código ajeno", "last_admin_protected", "P0001"],
        ["23001 con otro mensaje", "admin_team_audit_immutable", "23001"],
        [
          "error de conexión con detalle sensible",
          "password authentication failed for user postgres",
          "28P01",
        ],
      ])("%s → 500 genérico sin filtrar el mensaje", async (_n, message, code) => {
        fake.rpcResult = rpcError(message, code);
        const state = await m.run();
        expect(state.status).toBe(500);
        expect(state.body).toEqual({ error: "Error interno" });
        expect(JSON.stringify(state.body)).not.toContain(message);
      });

      it("la RPC lanza una excepción → 500 genérico", async () => {
        fake.rpcThrow = new Error("connect ECONNREFUSED 10.0.0.1:5432");
        const state = await m.run();
        expect(state.status).toBe(500);
        expect(state.body).toEqual({ error: "Error interno" });
      });

      it("Supabase sin configurar → 500 genérico", async () => {
        vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
        const state = await m.run();
        expect(state.status).toBe(500);
        expect(state.body).toEqual({ error: "Error interno" });
      });
    });
  }
});

describe("despachador", () => {
  it("un action desconocido sigue siendo 404 y no ejecuta RPC", async () => {
    const state = await call(req({ method: "GET", action: "team-members-x" }));
    expect(state.status).toBe(404);
    expect(fake.rpcCalls).toHaveLength(0);
  });
});
