import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import router from "../../api/admin/[action]";

// Developer Panel V1 — autotransferencia Admin → Developer y restauración. Se ejecutan el despachador,
// los handlers y requireAuthenticated/requireCapability REALES; el cliente de Supabase es un doble. Las
// reglas (otro Admin elegible, lock de roles, recuperaciones activas, último Admin) viven en SQL y se
// prueban contra PostgreSQL real (developer-transition-migration.test.ts). Datos SINTÉTICOS.

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const MOD_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ID = "44444444-4444-4444-8444-444444444444";
const DEV_ID = "55555555-5555-4555-8555-555555555555";
const RESET_ID = "66666666-6666-4666-8666-666666666666";
const FACTOR_ID = "77777777-7777-4777-8777-777777777777";

const nowS = () => Math.floor(Date.now() / 1000);
const pw = (ago = 0) => ({ method: "password", timestamp: nowS() - ago });
const totp = (ago = 0) => ({ method: "totp", timestamp: nowS() - ago });
const TOKENS: Record<string, Record<string, unknown>> = {
  "jwt-admin-fresh": { sub: ADMIN_ID, aal: "aal2", amr: [pw(7200), totp(10)] },
  "jwt-admin-4min": { sub: ADMIN_ID, aal: "aal2", amr: [pw(7200), totp(240)] },
  "jwt-admin-10min": { sub: ADMIN_ID, aal: "aal2", amr: [pw(7200), totp(600)] },
  "jwt-admin-stale": { sub: ADMIN_ID, aal: "aal2", amr: [pw(7200), totp(3600)] },
  "jwt-admin-aal1": { sub: ADMIN_ID, aal: "aal1", amr: [pw(30)] },
  "jwt-dev-fresh": { sub: DEV_ID, aal: "aal2", amr: [pw(7200), totp(10)] },
  "jwt-mod-fresh": { sub: MOD_ID, aal: "aal2", amr: [pw(7200), totp(10)] },
  "jwt-user-aal1": { sub: USER_ID, aal: "aal1", amr: [pw(30)] },
};

type Rpc = (args: Record<string, unknown>) => { data: unknown; error: unknown };
const fake = vi.hoisted(() => ({
  roles: {} as Record<string, string | undefined>,
  rpc: {} as Record<string, unknown>,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  deleteResults: [] as { error: unknown }[],
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
            return fake.deleteResults.shift() ?? { error: null };
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
    from: () => ({
      select: () => {
        let userId = "";
        const b = {
          eq(_c: string, v: string) {
            userId = v;
            return b;
          },
          async maybeSingle() {
            const role = fake.roles[userId];
            return { data: role ? { role } : null, error: null };
          },
        };
        return b;
      },
    }),
    async rpc(name: string, args: Record<string, unknown>) {
      fake.rpcCalls.push({ name, args });
      const entry = fake.rpc[name];
      if (typeof entry === "function") return (entry as Rpc)(args);
      return entry ?? { data: null, error: { code: "XX000", message: "sin resultado" } };
    },
  }),
}));

function mockRes() {
  const state: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const res = {
    setHeader(n: string, v: string) {
      state.headers[n] = v;
      return res;
    },
    status(c: number) {
      state.status = c;
      return res;
    },
    json(b: unknown) {
      state.body = b;
      return res;
    },
  };
  return { res: res as unknown as VercelResponse, state };
}

async function call(opts: {
  action: string;
  method?: string;
  token?: string | null;
  body?: unknown;
}) {
  const { res, state } = mockRes();
  const headers: Record<string, string> = {};
  if (opts.token !== null && opts.token !== undefined)
    headers.authorization = `Bearer ${opts.token}`;
  await router(
    {
      method: opts.method ?? "POST",
      headers,
      query: { action: opts.action },
      body: opts.body,
    } as unknown as VercelRequest,
    res,
  );
  return state;
}
const statusOf = (token: string | null = "jwt-admin-fresh") =>
  call({ action: "team-developer-transfer", method: "GET", token });
