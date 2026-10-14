import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import router from "../../api/admin/[action]";

// Developer Panel V1 — contrato HTTP del rol Developer. Se ejecutan el despachador, los handlers,
// requireAuthenticated/requireCapability y el ADAPTADOR de Resend REALES; el cliente de Supabase y
// fetch (Resend) son dobles. Las reglas de elegibilidad, estado y bloqueo viven en SQL y se prueban
// contra PostgreSQL real (developer-panel-migration.test.ts). Ningún dato de este archivo es real.

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const MOD_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ID = "44444444-4444-4444-8444-444444444444";
const DEV_ID = "55555555-5555-4555-8555-555555555555";
const REC_ID = "99999999-9999-4999-8999-999999999999";

const nowS = () => Math.floor(Date.now() / 1000);
const pw = (ago = 0) => ({ method: "password", timestamp: nowS() - ago });
const totp = (ago = 0) => ({ method: "totp", timestamp: nowS() - ago });
const TOKENS: Record<string, Record<string, unknown>> = {
  "jwt-dev-fresh": { sub: DEV_ID, aal: "aal2", amr: [pw(7200), totp(10)] },
  "jwt-dev-4min": { sub: DEV_ID, aal: "aal2", amr: [pw(7200), totp(240)] },
  "jwt-dev-10min": { sub: DEV_ID, aal: "aal2", amr: [pw(7200), totp(600)] },
  "jwt-dev-stale": { sub: DEV_ID, aal: "aal2", amr: [pw(7200), totp(3600)] },
  "jwt-dev-aal1": { sub: DEV_ID, aal: "aal1", amr: [pw(30)] },
  "jwt-dev-future": { sub: DEV_ID, aal: "aal2", amr: [pw(7200), totp(-3600)] },
  "jwt-admin-fresh": { sub: ADMIN_ID, aal: "aal2", amr: [pw(7200), totp(10)] },
  "jwt-mod-fresh": { sub: MOD_ID, aal: "aal2", amr: [pw(7200), totp(10)] },
  "jwt-user-aal1": { sub: USER_ID, aal: "aal1", amr: [pw(30)] },
};

