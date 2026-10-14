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

const TOKENS: Record<string, { sub: string; aal: string; amr?: unknown }> = {
  "jwt-admin-aal2": {
    sub: ADMIN_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }],
  },
  "jwt-admin-aal1": { sub: ADMIN_ID, aal: "aal1" },
  // 9G-1: aal2 pero el último TOTP venció (fuera de la ventana), o sin amr en absoluto.
  "jwt-admin-aal2-stale": {
    sub: ADMIN_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - 3600 }],
  },
  "jwt-admin-aal2-noamr": { sub: ADMIN_ID, aal: "aal2" },
  "jwt-moderator-aal2-stale": {
    sub: MOD_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - 3600 }],
  },
  "jwt-user-aal2-stale": {
    sub: USER_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - 3600 }],
  },
  "jwt-moderator-aal2": {
    sub: MOD_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }],
  },
  "jwt-developer-aal2": {
    sub: DEV_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }],
  },
  "jwt-user-aal2": {
    sub: USER_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }],
  },
};

const fake = vi.hoisted(() => ({
  roles: {} as Record<string, string | undefined>,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  tablesTouched: [] as string[],
  rpcResult: undefined as { data: unknown; error: unknown } | undefined,
  rpcThrow: undefined as unknown,
  /** MFA fase 1: respuestas por nombre de las funciones admin_mfa_* (el resto usa rpcResult). */
  mfaRpc: {} as Record<string, { data: unknown; error: unknown }>,
  authDelete: [] as { error: unknown }[],
  deleteCalls: [] as unknown[],
  authList: { data: { factors: [] as { id: string }[] }, error: null } as {
    data: unknown;
    error: unknown;
  },
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      admin: {
        mfa: {
          deleteFactor: async (p: unknown) => {
            fake.deleteCalls.push(p);
            return fake.authDelete.shift() ?? { error: null };
          },
          listFactors: async () => fake.authList,
        },
      },
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
      if (fake.rpcThrow && !name.startsWith("admin_mfa_")) throw fake.rpcThrow;
      if (name.startsWith("admin_mfa_") && fake.mfaRpc[name]) {
        const r = fake.mfaRpc[name];
        if (r.error === "THROW") throw new Error("red caída");
        return r;
      }
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
  fake.mfaRpc = {};
  fake.authDelete = [];
  fake.deleteCalls = [];
  fake.authList = { data: { factors: [] }, error: null };
});

const ENDPOINTS: {
  name: string;
  run: (token?: string | null) => Promise<{ status?: number; body?: unknown }>;
}[] = [
  { name: "listado", run: (t) => list(t) },
  {
    name: "cambio de rol",
    run: (t) => changeRole({ user_id: TARGET_ID, role: "admin" }, t),
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
        out_new_role: "admin",
        out_changed_at: "2026-09-28T10:00:00.000Z",
        out_revoked_invitations: 0,
        ...over,
      },
    ]);

  it("llama a la RPC con actor del JWT, target y rol del body; respuesta por lista blanca", async () => {
    fake.rpcResult = success();
    const state = await changeRole({
      user_id: TARGET_ID,
      role: "admin",
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
          p_new_role: "admin",
        },
      },
    ]);
    expect(state.body).toEqual({
      user_id: TARGET_ID,
      role: "admin",
      previous_role: "moderator",
      changed_at: "2026-09-28T10:00:00.000Z",
      revoked_invitations: 0,
    });
  });

  it.each(["admin", "moderator"])("acepta el rol %s", async (role) => {
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
    const state = await changeRole(JSON.stringify({ user_id: TARGET_ID, role: "admin" }));
    expect(state.status).toBe(200);
  });

  it("una respuesta de la RPC con rol distinto al pedido → 500", async () => {
    fake.rpcResult = success({ out_new_role: "moderator" });
    expect((await changeRole({ user_id: TARGET_ID, role: "admin" })).status).toBe(500);
  });

  it("una respuesta sin fila o con forma inesperada → 500", async () => {
    fake.rpcResult = ok([]);
    expect((await changeRole({ user_id: TARGET_ID, role: "admin" })).status).toBe(500);
    fake.rpcResult = success({ out_changed_at: "nunca" });
    expect((await changeRole({ user_id: TARGET_ID, role: "admin" })).status).toBe(500);
    fake.rpcResult = success({ out_revoked_invitations: "0" });
    expect((await changeRole({ user_id: TARGET_ID, role: "admin" })).status).toBe(500);
  });

  it("Admin NO puede asignar Developer: el rol se rechaza en la API (400) y no se llama a la RPC", async () => {
    for (const body of [
      { user_id: TARGET_ID, role: "developer" },
      JSON.stringify({ user_id: TARGET_ID, role: "developer" }),
      { user_id: TARGET_ID, role: "DEVELOPER" },
    ]) {
      const state = await changeRole(body);
      expect(state.status).toBe(400);
      expect(state.body).toEqual({ error: "Solicitud inválida" });
    }
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("si la base rechaza el cambio por developer_protected (objetivo Developer) → 409 genérico", async () => {
    fake.rpcResult = rpcError("developer_protected", "P0001");
    const state = await changeRole({ user_id: TARGET_ID, role: "moderator" });
    expect(state.status).toBe(409);
    expect(state.body).toEqual({ error: "Operación no permitida" });
  });
});