const transfer = (
  body: unknown = { acknowledge: true },
  token: string | null = "jwt-admin-fresh",
) => call({ action: "team-developer-transfer", method: "POST", body, token });
const restore = (body: unknown, token: string | null = "jwt-admin-fresh") =>
  call({ action: "team-developer-restore", method: "POST", body, token });

const remove = (body: unknown, token: string | null = "jwt-admin-fresh") =>
  call({ action: "team-developer-remove", method: "POST", body, token });

const ok = (data: unknown) => ({ data, error: null });
const rpcNames = () => fake.rpcCalls.map((c) => c.name);

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-ficticia");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-service-role-ficticia");
  fake.roles = { [ADMIN_ID]: "admin", [MOD_ID]: "moderator", [DEV_ID]: "developer" };
  fake.rpc = {
    admin_transfer_status: ok({ eligible: true, reason: "ok" }),
    admin_transfer_self_to_developer: ok({
      ok: true,
      transferredAt: "2026-11-02T10:00:00.000Z",
      cooldownReadyAt: "2026-11-02T11:00:00.000Z",
    }),
    admin_restore_developer: ok({
      ok: true,
      previousRole: "developer",
      newRole: "moderator",
    }),
    admin_remove_developer: ok({
      ok: true,
      removedAt: "2026-11-03T10:00:00.000Z",
      revokedInvitations: 0,
      lastDeveloper: false,
      mfaResetId: RESET_ID,
      mfaFactorCount: 1,
    }),
    admin_mfa_pending_reset: ok([
      { out_reset_id: RESET_ID, out_factor_ids: [FACTOR_ID] },
    ]),
    admin_mfa_reset_record: ok("completed"),
  };
  fake.rpcCalls = [];
  fake.deleteResults = [];
  fake.deleteCalls = [];
  fake.authList = { data: { factors: [] }, error: null };
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("autorización", () => {
  it("sin sesión 401; usuario, moderator y DEVELOPER reciben 403 en las tres operaciones y no llega ninguna RPC", async () => {
    for (const token of ["jwt-user-aal1", "jwt-mod-fresh", "jwt-dev-fresh"]) {
      expect((await statusOf(token)).status, `status ${token}`).toBe(403);
      expect(
        (await transfer({ acknowledge: true }, token)).status,
        `transfer ${token}`,
      ).toBe(403);
      expect(
        (await restore({ user_id: OTHER_ID, role: "moderator" }, token)).status,
        `restore ${token}`,
      ).toBe(403);
      expect((await remove({ user_id: DEV_ID }, token)).status, `remove ${token}`).toBe(
        403,
      );
    }
    expect((await statusOf(null)).status).toBe(401);
    expect((await transfer({ acknowledge: true }, null)).status).toBe(401);
    expect((await restore({ user_id: OTHER_ID, role: "admin" }, null)).status).toBe(401);
    expect((await remove({ user_id: DEV_ID }, null)).status).toBe(401);
    expect(fake.rpcCalls).toEqual([]);
  });

  it("un Developer no puede cambiar su propio rol: ninguna ruta se lo permite", async () => {
    const own = await restore({ user_id: DEV_ID, role: "admin" }, "jwt-dev-fresh");
    expect(own.status).toBe(403);
    expect((await remove({ user_id: DEV_ID }, "jwt-dev-fresh")).status).toBe(403);
    expect(fake.rpcCalls).toEqual([]);
  });

  it("MFA: aal1 o un TOTP antiguo no bastan ni para consultar", async () => {
    for (const token of ["jwt-admin-aal1", "jwt-admin-stale"]) {
      const r = await statusOf(token);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: "step_up_required" });
    }
    expect(fake.rpcCalls).toEqual([]);
  });

  it("transferirse y restaurar exigen un TOTP de ≤ 5 minutos: con 10 minutos se puede consultar pero no actuar", async () => {
    expect((await statusOf("jwt-admin-10min")).status).toBe(200);
    fake.rpcCalls = [];
    const t = await transfer({ acknowledge: true }, "jwt-admin-10min");
    expect(t.status).toBe(403);
    expect(t.body).toMatchObject({ code: "step_up_required" });
    const r = await restore({ user_id: OTHER_ID, role: "moderator" }, "jwt-admin-10min");
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "step_up_required" });
    const q = await remove({ user_id: DEV_ID }, "jwt-admin-10min");
    expect(q.status).toBe(403);
    expect(q.body).toMatchObject({ code: "step_up_required" });
    expect(fake.rpcCalls).toEqual([]);
    expect((await transfer({ acknowledge: true }, "jwt-admin-4min")).status).toBe(200);
    expect((await remove({ user_id: DEV_ID }, "jwt-admin-4min")).status).toBe(200);
  });

  it("métodos no admitidos → 405", async () => {
    expect(
      (
        await call({
          action: "team-developer-transfer",
          method: "DELETE",
          token: "jwt-admin-fresh",
        })
      ).status,
    ).toBe(405);
    expect(
      (
        await call({
          action: "team-developer-restore",
          method: "GET",
          token: "jwt-admin-fresh",
        })
      ).status,
    ).toBe(405);
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const r = await call({
        action: "team-developer-remove",
        method,
        token: "jwt-admin-fresh",
        body: { user_id: DEV_ID },
      });
      expect(r.status, method).toBe(405);
      expect(r.headers.Allow).toBe("POST");
    }
    expect(fake.rpcCalls).toEqual([]);
  });
});