type Rpc = (args: Record<string, unknown>) => { data: unknown; error: unknown };
const fake = vi.hoisted(() => ({
  roles: {} as Record<string, string | undefined>,
  rpc: {} as Record<string, unknown>,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  deleteCalls: [] as { id: string; userId: string }[],
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      admin: {
        mfa: {
          deleteFactor: async (p: { id: string; userId: string }) => {
            fake.deleteCalls.push(p);
            return { error: null };
          },
          listFactors: async () => ({ data: { factors: [] }, error: null }),
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
const cleanups = (token: string | null = "jwt-dev-fresh", method = "GET") =>
  call({ action: "developer-mfa-cleanups", method, token });
const list = (token: string | null = "jwt-dev-fresh") =>
  call({ action: "developer-mfa-recoveries", method: "GET", token });
const decide = (body: unknown, token: string | null = "jwt-dev-fresh") =>
  call({ action: "developer-mfa-recoveries", method: "POST", body, token });

const ok = (data: unknown) => ({ data, error: null });
const sent = vi.fn();
const resendFetch = vi.fn();
const rpcNames = () => fake.rpcCalls.map((c) => c.name);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const READY = { ready: true, readyAt: null, remainingSeconds: 0, cooldownMinutes: 60 };
const LIST_ROW = {
  out_id: REC_ID,
  out_username: "unica_admin",
  out_role: "admin",
  out_status: "pending_approval",
  out_requested_at: "2026-11-01T10:00:00Z",
  out_email_verified_at: "2026-11-01T10:03:00Z",
  out_expires_at: "2026-11-02T10:00:00Z",
  out_approved_at: null,
  out_approval_kind: "peer",
  out_approver_role: null,
  out_approver_username: null,
  out_notice_state: null,
  out_readiness: "not_approved",
  out_eligible: true,
  out_closed_reason: null,
};

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-ficticia");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-service-role-ficticia");
  vi.stubEnv("MFA_RECOVERY_RESEND_API_KEY", "re_clave_sintetica");
  vi.stubEnv("MFA_RECOVERY_MAIL_FROM", "Upminaa <avisos@mail.example.test>");
  vi.stubEnv("MFA_RECOVERY_APP_URL", "https://dev.example.test/");
  fake.roles = {
    [ADMIN_ID]: "admin",
    [MOD_ID]: "moderator",
    [DEV_ID]: "developer",
  };
  fake.rpc = {
    admin_mfa_recovery_mail_start: (a: Record<string, unknown>) =>
      ok({
        shouldSend: true,
        state: "pending",
        providerKey: `${String(a.p_base_key)}:1`,
      }),
    admin_mfa_recovery_mail_result: ok("accepted"),
    admin_mfa_recoveries_exceptional: ok([LIST_ROW]),
    admin_developer_cooldown: ok(READY),
    admin_mfa_cleanups_for_developer: ok([]),
  };
  fake.rpcCalls = [];
  fake.deleteCalls = [];
  sent.mockReset();
  resendFetch.mockReset();
  resendFetch.mockImplementation(
    async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      sent(JSON.parse(init.body), init.headers);
      return { ok: true, status: 200, json: async () => ({ id: "resend-msg-1" }) };
    },
  );
  vi.stubGlobal("fetch", resendFetch);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("autorización: Developer y Admin son roles independientes", () => {
  it("sin sesión 401; usuario sin rol, moderator y ADMIN reciben 403 en TODAS las rutas Developer y no llega ninguna RPC", async () => {
    for (const token of ["jwt-user-aal1", "jwt-mod-fresh", "jwt-admin-fresh"]) {
      expect((await cleanups(token)).status).toBe(403);
      expect((await cleanups(token, "POST")).status).toBe(403);
      expect((await list(token)).status).toBe(403);
      expect((await decide({ op: "approve", recovery_id: REC_ID }, token)).status).toBe(
        403,
      );
    }
    expect((await cleanups(null)).status).toBe(401);
    expect((await list(null)).status).toBe(401);
    expect((await decide({ op: "approve", recovery_id: REC_ID }, null)).status).toBe(401);
    expect(fake.rpcCalls).toEqual([]);
    expect(resendFetch).not.toHaveBeenCalled();
  });

  it("un 403 de rol/capacidad nunca lleva step_up_required (MFA no concede permisos)", async () => {
    const r = await list("jwt-admin-fresh");
    expect(r.body).toEqual({ error: "No autorizado" });
  });

  it("Developer NO hereda capacidades de Admin: las rutas de Admin le responden 403", async () => {
    for (const [action, method, body] of [
      ["mfa-recovery-admin", "GET", undefined],
      ["mfa-recovery-admin", "POST", { op: "approve", recovery_id: REC_ID }],
      ["team-members", "GET", undefined],
      ["team-members-role", "POST", { user_id: OTHER_ID, role: "admin" }],
      ["team-members-remove", "POST", { user_id: OTHER_ID }],
    ] as const) {
      const r = await call({ action, method, body, token: "jwt-dev-fresh" });
      expect(r.status, `${method} ${action}`).toBe(403);
    }
    expect(fake.rpcCalls).toEqual([]);
    expect(fake.deleteCalls).toEqual([]);
  });

  it("MFA: aal1, TOTP antiguo o con timestamp futuro no bastan ni para leer", async () => {
    for (const token of ["jwt-dev-aal1", "jwt-dev-stale", "jwt-dev-future"]) {
      const r = await list(token);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: "step_up_required" });
    }
    expect(fake.rpcCalls).toEqual([]);
  });

  it("método no admitido → 405", async () => {
    expect((await cleanups("jwt-dev-fresh", "PUT")).status).toBe(405);
    expect((await cleanups("jwt-dev-fresh", "DELETE")).status).toBe(405);
    expect(
      (
        await call({
          action: "developer-mfa-recoveries",
          method: "DELETE",
          token: "jwt-dev-fresh",
        })
      ).status,
    ).toBe(405);
  });
});

describe("autorización reforzada: aprobar y rechazar exigen un TOTP de ≤ 5 minutos", () => {
  it("un TOTP de 10 minutos permite LEER pero no decidir (step_up_required y ninguna RPC de escritura)", async () => {
    expect((await list("jwt-dev-10min")).status).toBe(200);
    fake.rpcCalls = [];
    for (const op of ["approve", "deny", "resend_notice"]) {
      const r = await decide({ op, recovery_id: REC_ID, reason: "x" }, "jwt-dev-10min");
      expect(r.status, op).toBe(403);
      expect(r.body).toMatchObject({ code: "step_up_required" });
    }
    expect(fake.rpcCalls).toEqual([]);
    expect(resendFetch).not.toHaveBeenCalled();
  });

  it("un TOTP de 4 minutos sí permite decidir", async () => {
    fake.rpc.admin_mfa_recovery_approve_exceptional = ok({
      ok: true,
      recoveryId: REC_ID,
      userId: ADMIN_ID,
      cancelRotation: 1,
      email: "admin@example.test",
    });
    const r = await decide({ op: "approve", recovery_id: REC_ID }, "jwt-dev-4min");
    expect(r.status).toBe(200);
  });
});

describe("limpiezas de MFA: lectura", () => {
  it("devuelve el estado de cada operación sin ids de factores, hashes ni correos completos", async () => {
    fake.rpc.admin_mfa_cleanups_for_developer = ok([
      {
        out_status: "pending",
        out_old_role: "moderator",
        out_requested_at: "2026-11-01T10:00:00Z",
        out_completed_at: null,
        out_attempts: 3,
        out_last_attempt_at: "2026-11-01T10:05:00Z",
        out_last_error_class: "auth_delete_failed",
        out_factor_count: 1,
        out_factors_deleted: null,
        out_username: "moderadora",
        out_email_masked: "m***@e***.com",
        // un campo inesperado de la base NO debe filtrarse al navegador
        out_factor_ids: ["fffffff1-ffff-4fff-8fff-fffffffffff1"],
        out_user_id: MOD_ID,
      },
    ]);
    const r = await cleanups();
    expect(r.status).toBe(200);
    expect(r.headers["Cache-Control"]).toBe("no-store");
    expect(r.body).toEqual({
      cleanups: [
        {
          status: "pending",
          previous_role: "moderator",
          requested_at: "2026-11-01T10:00:00Z",
          completed_at: null,
          attempts: 3,
          last_attempt_at: "2026-11-01T10:05:00Z",
          last_error_class: "auth_delete_failed",
          factor_count: 1,
          factors_deleted: null,
          username: "moderadora",
          email_masked: "m***@e***.com",
        },
      ],
    });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("fffffff1");
    expect(text).not.toContain(MOD_ID);
    expect(fake.rpcCalls).toEqual([
      { name: "admin_mfa_cleanups_for_developer", args: { p_actor_user_id: DEV_ID } },
    ]);
  });

  it("no ejecuta ni reintenta ninguna limpieza: ningún borrado de factores ni RPC de escritura", async () => {
    await cleanups();
    expect(fake.deleteCalls).toEqual([]);
    expect(rpcNames()).toEqual(["admin_mfa_cleanups_for_developer"]);
    expect(
      rpcNames().some((n) => /record|reset_record|complete|begin_execute/.test(n)),
    ).toBe(false);
  });

  it("forma inesperada o fallo de la base → 500 genérico; actor_not_developer de la base → 403", async () => {
    fake.rpc.admin_mfa_cleanups_for_developer = ok([{ out_status: "raro" }]);
    expect(await cleanups()).toMatchObject({
      status: 500,
      body: { error: "Error interno" },
    });
    fake.rpc.admin_mfa_cleanups_for_developer = {
      data: null,
      error: { code: "XX000", message: "detalle interno sensible" },
    };
    const r = await cleanups();
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("sensible");
    fake.rpc.admin_mfa_cleanups_for_developer = {
      data: null,
      error: { code: "P0001", message: "actor_not_developer" },
    };
    expect((await cleanups()).status).toBe(403);
  });

  it("el módulo de Developer solo borra factores mediante el limpiador compartido (instantánea de la BD)", () => {
    // Solo el CÓDIGO: los comentarios pueden mencionar el mecanismo que NO se usa aquí.
    const src = readFileSync(
      resolve("src/lib/developer-panel-handlers.ts"),
      "utf8",
    ).replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/deleteFactor|runRecoveryDeletion|admin\.mfa/);
    expect(src).not.toMatch(/mfa_reset_record|begin_execute|record_execution/);
  });
});