describe("POST /api/admin/team-members-remove", () => {
  const RESET_ID = "99999999-9999-4999-8999-999999999999";
  const OLD_F1 = "aaaaaaaa-0000-4000-8000-000000000001";
  const OLD_F2 = "aaaaaaaa-0000-4000-8000-000000000002";
  const NEW_F = "bbbbbbbb-0000-4000-8000-000000000009";
  const removalRow = (over: Record<string, unknown> = {}) => ({
    out_old_role: "developer",
    out_removed_at: "2026-09-28T10:00:00.000Z",
    out_revoked_invitations: 0,
    out_mfa_reset_id: RESET_ID,
    out_mfa_factor_count: 0,
    ...over,
  });
  const withFactors = (ids = [OLD_F1]) => {
    fake.rpcResult = ok([removalRow({ out_mfa_factor_count: ids.length })]);
    fake.mfaRpc.admin_mfa_pending_reset = ok([
      { out_reset_id: RESET_ID, out_factor_ids: ids },
    ]);
    fake.mfaRpc.admin_mfa_reset_record = ok("completed");
  };
  const names = () => fake.rpcCalls.map((c) => c.name);

  it("llama a la RPC atómica con actor del JWT y target del body; sin factores no hay nada que limpiar", async () => {
    fake.rpcResult = ok([removalRow()]);
    const state = await remove({ user_id: TARGET_ID, actor: MOD_ID, role: "admin" });

    expect(state.status).toBe(200);
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(fake.rpcCalls).toEqual([
      {
        name: "admin_remove_member_with_mfa_reset",
        args: { p_actor_user_id: ADMIN_ID, p_target_user_id: TARGET_ID },
      },
    ]);
    expect(state.body).toEqual({
      user_id: TARGET_ID,
      previous_role: "developer",
      removed_at: "2026-09-28T10:00:00.000Z",
      revoked_invitations: 0,
      mfa_reset: { status: "not_needed" },
    });
    expect(fake.deleteCalls).toHaveLength(0);
  });

  it("nunca invoca remove_admin_member directamente (la marca de MFA no se puede omitir)", async () => {
    fake.rpcResult = ok([removalRow()]);
    await remove({ user_id: TARGET_ID });
    expect(names()).not.toContain("remove_admin_member");
  });

  it("con factores: borra EXACTAMENTE los ids de la instantánea y registra la finalización", async () => {
    withFactors([OLD_F1, OLD_F2]);
    const state = await remove({ user_id: TARGET_ID });
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({
      previous_role: "developer",
      mfa_reset: { status: "completed", factors_deleted: 2 },
    });
    expect(fake.deleteCalls).toEqual([
      { id: OLD_F1, userId: TARGET_ID },
      { id: OLD_F2, userId: TARGET_ID },
    ]);
    expect(names()).toEqual([
      "admin_remove_member_with_mfa_reset",
      "admin_mfa_pending_reset",
      "admin_mfa_reset_record",
    ]);
    expect(fake.rpcCalls[2].args).toEqual({
      p_reset_id: RESET_ID,
      p_ok: true,
      p_factors_deleted: 2,
      p_error_class: null,
    });
  });

  it("ORDEN: el borrado de factores solo ocurre después de confirmar la retirada del rol", async () => {
    withFactors();
    await remove({ user_id: TARGET_ID });
    expect(names()[0]).toBe("admin_remove_member_with_mfa_reset");
    expect(fake.deleteCalls).toHaveLength(1);
    // Si la retirada es rechazada, NO se toca ningún factor.
    fake.rpcCalls = [];
    fake.deleteCalls = [];
    fake.rpcResult = rpcError("member_not_found");
    const rejected = await remove({ user_id: TARGET_ID });
    expect(rejected.status).toBe(404);
    expect(fake.deleteCalls).toHaveLength(0);
    expect(names()).toEqual(["admin_remove_member_with_mfa_reset"]);
  });

  it("fallo de Auth tras retirar el rol: 200 (el acceso SÍ se retiró) con la limpieza pendiente y la clase del error", async () => {
    withFactors();
    fake.authDelete = [{ error: { status: 500, message: "detalle interno de GoTrue" } }];
    const state = await remove({ user_id: TARGET_ID });
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({
      previous_role: "developer",
      mfa_reset: { status: "pending", error_class: "auth_delete_failed" },
    });
    expect(JSON.stringify(state.body)).not.toMatch(/detalle interno/);
    expect(fake.rpcCalls.at(-1)).toEqual({
      name: "admin_mfa_reset_record",
      args: {
        p_reset_id: RESET_ID,
        p_ok: false,
        p_factors_deleted: null,
        p_error_class: "auth_delete_failed",
      },
    });
  });

  it("el factor ya no existe (404): se considera resuelto y se completa con 0 borrados", async () => {
    withFactors();
    fake.authDelete = [{ error: { status: 404, code: "mfa_factor_not_found" } }];
    const state = await remove({ user_id: TARGET_ID });
    expect(state.body).toMatchObject({
      mfa_reset: { status: "completed", factors_deleted: 0 },
    });
  });

  it("si tras borrar siguen presentes ids de la instantánea → pendiente; un factor NUEVO se ignora", async () => {
    withFactors();
    fake.authList = { data: { factors: [{ id: OLD_F1 }] }, error: null };
    expect((await remove({ user_id: TARGET_ID })).body).toMatchObject({
      mfa_reset: { status: "pending", error_class: "factor_still_present" },
    });
    // factor nuevo (no está en la instantánea): no bloquea ni se borra
    fake.deleteCalls = [];
    fake.rpcCalls = [];
    fake.rpcResult = ok([removalRow({ out_mfa_factor_count: 1 })]);
    fake.authList = { data: { factors: [{ id: NEW_F }] }, error: null };
    const state = await remove({ user_id: TARGET_ID });
    expect(state.body).toMatchObject({ mfa_reset: { status: "completed" } });
    expect(fake.deleteCalls).toEqual([{ id: OLD_F1, userId: TARGET_ID }]);
    expect(JSON.stringify(fake.deleteCalls)).not.toContain(NEW_F);
  });

  it.each([
    [
      "no se puede listar",
      () => (fake.authList = { data: null, error: { status: 500 } }),
    ],
    ["Auth lanza una excepción", () => (fake.authList = undefined as never)],
  ])("%s → pendiente, nunca un error de la retirada", async (_n, arrange) => {
    withFactors();
    arrange();
    const state = await remove({ user_id: TARGET_ID });
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ mfa_reset: { status: "pending" } });
  });

  it("no poder leer o registrar la limpieza deja el estado pendiente (200, rol retirado)", async () => {
    withFactors();
    fake.mfaRpc.admin_mfa_pending_reset = { data: null, error: { message: "boom" } };
    expect((await remove({ user_id: TARGET_ID })).body).toMatchObject({
      mfa_reset: { status: "pending", error_class: "cleanup_unavailable" },
    });
    withFactors();
    fake.mfaRpc.admin_mfa_reset_record = { data: null, error: { message: "boom" } };
    expect((await remove({ user_id: TARGET_ID })).body).toMatchObject({
      mfa_reset: { status: "pending", error_class: "record_failed" },
    });
  });

  it("campos MFA ausentes o malformados en la fila: la retirada sigue siendo un 200", async () => {
    fake.rpcResult = ok([
      {
        out_old_role: "developer",
        out_removed_at: "2026-09-28T10:00:00.000Z",
        out_revoked_invitations: 0,
      },
    ]);
    const state = await remove({ user_id: TARGET_ID });
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ mfa_reset: { status: "pending" } });
  });

  it("repetir la solicitud: el miembro ya no existe → 404 y no se borra ningún factor", async () => {
    withFactors();
    expect((await remove({ user_id: TARGET_ID })).status).toBe(200);
    fake.deleteCalls = [];
    fake.rpcCalls = [];
    fake.rpcResult = rpcError("member_not_found");
    expect((await remove({ user_id: TARGET_ID })).status).toBe(404);
    expect(fake.deleteCalls).toHaveLength(0);
    expect(names()).toEqual(["admin_remove_member_with_mfa_reset"]);
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
      run: () => changeRole({ user_id: TARGET_ID, role: "admin" }),
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
        ["developer_protected", "P0001", 409, "Operación no permitida"],
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

describe("9G-1 — MFA reciente: rol y capacidad ANTES del step-up", () => {
  for (const ep of ENDPOINTS) {
    describe(ep.name, () => {
      it.each([
        ["ADMIN aal2 con TOTP vencido", "jwt-admin-aal2-stale"],
        ["ADMIN aal2 sin amr", "jwt-admin-aal2-noamr"],
        ["ADMIN con aal1", "jwt-admin-aal1"],
      ])("%s → 403 step_up_required, sin llamar a la RPC", async (_n, token) => {
        const state = await ep.run(token);
        expect(state.status).toBe(403);
        expect(state.body).toEqual({ error: "No autorizado", code: "step_up_required" });
        expect(fake.rpcCalls).toHaveLength(0);
      });

      it.each([
        ["MODERATOR con MFA vencido", "jwt-moderator-aal2-stale"],
        ["USER con MFA vencido", "jwt-user-aal2-stale"],
        ["MODERATOR con MFA reciente", "jwt-moderator-aal2"],
        ["USER con aal2 y MFA reciente", "jwt-user-aal2"],
      ])("%s → 403 genérico SIN code (nunca se le envía a MFA)", async (_n, token) => {
        const state = await ep.run(token);
        expect(state.status).toBe(403);
        expect(state.body).toEqual({ error: "No autorizado" });
        expect(fake.rpcCalls).toHaveLength(0);
      });
    });
  }
});

describe("limpiezas de MFA: ya no existen para Admin", () => {
  it.each(["team-members-mfa-cleanups", "team-members-mfa-cleanup"])(
    "%s → 404",
    async (action) => {
      expect((await call(req({ action, token: "t" }))).status).toBe(404);
    },
  );
});