describe("estado para la interfaz (GET)", () => {
  it("devuelve solo si es elegible y un motivo cerrado; el actor sale del JWT", async () => {
    const r = await statusOf();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ eligible: true, reason: "ok" });
    expect(r.headers["Cache-Control"]).toBe("no-store");
    expect(fake.rpcCalls).toEqual([
      { name: "admin_transfer_status", args: { p_actor_user_id: ADMIN_ID } },
    ]);
  });

  it.each(["no_eligible_peer", "recovery_in_progress"])("motivo «%s»", async (reason) => {
    fake.rpc.admin_transfer_status = ok({ eligible: false, reason });
    expect((await statusOf()).body).toEqual({ eligible: false, reason });
  });

  it("una respuesta inesperada de la base → 500 genérico (nunca se muestra como elegible)", async () => {
    fake.rpc.admin_transfer_status = ok({ eligible: true, reason: "otro" });
    expect((await statusOf()).status).toBe(500);
    fake.rpc.admin_transfer_status = ok({ eligible: "si", reason: "ok" });
    expect((await statusOf()).status).toBe(500);
  });
});

describe("autotransferencia (POST)", () => {
  it("el actor sale del JWT: ningún campo del cuerpo elige a otra persona y la RPC solo recibe al actor", async () => {
    const r = await transfer({
      acknowledge: true,
      user_id: OTHER_ID,
      target: OTHER_ID,
      p_actor_user_id: OTHER_ID,
      role: "developer",
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      status: "transferred",
      role: "developer",
      cooldown_ready_at: "2026-11-02T11:00:00.000Z",
    });
    expect(fake.rpcCalls).toEqual([
      { name: "admin_transfer_self_to_developer", args: { p_actor_user_id: ADMIN_ID } },
    ]);
  });

  it("exige la aceptación explícita de la pérdida de acceso Admin: sin ella (o con otro valor) no llega ninguna RPC", async () => {
    for (const body of [
      {},
      { acknowledge: false },
      { acknowledge: "true" },
      { acknowledge: 1 },
      null,
      "texto",
      [],
    ]) {
      const r = await transfer(body);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({
        error: "Solicitud inválida",
        code: "acknowledge_required",
      });
    }
    expect(fake.rpcCalls).toEqual([]);
  });

  it.each([
    ["no_eligible_peer", 409],
    ["recovery_in_progress", 409],
  ])("rechazo «%s» de la base → 409 controlado", async (reason, status) => {
    fake.rpc.admin_transfer_self_to_developer = ok({ ok: false, reason });
    const r = await transfer();
    expect(r.status).toBe(status);
    expect(r.body).toEqual({ error: "Operación no permitida", code: reason });
  });

  it("un motivo desconocido, un error de la base o un actor que ya no es admin → sin detalles", async () => {
    fake.rpc.admin_transfer_self_to_developer = ok({ ok: false, reason: "algo_raro" });
    expect((await transfer()).status).toBe(500);
    fake.rpc.admin_transfer_self_to_developer = {
      data: null,
      error: { code: "XX000", message: "detalle interno sensible" },
    };
    const r = await transfer();
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("sensible");
    fake.rpc.admin_transfer_self_to_developer = {
      data: null,
      error: { code: "P0001", message: "actor_not_admin" },
    };
    expect((await transfer()).status).toBe(403);
  });

  it("tras transferirse el mismo token ya no es Admin: el rol se lee de la base en cada petición", async () => {
    expect((await transfer()).status).toBe(200);
    fake.roles[ADMIN_ID] = "developer"; // efecto de la transferencia
    fake.rpcCalls = [];
    expect((await statusOf()).status).toBe(403);
    expect((await transfer()).status).toBe(403);
    expect((await restore({ user_id: OTHER_ID, role: "admin" })).status).toBe(403);
    expect(fake.rpcCalls).toEqual([]);
  });
});