describe("recuperaciones excepcionales: lista", () => {
  it("devuelve solo campos de presentación, sin correo ni identificadores del titular", async () => {
    const r = await list();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      recoveries: [
        {
          id: REC_ID,
          username: "unica_admin",
          role: "admin",
          status: "pending_approval",
          requested_at: "2026-11-01T10:00:00Z",
          email_verified_at: "2026-11-01T10:03:00Z",
          expires_at: "2026-11-02T10:00:00Z",
          approved_at: null,
          approval_kind: "peer",
          approver_role: null,
          approver_username: null,
          notice_state: null,
          readiness: "not_approved",
          eligible: true,
          closed_reason: null,
        },
      ],
      cooldown: {
        ready: true,
        ready_at: null,
        remaining_seconds: 0,
        cooldown_minutes: 60,
      },
    });
    expect(fake.rpcCalls).toEqual([
      { name: "admin_mfa_recoveries_exceptional", args: { p_actor_user_id: DEV_ID } },
      { name: "admin_developer_cooldown", args: { p_actor_user_id: DEV_ID } },
    ]);
  });
});

describe("aprobación excepcional", () => {
  const approveOk = (over: Record<string, unknown> = {}) =>
    ok({
      ok: true,
      recoveryId: REC_ID,
      userId: ADMIN_ID,
      cancelRotation: 1,
      email: "admin@example.test",
      ...over,
    });

  it("el actor sale del JWT (nunca del body), la base recibe solo el hash del token y el correo lo indica en inglés", async () => {
    fake.rpc.admin_mfa_recovery_approve_exceptional = approveOk();
    const r = await decide({
      op: "approve",
      recovery_id: REC_ID,
      p_actor_user_id: OTHER_ID,
      actor: OTHER_ID,
      user_id: OTHER_ID,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      status: "approved",
      approval_kind: "exceptional",
      notice: { status: "accepted" },
    });
    const call = fake.rpcCalls.find(
      (c) => c.name === "admin_mfa_recovery_approve_exceptional",
    );
    expect(call?.args).toMatchObject({ p_recovery_id: REC_ID, p_actor_user_id: DEV_ID });
    expect(call?.args.p_cancel_hash).toMatch(/^[0-9a-f]{64}$/);

    expect(sent).toHaveBeenCalledTimes(1);
    const mail = sent.mock.calls[0][0] as {
      to: string[] | string;
      subject: string;
      text: string;
      html: string;
    };
    expect(String(mail.to)).toContain("admin@example.test");
    expect(mail.subject).toMatch(/approved/i);
    expect(mail.text).toMatch(/authorized by a platform Developer/);
    expect(mail.text).toMatch(/no other administrator was available/);
    const token = /recovery\/cancel#t=([A-Za-z0-9_-]{43})/.exec(mail.text)?.[1];
    expect(token).toBeTruthy();
    expect(sha(token!)).toBe(call?.args.p_cancel_hash); // la base solo conoce el hash
    // el token no viaja en la respuesta HTTP
    expect(JSON.stringify(r.body)).not.toContain(token!);
    expect(mail.text).toMatch(/^[\x20-\x7e\n]+$/); // inglés / ASCII
  });

  it("es idempotente: un segundo intento no envía otro correo ni repite efectos", async () => {
    let n = 0;
    fake.rpc.admin_mfa_recovery_approve_exceptional = () =>
      n++ === 0
        ? approveOk()
        : ok({ ok: false, reason: "not_pending", status: "approved" });
    expect((await decide({ op: "approve", recovery_id: REC_ID })).status).toBe(200);
    const second = await decide({ op: "approve", recovery_id: REC_ID });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: "Operación no permitida", code: "not_pending" });
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["peer_available", 409],
    ["not_eligible", 409],
    ["self_approval", 403],
    ["not_pending", 409],
    ["expired", 410],
    ["email_changed", 409],
    ["role_changed", 409],
    ["not_found", 404],
  ])("rechazo de la base «%s» → %s controlado y sin correo", async (reason, status) => {
    fake.rpc.admin_mfa_recovery_approve_exceptional = ok({ ok: false, reason });
    const r = await decide({ op: "approve", recovery_id: REC_ID });
    expect(r.status).toBe(status);
    expect(sent).not.toHaveBeenCalled();
  });

  it("un motivo desconocido o un error de la base → 500 genérico, sin detalles", async () => {
    fake.rpc.admin_mfa_recovery_approve_exceptional = ok({
      ok: false,
      reason: "algo_raro",
    });
    expect((await decide({ op: "approve", recovery_id: REC_ID })).status).toBe(500);
    fake.rpc.admin_mfa_recovery_approve_exceptional = {
      data: null,
      error: { code: "XX000", message: "detalle interno" },
    };
    const r = await decide({ op: "approve", recovery_id: REC_ID });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("interno ");
  });

  it("si Resend falla o no está configurado la aprobación queda registrada y se informa el aviso", async () => {
    fake.rpc.admin_mfa_recovery_approve_exceptional = approveOk();
    resendFetch.mockImplementation(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));
    fake.rpc.admin_mfa_recovery_mail_result = ok("failed");
    const failed = await decide({ op: "approve", recovery_id: REC_ID });
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({
      status: "approved",
      notice: { status: "failed" },
    });

    vi.stubEnv("MFA_RECOVERY_RESEND_API_KEY", "");
    const none = await decide({ op: "approve", recovery_id: REC_ID });
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ notice: { status: "not_attempted" } });
  });

  it("no hay operación para borrar factores y un cuerpo inválido es 400", async () => {
    for (const body of [
      { op: "delete_factors", recovery_id: REC_ID },
      { op: "execute", recovery_id: REC_ID },
      { op: "complete", recovery_id: REC_ID },
      { op: "approve", recovery_id: "no-es-uuid" },
      { op: "approve" },
      { recovery_id: REC_ID },
      null,
    ]) {
      expect((await decide(body)).status).toBe(400);
    }
    expect(fake.rpcCalls).toEqual([]);
    expect(fake.deleteCalls).toEqual([]);
  });
});

describe("rechazo excepcional", () => {
  it("envía el motivo a la base, avisa al titular y no expone el motivo en la respuesta", async () => {
    fake.rpc.admin_mfa_recovery_deny_exceptional = ok({
      ok: true,
      recoveryId: REC_ID,
      userId: ADMIN_ID,
      email: "admin@example.test",
    });
    const r = await decide({
      op: "deny",
      recovery_id: REC_ID,
      reason: "No reconozco la petición",
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "denied", notice: { status: "accepted" } });
    const call = fake.rpcCalls.find(
      (c) => c.name === "admin_mfa_recovery_deny_exceptional",
    );
    expect(call?.args).toEqual({
      p_recovery_id: REC_ID,
      p_actor_user_id: DEV_ID,
      p_reason: "No reconozco la petición",
    });
    const mail = sent.mock.calls[0][0] as { text: string };
    expect(mail.text).toMatch(/rejected/);
    expect(mail.text).not.toContain("No reconozco");
  });

  it("motivo vacío y rechazos de la base se traducen sin enviar correo", async () => {
    fake.rpc.admin_mfa_recovery_deny_exceptional = ok({
      ok: false,
      reason: "reason_required",
    });
    expect((await decide({ op: "deny", recovery_id: REC_ID, reason: "" })).status).toBe(
      400,
    );
    fake.rpc.admin_mfa_recovery_deny_exceptional = ok({
      ok: false,
      reason: "peer_available",
    });
    expect((await decide({ op: "deny", recovery_id: REC_ID, reason: "x" })).status).toBe(
      409,
    );
    expect(sent).not.toHaveBeenCalled();
  });
});