describe("restauración (POST)", () => {
  it("el actor sale del JWT, solo se admite admin o moderator y la RPC recibe exactamente tres datos", async () => {
    for (const role of ["moderator", "admin"]) {
      fake.rpcCalls = [];
      const r = await restore({ user_id: DEV_ID, role, p_actor_user_id: OTHER_ID });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ status: "restored", user_id: DEV_ID, role });
      expect(fake.rpcCalls).toEqual([
        {
          name: "admin_restore_developer",
          args: { p_actor_user_id: ADMIN_ID, p_target_user_id: DEV_ID, p_new_role: role },
        },
      ]);
    }
  });

  it("nunca restaura a developer ni a roles inventados; cuerpos inválidos → 400 sin RPC", async () => {
    for (const body of [
      { user_id: DEV_ID, role: "developer" },
      { user_id: DEV_ID, role: "user" },
      { user_id: DEV_ID, role: "ADMIN" },
      { user_id: DEV_ID },
      { role: "admin" },
      { user_id: "no-es-uuid", role: "admin" },
      null,
    ]) {
      expect((await restore(body)).status).toBe(400);
    }
    expect(fake.rpcCalls).toEqual([]);
  });

  it("un Admin no se restaura a sí mismo (objetivo = actor) sin llegar a la base", async () => {
    const r = await restore({ user_id: ADMIN_ID, role: "moderator" });
    expect(r.status).toBe(409);
    expect(fake.rpcCalls).toEqual([]);
  });

  it.each([
    ["not_developer", 409],
    ["recovery_in_progress", 409],
    ["mfa_not_enrolled", 409],
    ["not_found", 404],
  ])("rechazo «%s» de la base → %i controlado", async (reason, status) => {
    fake.rpc.admin_restore_developer = ok({ ok: false, reason });
    const r = await restore({ user_id: DEV_ID, role: "admin" });
    expect(r.status).toBe(status);
    expect(r.body).toMatchObject({ code: reason });
  });
});