describe("reenvío del aviso de una aprobación excepcional", () => {
  const approvedRow = (over: Record<string, unknown> = {}) => ({
    ...LIST_ROW,
    out_status: "approved",
    out_approval_kind: "exceptional",
    out_approver_role: "developer",
    out_notice_state: "failed",
    out_eligible: false,
    ...over,
  });

  it("rota el token (solo su hash a la base), conserva el texto «autorizado por Developer» y usa otra clave", async () => {
    fake.rpc.admin_mfa_recoveries_exceptional = ok([approvedRow()]);
    fake.rpc.admin_mfa_recovery_set_cancel = ok({
      ok: true,
      recoveryId: REC_ID,
      cancelRotation: 2,
      email: "admin@example.test",
    });
    const r = await decide({ op: "resend_notice", recovery_id: REC_ID });
    expect(r.status).toBe(200);
    const set = fake.rpcCalls.find((c) => c.name === "admin_mfa_recovery_set_cancel");
    expect(set?.args.p_cancel_hash).toMatch(/^[0-9a-f]{64}$/);
    const start = fake.rpcCalls.find((c) => c.name === "admin_mfa_recovery_mail_start");
    expect(String(start?.args.p_base_key)).toBe(`recovery:${REC_ID}:approved:2`);
    expect((sent.mock.calls[0][0] as { text: string }).text).toMatch(
      /platform Developer/,
    );
  });

  it("con el aviso ya entregado envía un recordatorio sin enlace (sin rotar el token ni tocar el estado); límites de la base → 429/409", async () => {
    fake.rpc.admin_mfa_recoveries_exceptional = ok([
      approvedRow({ out_notice_state: "delivered" }),
    ]);
    fake.rpc.admin_mfa_recovery_reminder_start = ok({
      ok: true,
      recoveryId: REC_ID,
      baseKey: `recovery:${REC_ID}:reminder:1`,
      number: 1,
      email: "admin@example.test",
    });
    const r = await decide({ op: "resend_notice", recovery_id: REC_ID });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "approved", reminder: { status: "accepted" } });
    expect(rpcNames()).not.toContain("admin_mfa_recovery_set_cancel");
    expect(
      fake.rpcCalls.find((c) => c.name === "admin_mfa_recovery_reminder_start")?.args,
    ).toEqual({ p_recovery_id: REC_ID, p_actor_user_id: DEV_ID });
    const mail = sent.mock.calls[0][0] as { subject: string; text: string };
    expect(mail.subject).toBe("Upminaa Web: reminder about your authenticator reset");
    expect(mail.text).not.toMatch(/#t=|\/cancel/);
    for (const [reason, status] of [
      ["too_soon", 429],
      ["reminder_limit", 429],
      ["notice_not_delivered", 409],
    ] as const) {
      sent.mockClear();
      fake.rpc.admin_mfa_recovery_reminder_start = ok({ ok: false, reason });
      expect((await decide({ op: "resend_notice", recovery_id: REC_ID })).status).toBe(
        status,
      );
      expect(sent).not.toHaveBeenCalled();
    }
  });

  it("no reenvía una aprobación entre administradores ni una solicitud ajena a la lista", async () => {
    fake.rpc.admin_mfa_recoveries_exceptional = ok([
      approvedRow({ out_approval_kind: "peer" }),
    ]);
    expect((await decide({ op: "resend_notice", recovery_id: REC_ID })).status).toBe(404);
    fake.rpc.admin_mfa_recoveries_exceptional = ok([]);
    expect((await decide({ op: "resend_notice", recovery_id: REC_ID })).status).toBe(404);
    expect(rpcNames()).not.toContain("admin_mfa_recovery_set_cancel");
    expect(sent).not.toHaveBeenCalled();
  });
});

describe("compatibilidad con la fase 2", () => {
  it("la aprobación normal de un Admin sigue enviando el texto «An administrator approved…» (sin «Developer»)", async () => {
    fake.rpc.admin_mfa_recovery_approve = ok({
      ok: true,
      recoveryId: REC_ID,
      userId: MOD_ID,
      cancelRotation: 1,
      email: "mod@example.test",
    });
    const r = await call({
      action: "mfa-recovery-admin",
      token: "jwt-admin-fresh",
      body: { op: "approve", recovery_id: REC_ID },
    });
    expect(r.status).toBe(200);
    const text = (sent.mock.calls[0][0] as { text: string }).text;
    expect(text).toMatch(/An administrator approved your request/);
    expect(text).not.toMatch(/Developer/);
    expect(rpcNames()).not.toContain("admin_mfa_recovery_approve_exceptional");
  });

  it("la RPC de aprobación normal sigue siendo la de siempre y un Developer no puede llamarla", async () => {
    const r = await call({
      action: "mfa-recovery-admin",
      token: "jwt-dev-fresh",
      body: { op: "approve", recovery_id: REC_ID },
    });
    expect(r.status).toBe(403);
    expect(rpcNames()).not.toContain("admin_mfa_recovery_approve");
  });
});

describe("espera de seguridad tras la autotransferencia", () => {
  const WAITING = {
    ready: false,
    readyAt: "2026-11-02T11:00:00.000Z",
    remainingSeconds: 1800,
    cooldownMinutes: 60,
  };

  it("la lista informa el tiempo restante (la fuente es la base de datos, no el navegador)", async () => {
    fake.rpc.admin_developer_cooldown = ok(WAITING);
    const r = await list();
    expect(r.status).toBe(200);
    expect((r.body as { cooldown: unknown }).cooldown).toEqual({
      ready: false,
      ready_at: "2026-11-02T11:00:00.000Z",
      remaining_seconds: 1800,
      cooldown_minutes: 60,
    });
  });

  it("aprobar durante la espera: 409 cooldown_active con el tiempo restante, sin llamar a la aprobación ni enviar correo", async () => {
    fake.rpc.admin_developer_cooldown = ok(WAITING);
    const r = await decide({ op: "approve", recovery_id: REC_ID });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({
      error: "Operación no permitida",
      code: "cooldown_active",
      ready_at: "2026-11-02T11:00:00.000Z",
      remaining_seconds: 1800,
    });
    expect(rpcNames()).not.toContain("admin_mfa_recovery_approve_exceptional");
    expect(sent).not.toHaveBeenCalled();
  });

  it("la SQL es autoritativa: si rechaza con cooldown_active (carrera o configuración nueva) la respuesta es la misma", async () => {
    let calls = 0;
    fake.rpc.admin_developer_cooldown = () => ok(calls++ === 0 ? READY : WAITING);
    fake.rpc.admin_mfa_recovery_approve_exceptional = ok({
      ok: false,
      reason: "cooldown_active",
      readyAt: "2026-11-02T11:00:00.000Z",
    });
    const r = await decide({ op: "approve", recovery_id: REC_ID });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "cooldown_active", remaining_seconds: 1800 });
    expect(sent).not.toHaveBeenCalled();
  });

  it("rechazar y reenviar el aviso NO dependen de la espera", async () => {
    fake.rpc.admin_developer_cooldown = ok(WAITING);
    fake.rpc.admin_mfa_recovery_deny_exceptional = ok({
      ok: true,
      recoveryId: REC_ID,
      userId: ADMIN_ID,
      email: "admin@example.test",
    });
    const r = await decide({
      op: "deny",
      recovery_id: REC_ID,
      reason: "No lo reconozco",
    });
    expect(r.status).toBe(200);
    expect(rpcNames()).not.toContain("admin_developer_cooldown");
  });

  it("una respuesta inesperada de la base cierra en fallo (500 genérico) y nunca aprueba", async () => {
    fake.rpc.admin_developer_cooldown = ok({ ready: "si" });
    const r = await decide({ op: "approve", recovery_id: REC_ID });
    expect(r.status).toBe(500);
    expect(rpcNames()).not.toContain("admin_mfa_recovery_approve_exceptional");
  });

  it("el cuerpo no puede acortar la espera: cualquier campo de tiempo se ignora", async () => {
    fake.rpc.admin_developer_cooldown = ok(WAITING);
    const r = await decide({
      op: "approve",
      recovery_id: REC_ID,
      cooldown_minutes: 0,
      ready: true,
      skip_cooldown: true,
    });
    expect(r.status).toBe(409);
    expect(rpcNames()).not.toContain("admin_mfa_recovery_approve_exceptional");
  });
});