describe("quitar acceso a un Developer (POST)", () => {
  it("el actor sale del JWT y la RPC recibe exactamente dos datos; el cuerpo no puede elegir actor", async () => {
    const r = await remove({
      user_id: DEV_ID,
      p_actor_user_id: OTHER_ID,
      actor: OTHER_ID,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      status: "removed",
      user_id: DEV_ID,
      last_developer: false,
      mfa_reset: { status: "completed", factors_deleted: 1 },
    });
    expect(fake.rpcCalls[0]).toEqual({
      name: "admin_remove_developer",
      args: { p_actor_user_id: ADMIN_ID, p_target_user_id: DEV_ID },
    });
    expect(r.headers["Cache-Control"]).toMatch(/no-store/);
  });

  it("avisa cuando era el último Developer", async () => {
    fake.rpc.admin_remove_developer = ok({
      ok: true,
      lastDeveloper: true,
      mfaFactorCount: 0,
    });
    const r = await remove({ user_id: DEV_ID });
    expect(r.body).toEqual({
      status: "removed",
      user_id: DEV_ID,
      last_developer: true,
      mfa_reset: { status: "not_needed" },
    });
  });

  it("cuerpos inválidos → 400 sin RPC; un Admin no se retira a sí mismo (409) sin llegar a la base", async () => {
    for (const body of [{}, { user_id: "no-es-uuid" }, { user_id: 5 }, null, "x"]) {
      expect((await remove(body)).status).toBe(400);
    }
    const self = await remove({ user_id: ADMIN_ID });
    expect(self.status).toBe(409);
    expect(self.body).toMatchObject({ code: "not_allowed" });
    expect(fake.rpcCalls).toEqual([]);
  });

  it.each([
    ["not_developer", 409],
    ["recovery_in_progress", 409],
    ["approval_in_progress", 409],
    ["recovery_depends_on_developer", 409],
    ["mfa_cleanup_pending", 409],
    ["not_found", 404],
  ])(
    "rechazo «%s» de la base → %i controlado, sin detalles internos",
    async (reason, status) => {
      fake.rpc.admin_remove_developer = ok({ ok: false, reason });
      const r = await remove({ user_id: DEV_ID });
      expect(r.status).toBe(status);
      expect(r.body).toEqual({ error: "Operación no permitida", code: reason });
      // un rechazo nunca dispara la limpieza MFA
      expect(fake.deleteCalls).toEqual([]);
      expect(rpcNames()).toEqual(["admin_remove_developer"]);
    },
  );

  it("un motivo desconocido o un error de la base → 500 genérico (sin filtrar el error)", async () => {
    fake.rpc.admin_remove_developer = ok({ ok: false, reason: "algo_raro" });
    const a = await remove({ user_id: DEV_ID });
    expect(a.status).toBe(500);
    fake.rpc.admin_remove_developer = {
      data: null,
      error: { code: "P0001", message: "detalle interno secreto" },
    };
    const b = await remove({ user_id: DEV_ID });
    expect(b.status).toBe(500);
    expect(JSON.stringify(b.body)).not.toContain("secreto");
  });
});

describe("quitar acceso a un Developer: limpieza MFA con el flujo existente", () => {
  const recordCalls = () =>
    fake.rpcCalls.filter((c) => c.name === "admin_mfa_reset_record");

  it("tras confirmar la retirada borra EXACTAMENTE los ids de la instantánea y registra el resultado", async () => {
    const r = await remove({ user_id: DEV_ID });
    expect(r.status).toBe(200);
    expect(rpcNames()).toEqual([
      "admin_remove_developer",
      "admin_mfa_pending_reset",
      "admin_mfa_reset_record",
    ]);
    expect(fake.rpcCalls[1].args).toEqual({ p_user_id: DEV_ID });
    expect(fake.deleteCalls).toEqual([{ id: FACTOR_ID, userId: DEV_ID }]);
    expect(recordCalls()[0].args).toEqual({
      p_reset_id: RESET_ID,
      p_ok: true,
      p_factors_deleted: 1,
      p_error_class: null,
    });
  });

  it("el cliente no puede influir en qué factores se borran: el cuerpo solo nombra al objetivo", async () => {
    await remove({
      user_id: DEV_ID,
      factor_ids: ["99999999-9999-4999-8999-999999999999"],
    });
    expect(fake.deleteCalls).toEqual([{ id: FACTOR_ID, userId: DEV_ID }]);
  });

  it("si el borrado falla, la retirada SIGUE confirmada, la limpieza queda PENDIENTE y nunca se afirma que se completó", async () => {
    fake.deleteResults = [{ error: { status: 500, message: "detalle interno secreto" } }];
    const r = await remove({ user_id: DEV_ID });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      status: "removed",
      mfa_reset: { status: "pending", error_class: "auth_delete_failed" },
    });
    expect(JSON.stringify(r.body)).not.toContain("secreto");
    expect(recordCalls()[0].args).toMatchObject({
      p_ok: false,
      p_error_class: "auth_delete_failed",
    });
    // no se revirtió nada ni se intentó devolver el rol
    expect(rpcNames().filter((n) => n === "admin_remove_developer")).toHaveLength(1);
    expect(rpcNames()).not.toContain("admin_restore_developer");
  });

  it("un factor que sigue presente tras el borrado deja la limpieza pendiente", async () => {
    fake.authList = { data: { factors: [{ id: FACTOR_ID }] }, error: null };
    const r = await remove({ user_id: DEV_ID });
    expect(r.body).toMatchObject({
      mfa_reset: { status: "pending", error_class: "factor_still_present" },
    });
  });

  it("un factor nuevo del usuario (otro id) no impide completar ni se borra", async () => {
    fake.authList = {
      data: { factors: [{ id: "88888888-8888-4888-8888-888888888888" }] },
      error: null,
    };
    const r = await remove({ user_id: DEV_ID });
    expect(r.body).toMatchObject({
      mfa_reset: { status: "completed", factors_deleted: 1 },
    });
    expect(fake.deleteCalls).toEqual([{ id: FACTOR_ID, userId: DEV_ID }]);
  });

  it("un factor que ya no existe (404) cuenta como resuelto", async () => {
    fake.deleteResults = [{ error: { status: 404, code: "mfa_factor_not_found" } }];
    const r = await remove({ user_id: DEV_ID });
    expect(r.body).toMatchObject({
      mfa_reset: { status: "completed", factors_deleted: 0 },
    });
  });

  it("si no se puede leer la limpieza pendiente o no se puede registrar el resultado: pendiente, jamás «completada»", async () => {
    fake.rpc.admin_mfa_pending_reset = {
      data: null,
      error: { code: "XX000", message: "boom" },
    };
    const a = await remove({ user_id: DEV_ID });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({
      mfa_reset: { status: "pending", error_class: "cleanup_unavailable" },
    });
    fake.rpc.admin_mfa_pending_reset = ok([
      { out_reset_id: RESET_ID, out_factor_ids: [FACTOR_ID] },
    ]);
    fake.rpc.admin_mfa_reset_record = {
      data: null,
      error: { code: "XX000", message: "boom" },
    };
    const b = await remove({ user_id: DEV_ID });
    expect(b.body).toMatchObject({
      mfa_reset: { status: "pending", error_class: "record_failed" },
    });
  });

  it("sin factores no se llama a Supabase Auth: not_needed", async () => {
    fake.rpc.admin_remove_developer = ok({
      ok: true,
      lastDeveloper: false,
      mfaFactorCount: 0,
    });
    const r = await remove({ user_id: DEV_ID });
    expect(r.body).toMatchObject({ mfa_reset: { status: "not_needed" } });
    expect(fake.deleteCalls).toEqual([]);
    expect(rpcNames()).toEqual(["admin_remove_developer"]);
  });
});

describe("el módulo no abre un permiso genérico para asignar Developer", () => {
  it("solo usa las dos RPC acotadas y nunca change_admin_member_role ni un rol developer libre", () => {
    const src = readFileSync(
      resolve("src/lib/developer-transition-handlers.ts"),
      "utf8",
    ).replace(/\/\/.*$/gm, "");
    // la limpieza MFA se REUTILIZA (cleanupAfterRemoval); este módulo no borra factores por su cuenta
    expect(src).not.toMatch(/change_admin_member_role|operator_|deleteFactor|admin\.mfa/);
    expect(src).toMatch(/cleanupAfterRemoval/);
    expect(src).not.toMatch(/p_new_role:\s*"developer"/);
    const rpcs = [...src.matchAll(/"(admin_[a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(rpcs)).toEqual(
      new Set([
        "admin_transfer_status",
        "admin_transfer_self_to_developer",
        "admin_restore_developer",
        "admin_remove_developer",
      ]),
    );
  });
});

describe("compatibilidad: el cambio de rol normal Admin ↔ Moderator no se ve afectado", () => {
  it("la ruta team-members-role sigue rechazando developer en el cuerpo (400) y no llega a la base", async () => {
    const r = await call({
      action: "team-members-role",
      token: "jwt-admin-fresh",
      body: { user_id: OTHER_ID, role: "developer" },
    });
    expect(r.status).toBe(400);
    expect(rpcNames()).not.toContain("change_admin_member_role");
  });
});