describe("reintento manual de limpiezas de MFA (solo Developer)", () => {
  const FACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const RESET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  it("reintenta las pendientes con ids de la BD y es idempotente", async () => {
    fake.rpc.admin_mfa_cleanup_pending_ids_for_developer = ok([
      { out_user_id: OTHER_ID },
    ]);
    fake.rpc.admin_mfa_pending_reset = ok([
      { out_reset_id: RESET, out_factor_ids: [FACTOR] },
    ]);
    fake.rpc.admin_mfa_reset_record = ok(null);
    const r = await cleanups("jwt-dev-fresh", "POST");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ retried: 1, completed: 1, pending: 0 });
    expect(fake.deleteCalls).toEqual([{ id: FACTOR, userId: OTHER_ID }]);
    expect(fake.rpcCalls[0]).toEqual({
      name: "admin_mfa_cleanup_pending_ids_for_developer",
      args: { p_actor_user_id: DEV_ID },
    });
  });
  it("sin pendientes no borra nada", async () => {
    fake.rpc.admin_mfa_cleanup_pending_ids_for_developer = ok([]);
    const r = await cleanups("jwt-dev-fresh", "POST");
    expect(r.body).toEqual({ retried: 0, completed: 0, pending: 0 });
    expect(fake.deleteCalls).toEqual([]);
  });
  it("el cuerpo del cliente se ignora: no puede elegir objetivo", async () => {
    fake.rpc.admin_mfa_cleanup_pending_ids_for_developer = ok([]);
    const r = await call({
      action: "developer-mfa-cleanups",
      token: "jwt-dev-fresh",
      body: { user_id: USER_ID },
    });
    expect(r.status).toBe(200);
    expect(rpcNames()).toEqual(["admin_mfa_cleanup_pending_ids_for_developer"]);
  });
  it("fallo de lectura → error genérico sin borrar", async () => {
    fake.rpc.admin_mfa_cleanup_pending_ids_for_developer = {
      data: null,
      error: { code: "XX000" },
    };
    expect((await cleanups("jwt-dev-fresh", "POST")).status).toBeGreaterThanOrEqual(500);
    expect(fake.deleteCalls).toEqual([]);
  });
});
