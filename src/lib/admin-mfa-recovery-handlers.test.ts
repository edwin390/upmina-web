import { createHash, createHmac } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import router from "../../api/admin/[action]";

// MFA fase 2 — contrato HTTP de la recuperación de un autenticador perdido. Se ejecutan el
// despachador, los handlers, requireAuthenticated/requireCapability y el ADAPTADOR de Resend
// REALES; el cliente de Supabase y fetch (Resend) son dobles. Las reglas de estado, aprobación y
// caducidad viven en SQL y se prueban contra PostgreSQL real (admin-mfa-recovery-migration.test.ts).
// Ningún dato de este archivo es real.

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const MOD_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const DEV_ID = "55555555-5555-4555-8555-555555555555";
const REC_ID = "99999999-9999-4999-8999-999999999999";
const SESSION_ID = "88888888-8888-4888-8888-888888888888";
const F_OLD = "fffffff1-ffff-4fff-8fff-fffffffffff1";
const F_NEW = "fffffff2-ffff-4fff-8fff-fffffffffff2";
const WEBHOOK_SECRET =
  "whsec_" + Buffer.from("secreto-sintetico-de-prueba").toString("base64");

const nowS = () => Math.floor(Date.now() / 1000);
const pw = (ago = 0) => ({ method: "password", timestamp: nowS() - ago });
const totp = (ago = 0) => ({ method: "totp", timestamp: nowS() - ago });
const TOKENS: Record<string, Record<string, unknown>> = {
  "jwt-mod-aal1": { sub: MOD_ID, aal: "aal1", amr: [pw(30)] },
  "jwt-mod-aal1-stale-login": { sub: MOD_ID, aal: "aal1", amr: [pw(3600)] },
  "jwt-mod-aal2": {
    sub: MOD_ID,
    aal: "aal2",
    session_id: SESSION_ID,
    amr: [pw(7200), totp(10)],
  },
  "jwt-dev-aal2": { sub: DEV_ID, aal: "aal2", amr: [pw(7200), totp(10)] },
  "jwt-user-aal1": { sub: USER_ID, aal: "aal1", amr: [pw(30)] },
  "jwt-admin-aal2": { sub: ADMIN_ID, aal: "aal2", amr: [pw(7200), totp(10)] },
  "jwt-admin-stale": { sub: ADMIN_ID, aal: "aal2", amr: [pw(7200), totp(3600)] },
  // un OTP de correo NO es una comprobación de credenciales
  "jwt-mod-otp-only": {
    sub: MOD_ID,
    aal: "aal1",
    amr: [{ method: "otp", timestamp: nowS() }],
  },
};

type Rpc = (args: Record<string, unknown>) => { data: unknown; error: unknown };
const fake = vi.hoisted(() => ({
  roles: {} as Record<string, string | undefined>,
  rpc: {} as Record<string, unknown>,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  deleteCalls: [] as { id: string; userId: string }[],
  deleteErrors: [] as unknown[],
  listed: [] as { id: string }[],
  users: {} as Record<string, string>,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      admin: {
        mfa: {
          deleteFactor: async (p: { id: string; userId: string }) => {
            fake.deleteCalls.push(p);
            return { error: fake.deleteErrors.shift() ?? null };
          },
          listFactors: async () => ({ data: { factors: fake.listed }, error: null }),
        },
        getUserById: async (id: string) => ({
          data: { user: fake.users[id] ? { email: fake.users[id] } : null },
          error: null,
        }),
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
  headers?: Record<string, string>;
}) {
  const { res, state } = mockRes();
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
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
const member = (body: unknown, token: string | null = "jwt-mod-aal1") =>
  call({ action: "mfa-recovery", body, token });
const status = (token: string | null = "jwt-mod-aal1") =>
  call({ action: "mfa-recovery", method: "GET", token });
const admin = (body: unknown, token: string | null = "jwt-admin-aal2") =>
  call({ action: "mfa-recovery-admin", body, token });

const ok = (data: unknown) => ({ data, error: null });
const sent = vi.fn();
const resendFetch = vi.fn();
const rpcNames = () => fake.rpcCalls.map((c) => c.name);

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-ficticia");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-service-role-ficticia");
  vi.stubEnv("MFA_RECOVERY_RESEND_API_KEY", "re_clave_sintetica");
  vi.stubEnv("MFA_RECOVERY_MAIL_FROM", "Upminaa <avisos@mail.example.test>");
  vi.stubEnv("MFA_RECOVERY_APP_URL", "https://dev.example.test/");
  vi.stubEnv("RESEND_WEBHOOK_SECRET", WEBHOOK_SECRET);
  fake.roles = { [ADMIN_ID]: "admin", [MOD_ID]: "moderator", [DEV_ID]: "developer" };
  fake.rpc = {
    admin_mfa_recovery_mail_start: (a: Record<string, unknown>) =>
      ok({
        shouldSend: true,
        state: "pending",
        providerKey: `${String(a.p_base_key)}:1`,
      }),
    admin_mfa_recovery_mail_result: ok("accepted"),
    admin_mfa_recovery_record_execution: ok("factors_deleted"),
    admin_mfa_recovery_execution_allowed: ok(true),
  };
  fake.rpcCalls = [];
  fake.deleteCalls = [];
  fake.deleteErrors = [];
  fake.listed = [];
  fake.users = { [MOD_ID]: "mod@example.test" };
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

const tokenFromEmail = (): string => {
  const text = (sent.mock.calls[0][0] as { text: string }).text;
  const m = /#c=([A-Za-z0-9_-]{43})/.exec(text);
  expect(m).not.toBeNull();
  return m![1];
};

describe("titular — autorización", () => {
  it("sin sesión 401; sin rol privilegiado 403; método no admitido 405", async () => {
    expect((await status(null)).status).toBe(401);
    expect((await status("jwt-user-aal1")).status).toBe(403);
    expect(
      (await call({ action: "mfa-recovery", method: "DELETE", token: "jwt-mod-aal1" }))
        .status,
    ).toBe(405);
  });

  it("un moderator en aal1 puede ver SU estado (no se exige aal2: perdió el autenticador)", async () => {
    fake.rpc.admin_mfa_recovery_current = ok({ status: "none", hasApprover: true });
    const r = await status();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      status: "none",
      role: "moderator",
      recentLogin: true,
      aal: "aal1",
      mailConfigured: true,
    });
    expect(fake.rpcCalls[0].args).toEqual({ p_user_id: MOD_ID });
  });
});

describe("titular — solicitud y desafío de correo", () => {
  const createOk = (over: Record<string, unknown> = {}) =>
    ok({
      ok: true,
      recoveryId: REC_ID,
      email: "mod@example.test",
      role: "moderator",
      sends: 1,
      ...over,
    });

  it("exige credenciales recientes: sesión antigua u OTP de correo no bastan; no se llama a la base", async () => {
    for (const token of ["jwt-mod-aal1-stale-login", "jwt-mod-otp-only"]) {
      const r = await member({ op: "request" }, token);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: "recent_login_required" });
    }
    expect(rpcNames()).not.toContain("admin_mfa_recovery_create");
    expect(resendFetch).not.toHaveBeenCalled();
  });

  it("sin configuración de correo → 503 y NO se crea ninguna solicitud", async () => {
    vi.stubEnv("MFA_RECOVERY_RESEND_API_KEY", "");
    const r = await member({ op: "request" });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: "mail_unavailable" });
    expect(rpcNames()).not.toContain("admin_mfa_recovery_create");
  });

  it("crea la solicitud con el user_id del JWT (ignora el del body), guarda solo el hash y envía el desafío por Resend", async () => {
    fake.rpc.admin_mfa_recovery_create = createOk();
    const r = await member({
      op: "request",
      user_id: ADMIN_ID,
      email: "otro@example.test",
    });
    expect(r.status).toBe(200);
    const create = fake.rpcCalls.find((c) => c.name === "admin_mfa_recovery_create")!;
    expect(create.args.p_user_id).toBe(MOD_ID);
    const token = tokenFromEmail();
    expect(create.args.p_challenge_hash).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(JSON.stringify(r.body)).not.toContain(token);
    expect(JSON.stringify(fake.rpcCalls)).not.toContain(token);
    expect(r.body).toMatchObject({
      recovery_id: REC_ID,
      status: "pending_email",
      mail: { status: "accepted" },
    });
    const [payload, headers] = sent.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, string>,
    ];
    expect(payload.to).toEqual(["mod@example.test"]); // el correo REGISTRADO, no el del body
    expect(headers["Idempotency-Key"]).toBe(`recovery:${REC_ID}:challenge:1:1`);
    expect(headers.Authorization).toBe("Bearer re_clave_sintetica");
    expect(payload.text as string).toContain(
      "https://dev.example.test/admin/mfa/recovery#c=",
    );
  });

  it("un fallo de Resend NO oculta la solicitud ni afirma un envío: mail.failed con solo la clase", async () => {
    fake.rpc.admin_mfa_recovery_create = createOk();
    resendFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ message: "secreto del proveedor" }),
    });
    const r = await member({ op: "request" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      mail: { status: "failed", error_class: "provider_unavailable" },
    });
    expect(JSON.stringify(r.body)).not.toContain("secreto del proveedor");
    const result = fake.rpcCalls.find(
      (c) => c.name === "admin_mfa_recovery_mail_result",
    )!;
    expect(result.args).toMatchObject({
      p_accepted: false,
      p_error_class: "provider_unavailable",
    });
  });

  it.each([
    ["not_privileged", 403, "forbidden"],
    ["email_unverified", 409, "email_unverified"],
    ["active_request", 409, "active_request"],
    ["rate_limited", 429, "rate_limited"],
    ["no_approver", 409, "no_approver"],
  ])(
    "rechazo de la base «%s» → %i %s, sin enviar correo",
    async (reason, httpStatus, code) => {
      fake.rpc.admin_mfa_recovery_create = ok({ ok: false, reason });
      const r = await member({ op: "request" });
      expect(r.status).toBe(httpStatus);
      expect(r.body).toMatchObject({ code });
      expect(resendFetch).not.toHaveBeenCalled();
    },
  );

  it("verify: formato inválido se rechaza sin tocar la base; el correcto envía solo el hash; los fallos se traducen", async () => {
    expect((await member({ op: "verify", token: "corto" })).status).toBe(400);
    expect((await member({ op: "verify" })).status).toBe(400);
    expect(rpcNames()).not.toContain("admin_mfa_recovery_verify");
    const token = "A".repeat(43);
    fake.rpc.admin_mfa_recovery_verify = ok({ ok: true, status: "pending_approval" });
    const r = await member({ op: "verify", token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "pending_approval" });
    const call = fake.rpcCalls.find((c) => c.name === "admin_mfa_recovery_verify")!;
    expect(call.args).toEqual({
      p_user_id: MOD_ID,
      p_challenge_hash: createHash("sha256").update(token).digest("hex"),
    });
    for (const [reason, s] of [
      ["invalid", 400],
      ["locked", 423],
      ["challenge_expired", 410],
      ["email_changed", 409],
    ] as const) {
      fake.rpc.admin_mfa_recovery_verify = ok({ ok: false, reason });
      expect((await member({ op: "verify", token })).status).toBe(s);
    }
  });

  it("verify exige credenciales recientes aunque el desafío sea correcto", async () => {
    const r = await member(
      { op: "verify", token: "A".repeat(43) },
      "jwt-mod-aal1-stale-login",
    );
    expect(r.status).toBe(403);
    expect(rpcNames()).not.toContain("admin_mfa_recovery_verify");
  });

  it("cancelar usa la solicitud del propio JWT (el body no elige) y avisa del cierre", async () => {
    fake.rpc.admin_mfa_recovery_current = ok({
      status: "pending_approval",
      recoveryId: REC_ID,
    });
    fake.rpc.admin_mfa_recovery_cancel = ok({
      ok: true,
      recoveryId: REC_ID,
      email: "mod@example.test",
    });
    const r = await member({
      op: "cancel",
      recovery_id: "00000000-0000-4000-8000-000000000000",
      user_id: ADMIN_ID,
    });
    expect(r.status).toBe(200);
    const cancel = fake.rpcCalls.find((c) => c.name === "admin_mfa_recovery_cancel")!;
    expect(cancel.args).toEqual({ p_recovery_id: REC_ID, p_actor_user_id: MOD_ID });
    expect(sent).toHaveBeenCalledTimes(1);
  });
});

describe("titular — ejecución e invalidación del factor", () => {
  const begin = (ids = [F_OLD]) =>
    ok({
      ok: true,
      already: false,
      status: "executing",
      recoveryId: REC_ID,
      factorIds: ids,
    });
  beforeEach(() => {
    fake.rpc.admin_mfa_recovery_current = ok({ status: "approved", recoveryId: REC_ID });
  });

  it.each(["notice_pending", "notice_failed", "waiting", "not_approved", "role_changed"])(
    "si la base dice «%s» NO se borra ningún factor",
    async (reason) => {
      fake.rpc.admin_mfa_recovery_begin_execute = ok({ ok: false, reason });
      const r = await member({ op: "execute" });
      expect(r.status).toBe(409);
      expect(fake.deleteCalls).toHaveLength(0);
    },
  );

  it("borra EXACTAMENTE los ids de la instantánea, confirma y registra; un factor nuevo nunca se toca", async () => {
    fake.rpc.admin_mfa_recovery_begin_execute = begin();
    fake.listed = [{ id: F_NEW }]; // factor configurado después: otro id
    const r = await member({ op: "execute" });
    expect(r.body).toEqual({ status: "factors_deleted", factors_deleted: 1 });
    expect(fake.deleteCalls).toEqual([{ id: F_OLD, userId: MOD_ID }]);
    expect(
      fake.rpcCalls.find((c) => c.name === "admin_mfa_recovery_record_execution")!.args,
    ).toMatchObject({ p_ok: true, p_factors_deleted: 1 });
  });

  it("fallo parcial de Auth: 200 «executing» con solo la clase del error, registrado, reintentable", async () => {
    fake.rpc.admin_mfa_recovery_begin_execute = begin();
    fake.deleteErrors = [{ status: 500, message: "detalle interno de Auth" }];
    const r = await member({ op: "execute" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "executing", error_class: "auth_delete_failed" });
    expect(JSON.stringify(r.body)).not.toContain("detalle interno");
    expect(
      fake.rpcCalls.find((c) => c.name === "admin_mfa_recovery_record_execution")!.args,
    ).toMatchObject({ p_ok: false, p_error_class: "auth_delete_failed" });
    // reintento: ahora el factor ya no existe (404) → resuelto
    fake.deleteErrors = [{ status: 404 }];
    const again = await member({ op: "execute" });
    expect(again.body).toMatchObject({ status: "factors_deleted", factors_deleted: 0 });
  });

  it("ya ejecutada: no vuelve a borrar nada", async () => {
    fake.rpc.admin_mfa_recovery_begin_execute = ok({
      ok: true,
      already: true,
      status: "factors_deleted",
    });
    const r = await member({ op: "execute" });
    expect(r.body).toEqual({ status: "factors_deleted" });
    expect(fake.deleteCalls).toHaveLength(0);
  });

  it("si el factor sigue presente tras borrar, queda pendiente (no se declara éxito)", async () => {
    fake.rpc.admin_mfa_recovery_begin_execute = begin();
    fake.listed = [{ id: F_OLD }];
    const r = await member({ op: "execute" });
    expect(r.body).toEqual({ status: "executing", error_class: "factor_still_present" });
  });

  it("complete usa la sesión del JWT verificado, nunca la del body, y avisa una sola vez", async () => {
    fake.rpc.admin_mfa_recovery_complete = ok({
      ok: true,
      already: false,
      recoveryId: REC_ID,
      email: "mod@example.test",
    });
    const r = await member(
      { op: "complete", session_id: "00000000-0000-4000-8000-000000000000" },
      "jwt-mod-aal2",
    );
    expect(r.body).toMatchObject({ status: "completed" });
    expect(
      fake.rpcCalls.find((c) => c.name === "admin_mfa_recovery_complete")!.args,
    ).toEqual({ p_user_id: MOD_ID, p_session_id: SESSION_ID });
    expect(sent).toHaveBeenCalledTimes(1);
    fake.rpc.admin_mfa_recovery_complete = ok({
      ok: false,
      reason: "new_factor_required",
    });
    expect((await member({ op: "complete" }, "jwt-mod-aal2")).status).toBe(409);
  });
});

describe("administración", () => {
  it("solo ADMIN con MFA reciente: moderator/developer 403, MFA vencido 403 step_up, sin sesión 401", async () => {
    expect(
      (await admin({ op: "approve", recovery_id: REC_ID }, "jwt-mod-aal2")).status,
    ).toBe(403);
    expect(
      (await admin({ op: "approve", recovery_id: REC_ID }, "jwt-dev-aal2")).status,
    ).toBe(403);
    const stale = await admin({ op: "approve", recovery_id: REC_ID }, "jwt-admin-stale");
    expect(stale.status).toBe(403);
    expect(stale.body).toMatchObject({ code: "step_up_required" });
    expect((await admin({ op: "approve", recovery_id: REC_ID }, null)).status).toBe(401);
    expect(rpcNames()).not.toContain("admin_mfa_recovery_approve");
  });

  it("lista sin correo, hashes ni secretos", async () => {
    fake.rpc.admin_mfa_recoveries_pending = ok([
      {
        out_id: REC_ID,
        out_user_id: MOD_ID,
        out_username: "mina",
        out_role: "moderator",
        out_status: "pending_approval",
        out_requested_at: "2026-10-11T10:00:00Z",
        out_email_verified_at: "2026-10-11T10:01:00Z",
        out_expires_at: "2026-10-12T10:00:00Z",
        out_approved_at: null,
        out_notice_state: null,
        out_readiness: "not_approved",
      },
    ]);
    const r = await call({
      action: "mfa-recovery-admin",
      method: "GET",
      token: "jwt-admin-aal2",
    });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/email"|hash|token|@/);
    expect(
      (r.body as { recoveries: { username: string }[] }).recoveries[0].username,
    ).toBe("mina");
    expect(fake.rpcCalls[0].args).toEqual({ p_actor_user_id: ADMIN_ID });
  });

  const cancelTokenFromEmail = (): string => {
    const text = (sent.mock.calls[0][0] as { text: string }).text;
    const m = /\/admin\/mfa\/recovery\/cancel#t=([A-Za-z0-9_-]{43})/.exec(text);
    expect(m).not.toBeNull();
    return m![1];
  };

  it("aprobar usa el actor del JWT, guarda solo el hash del token de cancelación y lo envía en el aviso; la autoaprobación se traduce a 403", async () => {
    fake.rpc.admin_mfa_recovery_approve = ok({
      ok: true,
      recoveryId: REC_ID,
      cancelRotation: 1,
      email: "mod@example.test",
    });
    const r = await admin({ op: "approve", recovery_id: REC_ID, actor: MOD_ID });
    expect(r.body).toMatchObject({ status: "approved", notice: { status: "accepted" } });
    const call = fake.rpcCalls.find((c) => c.name === "admin_mfa_recovery_approve")!;
    const token = cancelTokenFromEmail();
    expect(call.args).toEqual({
      p_recovery_id: REC_ID,
      p_actor_user_id: ADMIN_ID,
      p_cancel_hash: createHash("sha256").update(token).digest("hex"),
    });
    expect(JSON.stringify(r.body)).not.toContain(token);
    expect(JSON.stringify(fake.rpcCalls)).not.toContain(token);
    expect((sent.mock.calls[0][1] as Record<string, string>)["Idempotency-Key"]).toBe(
      `recovery:${REC_ID}:approved:1:1`,
    );
    expect(sent).toHaveBeenCalledTimes(1);
    sent.mockClear();
    fake.rpc.admin_mfa_recovery_approve = ok({ ok: false, reason: "self_approval" });
    expect((await admin({ op: "approve", recovery_id: REC_ID })).status).toBe(403);
    expect(sent).not.toHaveBeenCalled();
  });

  it("si el aviso de aprobación falla, la aprobación se mantiene pero se informa; el reenvío rota el token y solo procede si está aprobada y sin entrega", async () => {
    fake.rpc.admin_mfa_recovery_approve = ok({
      ok: true,
      recoveryId: REC_ID,
      cancelRotation: 1,
      email: "mod@example.test",
    });
    resendFetch.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    const r = await admin({ op: "approve", recovery_id: REC_ID });
    expect(r.body).toMatchObject({
      status: "approved",
      notice: { status: "failed", error_class: "rate_limited" },
    });
    const item = {
      out_id: REC_ID,
      out_user_id: MOD_ID,
      out_username: "mina",
      out_role: "moderator",
      out_status: "approved",
      out_requested_at: "x",
      out_expires_at: "y",
      out_notice_state: "failed",
      out_readiness: "notice_failed",
    };
    fake.rpc.admin_mfa_recoveries_pending = ok([item]);
    fake.rpc.admin_mfa_recovery_set_cancel = ok({
      ok: true,
      recoveryId: REC_ID,
      cancelRotation: 2,
      email: "mod@example.test",
    });
    resendFetch.mockImplementation(
      async (_u: string, init: { body: string; headers: Record<string, string> }) => {
        sent(JSON.parse(init.body), init.headers);
        return { ok: true, status: 200, json: async () => ({ id: "resend-msg-2" }) };
      },
    );
    const again = await admin({ op: "resend_notice", recovery_id: REC_ID });
    expect(again.body).toMatchObject({ notice: { status: "accepted" } });
    expect((sent.mock.calls[0][0] as { to: string[] }).to).toEqual(["mod@example.test"]);
    const rotated = fake.rpcCalls.find(
      (c) => c.name === "admin_mfa_recovery_set_cancel",
    )!;
    expect(rotated.args.p_cancel_hash).toBe(
      createHash("sha256").update(cancelTokenFromEmail()).digest("hex"),
    );
    expect((sent.mock.calls[0][1] as Record<string, string>)["Idempotency-Key"]).toBe(
      `recovery:${REC_ID}:approved:2:1`,
    );
    // con el aviso ya ENTREGADO no se rota ni se reenvía el enlace: se envía un RECORDATORIO independiente
    fake.rpc.admin_mfa_recoveries_pending = ok([
      { ...item, out_notice_state: "delivered" },
    ]);
    const rotationsBefore = fake.rpcCalls.filter(
      (c) => c.name === "admin_mfa_recovery_set_cancel",
    ).length;
    fake.rpc.admin_mfa_recovery_reminder_start = ok({
      ok: true,
      recoveryId: REC_ID,
      baseKey: `recovery:${REC_ID}:reminder:1`,
      number: 1,
      email: "mod@example.test",
    });
    sent.mockClear();
    const remind = await admin({ op: "resend_notice", recovery_id: REC_ID });
    expect(remind.status).toBe(200);
    expect(remind.body).toEqual({ status: "approved", reminder: { status: "accepted" } });
    expect(
      fake.rpcCalls.filter((c) => c.name === "admin_mfa_recovery_set_cancel"),
    ).toHaveLength(rotationsBefore); // no se rotó el enlace de cancelación
    const reminderStart = fake.rpcCalls.find(
      (c) => c.name === "admin_mfa_recovery_reminder_start",
    )!;
    // el solicitante sale del JWT verificado (no del cuerpo) y se registra en la auditoría de la solicitud
    expect(reminderStart.args).toEqual({
      p_recovery_id: REC_ID,
      p_actor_user_id: ADMIN_ID,
    });
    const mail = sent.mock.calls[0][0] as { to: string[]; subject: string; text: string };
    expect(mail.to).toEqual(["mod@example.test"]);
    expect(mail.subject).toBe("Upminaa Web: reminder about your authenticator reset");
    expect(mail.text).not.toMatch(/#t=|\/cancel/); // no inventa ni reenvía un enlace de cancelación
    expect(mail.text).toContain("https://dev.example.test/admin/mfa/recovery");
    expect((sent.mock.calls[0][1] as Record<string, string>)["Idempotency-Key"]).toBe(
      `recovery:${REC_ID}:reminder:1:1`,
    );
    // sin correo configurado no se reserva ningún recordatorio (no consumir el máximo sin poder enviar)
    vi.stubEnv("MFA_RECOVERY_RESEND_API_KEY", "");
    const callsBefore = fake.rpcCalls.length;
    const noMail = await admin({ op: "resend_notice", recovery_id: REC_ID });
    expect(noMail.status).toBe(503);
    expect(noMail.body).toMatchObject({ code: "mail_unavailable" });
    expect(fake.rpcCalls.slice(callsBefore).map((c) => c.name)).not.toContain(
      "admin_mfa_recovery_reminder_start",
    );
    vi.stubEnv("MFA_RECOVERY_RESEND_API_KEY", "re_clave_sintetica");
    // rechazos de la base → códigos controlados, sin enviar nada
    for (const [reason, status, code] of [
      ["too_soon", 429, "too_soon"],
      ["reminder_limit", 429, "reminder_limit"],
      ["notice_not_delivered", 409, "notice_not_delivered"],
      ["not_pending", 409, "not_pending"],
    ] as const) {
      sent.mockClear();
      fake.rpc.admin_mfa_recovery_reminder_start = ok({ ok: false, reason });
      const r = await admin({ op: "resend_notice", recovery_id: REC_ID });
      expect(r.status, reason).toBe(status);
      expect(r.body).toEqual({ error: "Operación no permitida", code });
      expect(sent).not.toHaveBeenCalled();
    }
    fake.rpc.admin_mfa_recoveries_pending = ok([
      { ...item, out_status: "pending_approval" },
    ]);
    expect((await admin({ op: "resend_notice", recovery_id: REC_ID })).status).toBe(404);
  });

  it("rechazar exige motivo; el motivo viaja a la base y el titular recibe el aviso de cierre", async () => {
    fake.rpc.admin_mfa_recovery_deny = ok({ ok: false, reason: "reason_required" });
    expect((await admin({ op: "deny", recovery_id: REC_ID })).status).toBe(400);
    fake.rpc.admin_mfa_recovery_deny = ok({
      ok: true,
      recoveryId: REC_ID,
      email: "mod@example.test",
    });
    const r = await admin({
      op: "deny",
      recovery_id: REC_ID,
      reason: "No reconozco la solicitud",
    });
    expect(r.body).toMatchObject({ status: "denied" });
    expect(
      fake.rpcCalls.filter((c) => c.name === "admin_mfa_recovery_deny").pop()!.args,
    ).toMatchObject({ p_reason: "No reconozco la solicitud", p_actor_user_id: ADMIN_ID });
  });

  it("recovery_id inválido o acción desconocida → 400", async () => {
    expect((await admin({ op: "approve", recovery_id: "no-uuid" })).status).toBe(400);
    expect((await admin({ op: "explotar", recovery_id: REC_ID })).status).toBe(400);
  });
});

describe("webhook de Resend", () => {
  const sign = (
    body: string,
    over: { id?: string; ts?: number; secret?: string } = {},
  ) => {
    const id = over.id ?? "msg_test";
    const ts = String(over.ts ?? nowS());
    const key = Buffer.from(
      (over.secret ?? WEBHOOK_SECRET).replace("whsec_", ""),
      "base64",
    );
    const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
    return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` };
  };
  const hook = (body: string, headers: Record<string, string>) =>
    call({ action: "mfa-recovery-webhook", body, headers, token: null });
  const event = (type: string, emailId = "resend-msg-1") =>
    JSON.stringify({ type, data: { email_id: emailId } });

  it("sin secreto configurado → 503; método incorrecto → 405", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    expect((await hook(event("email.delivered"), {})).status).toBe(503);
    expect(
      (await call({ action: "mfa-recovery-webhook", method: "GET", token: null })).status,
    ).toBe(405);
  });

  it("firma ausente, manipulada, con otro secreto o caducada → 401 y ningún cambio de estado", async () => {
    const body = event("email.delivered");
    expect((await hook(body, {})).status).toBe(401);
    expect((await hook(body + " ", sign(body))).status).toBe(401);
    expect(
      (
        await hook(
          body,
          sign(body, { secret: "whsec_" + Buffer.from("otro").toString("base64") }),
        )
      ).status,
    ).toBe(401);
    expect((await hook(body, sign(body, { ts: nowS() - 3600 }))).status).toBe(401);
    expect(rpcNames()).not.toContain("admin_mfa_recovery_mail_event");
  });

  it("entrega firmada → registra «delivered»; fallos → «bounced»; abrir/clic se ignoran (no es lectura)", async () => {
    fake.rpc.admin_mfa_recovery_mail_event = ok("delivered");
    for (const [type, mapped] of [
      ["email.delivered", "delivered"],
      ["email.bounced", "bounced"],
      ["email.failed", "failed"],
    ] as const) {
      const body = event(type);
      expect((await hook(body, sign(body))).status).toBe(200);
      expect(
        fake.rpcCalls.filter((c) => c.name === "admin_mfa_recovery_mail_event").pop()!
          .args,
      ).toEqual({ p_provider_message_id: "resend-msg-1", p_event: mapped });
    }
    fake.rpcCalls = [];
    for (const type of ["email.opened", "email.clicked", "email.sent"]) {
      const body = event(type);
      expect(await hook(body, sign(body))).toMatchObject({
        status: 200,
        body: { ignored: true },
      });
    }
    expect(rpcNames()).not.toContain("admin_mfa_recovery_mail_event");
  });

  it("un fallo al registrar devuelve 500 para que el proveedor reintente", async () => {
    fake.rpc.admin_mfa_recovery_mail_event = {
      data: null,
      error: { code: "XX000", message: "x" },
    };
    const body = event("email.delivered");
    expect((await hook(body, sign(body))).status).toBe(500);
  });
});

describe("cancelación desde el enlace del correo", () => {
  const TOKEN = "Q".repeat(43);
  const HASH = createHash("sha256").update(TOKEN).digest("hex");
  const cancelCall = (body: unknown, method = "POST", token: string | null = null) =>
    call({ action: "mfa-recovery-cancel", method, body, token });
  const authAttempts = () => fake.rpcCalls.filter((c) => c.name.includes("cancel"));

  it("es pública (sin sesión ni TOTP) pero NO acepta GET: nunca cancela por una visita", async () => {
    const r = await cancelCall(undefined, "GET");
    expect(r.status).toBe(405);
    expect(fake.rpcCalls).toHaveLength(0);
    expect((await cancelCall({ op: "cancel", token: TOKEN }, "PUT")).status).toBe(405);
  });

  it("formato de token u operación inválidos → 400 sin tocar la base", async () => {
    for (const body of [
      { op: "cancel" },
      { op: "cancel", token: "corto" },
      { op: "borrar", token: TOKEN },
      null,
    ]) {
      expect((await cancelCall(body)).status).toBe(400);
    }
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("«check» solo consulta (no cancela); válido → 200, inválido → 404", async () => {
    fake.rpc.admin_mfa_recovery_cancel_check = ok(true);
    expect(await cancelCall({ op: "check", token: TOKEN })).toMatchObject({
      status: 200,
      body: { valid: true },
    });
    fake.rpc.admin_mfa_recovery_cancel_check = ok(false);
    expect((await cancelCall({ op: "check", token: TOKEN })).status).toBe(404);
    expect(rpcNames()).not.toContain("admin_mfa_recovery_cancel_by_token");
    expect(authAttempts().every((c) => c.args.p_cancel_hash === HASH)).toBe(true);
  });

  it("«cancel» envía solo el hash, cancela y avisa del cierre; el token no vuelve en la respuesta", async () => {
    fake.rpc.admin_mfa_recovery_cancel_by_token = ok({
      ok: true,
      recoveryId: REC_ID,
      userId: MOD_ID,
      email: "mod@example.test",
    });
    const r = await cancelCall({ op: "cancel", token: TOKEN, user_id: ADMIN_ID });
    expect(r).toMatchObject({ status: 200, body: { status: "cancelled" } });
    expect(
      fake.rpcCalls.find((c) => c.name === "admin_mfa_recovery_cancel_by_token")!.args,
    ).toEqual({
      p_cancel_hash: HASH,
    });
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    expect(JSON.stringify(fake.rpcCalls)).not.toContain(TOKEN);
    expect(sent).toHaveBeenCalledTimes(1); // aviso de cierre
  });

  it("usado, caducado, cerrado o desconocido → la MISMA respuesta 404 (sin revelar nada)", async () => {
    fake.rpc.admin_mfa_recovery_cancel_by_token = ok({ ok: false, reason: "invalid" });
    const r = await cancelCall({ op: "cancel", token: TOKEN });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "Enlace no válido", code: "invalid_link" });
    expect(sent).not.toHaveBeenCalled();
  });

  it("un fallo de la base es 500 genérico; un fallo del correo de cierre no deshace la cancelación", async () => {
    fake.rpc.admin_mfa_recovery_cancel_by_token = {
      data: null,
      error: { code: "XX000", message: "interno" },
    };
    expect((await cancelCall({ op: "cancel", token: TOKEN })).status).toBe(500);
    fake.rpc.admin_mfa_recovery_cancel_by_token = ok({
      ok: true,
      recoveryId: REC_ID,
      userId: MOD_ID,
      email: "mod@example.test",
    });
    resendFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    expect((await cancelCall({ op: "cancel", token: TOKEN })).status).toBe(200);
  });

  it("el enlace no concede nada más: no existe ninguna RPC de aprobar/ejecutar/rol en estas rutas", async () => {
    fake.rpc.admin_mfa_recovery_cancel_by_token = ok({
      ok: true,
      recoveryId: REC_ID,
      userId: MOD_ID,
      email: "mod@example.test",
    });
    await cancelCall({ op: "cancel", token: TOKEN });
    await cancelCall({ op: "check", token: TOKEN });
    expect(
      rpcNames().filter((n) =>
        /approve|begin_execute|record_execution|admin_roles|complete/.test(n),
      ),
    ).toEqual([]);
  });
});

describe("webhook: cuerpo original antes de verificar la firma", () => {
  const sign = (body: string, id = "msg_raw", ts = nowS()) => {
    const key = Buffer.from(WEBHOOK_SECRET.replace("whsec_", ""), "base64");
    const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
    return { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${sig}` };
  };

  /** Petición con flujo REAL (Readable). `parsed` es lo que Vercel pondría en req.body tras analizar
   *  el JSON: puede NO reproducir los bytes firmados. */
  function streamRequest(rawBody: string, headers: Record<string, string>) {
    let bodyReads = 0;
    const req = Object.assign(Readable.from([Buffer.from(rawBody)]), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      query: { action: "mfa-recovery-webhook" },
    });
    Object.defineProperty(req, "body", {
      get() {
        bodyReads += 1;
        return JSON.parse(rawBody); // el análisis normaliza: JSON.stringify ya no da los mismos bytes
      },
    });
    return { req, bodyReads: () => bodyReads };
  }

  /** Réplica FIEL de restoreBody de @vercel/node 13.0.1 (src/serverless-functions/helpers.ts): el
   *  runtime lee el flujo entero para construir req.body y luego lo REPONE para los listeners. */
  async function vercelLikeRequest(rawBody: string, headers: Record<string, string>) {
    const req = Object.assign(Readable.from([Buffer.from(rawBody)]), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      query: { action: "mfa-recovery-webhook" },
    }) as unknown as Readable & { read: unknown; addListener: unknown };
    const consumed: Buffer[] = [];
    for await (const chunk of req) consumed.push(chunk as Buffer); // lectura original
    const body = Buffer.concat(consumed);
    const replicate = new PassThrough();
    const on = replicate.on.bind(replicate);
    const originalOn = req.on.bind(req);
    req.read = replicate.read.bind(replicate);
    const replay = ((name: string, cb: (...a: unknown[]) => void) =>
      name === "data" || name === "end" ? on(name, cb) : originalOn(name, cb)) as never;
    (req as unknown as { on: unknown }).on = replay;
    req.addListener = replay;
    replicate.write(body);
    replicate.end();
    let parsedAccess = 0;
    Object.defineProperty(req, "body", {
      get() {
        parsedAccess += 1;
        return JSON.parse(body.toString());
      },
    });
    return { req, parsedAccess: () => parsedAccess };
  }

  async function run(req: unknown) {
    const { res, state } = mockRes();
    await router(req as VercelRequest, res);
    return state;
  }
  // Cuerpo con espacios, orden de claves y escapes unicode que JSON.stringify no reproduciría.
  const RAW =
    '{"type": "email.delivered",  "created_at":"2026-10-11T10:00:00Z", "data":{"email_id":"resend-msg-1","to":["m\u00f3d@example.test"]}}';

  it("la firma válida sobre el cuerpo ORIGINAL se acepta aunque req.body reserializado difiera, sin leer req.body", async () => {
    expect(JSON.stringify(JSON.parse(RAW))).not.toBe(RAW);
    fake.rpc.admin_mfa_recovery_mail_event = ok("delivered");
    const { req, bodyReads } = streamRequest(RAW, sign(RAW));
    const r = await run(req);
    expect(r.status).toBe(200);
    expect(bodyReads()).toBe(0);
    expect(
      fake.rpcCalls.find((c) => c.name === "admin_mfa_recovery_mail_event")!.args,
    ).toEqual({
      p_provider_message_id: "resend-msg-1",
      p_event: "delivered",
    });
  });

  it("flujo repuesto como en el runtime de Vercel (cuerpo ya leído para construir req.body): sigue verificando", async () => {
    fake.rpc.admin_mfa_recovery_mail_event = ok("delivered");
    const { req, parsedAccess } = await vercelLikeRequest(RAW, sign(RAW));
    expect((await run(req)).status).toBe(200);
    expect(parsedAccess()).toBe(0);
  });

  it("contenido alterado tras firmar (aunque el JSON sea equivalente) o firma inválida → 401 y sin efectos", async () => {
    const altered = RAW.replace("email.delivered", "email.bounced");
    const a = streamRequest(altered, sign(RAW));
    expect((await run(a.req)).status).toBe(401);
    const spaced = RAW.replace(", ", ",");
    const b = streamRequest(spaced, sign(RAW)); // mismo JSON, bytes distintos
    expect((await run(b.req)).status).toBe(401);
    const c = streamRequest(RAW, { ...sign(RAW), "svix-signature": "v1,AAAA" });
    expect((await run(c.req)).status).toBe(401);
    const d = await vercelLikeRequest(altered, sign(RAW));
    expect((await run(d.req)).status).toBe(401);
    expect(rpcNames()).not.toContain("admin_mfa_recovery_mail_event");
  });

  it("evento que llega antes de registrar el id del envío → 503 para que Resend reintente", async () => {
    fake.rpc.admin_mfa_recovery_mail_event = ok("unknown_message");
    const { req } = streamRequest(RAW, sign(RAW));
    expect((await run(req)).status).toBe(503);
  });

  it("entregado y fallos: delivered/bounced/failed se registran; repetidos y fuera de orden los resuelve la base", async () => {
    fake.rpc.admin_mfa_recovery_mail_event = ok("delivered");
    for (const type of [
      "email.bounced",
      "email.delivered",
      "email.delivered",
      "email.bounced",
    ]) {
      const raw = JSON.stringify({ type, data: { email_id: "resend-msg-1" } });
      expect(
        (await run(streamRequest(raw, sign(raw, `id_${type}_${Math.random()}`)).req))
          .status,
      ).toBe(200);
    }
    const events = fake.rpcCalls
      .filter((c) => c.name === "admin_mfa_recovery_mail_event")
      .map((c) => c.args.p_event);
    expect(events).toEqual(["bounced", "delivered", "delivered", "bounced"]);
  });

  it("sin flujo utilizable se usa el cuerpo en texto; el JSON reserializado que no coincide falla CERRADO", async () => {
    fake.rpc.admin_mfa_recovery_mail_event = ok("delivered");
    const asText = await call({
      action: "mfa-recovery-webhook",
      body: RAW,
      headers: sign(RAW),
      token: null,
    });
    expect(asText.status).toBe(200);
    const asObject = await call({
      action: "mfa-recovery-webhook",
      body: JSON.parse(RAW),
      headers: sign(RAW),
      token: null,
    });
    expect(asObject.status).toBe(401);
  });

  it("no afecta a otras rutas: el cuerpo JSON de las demás acciones sigue llegando analizado", async () => {
    fake.rpc.admin_mfa_recovery_current = ok({ status: "none", hasApprover: true });
    expect((await status()).status).toBe(200);
    fake.rpc.admin_mfa_recovery_verify = ok({ ok: true, status: "pending_approval" });
    const r = await member({ op: "verify", token: "A".repeat(43) });
    expect(r.status).toBe(200);
  });
});

describe("reconciliación del cierre al consultar el estado", () => {
  const CUR = { status: "factors_deleted", recoveryId: REC_ID, hasApprover: true };
  const completes = () =>
    fake.rpcCalls.filter((c) => c.name === "admin_mfa_recovery_complete");

  it("con el TOTP nuevo verificado la consulta CIERRA la recuperación en el servidor (sesión del JWT) y avisa una vez", async () => {
    let calls = 0;
    fake.rpc.admin_mfa_recovery_current = () => {
      calls += 1;
      return ok(calls === 1 ? CUR : { ...CUR, status: "completed" });
    };
    fake.rpc.admin_mfa_recovery_complete = ok({
      ok: true,
      already: false,
      recoveryId: REC_ID,
      email: "mod@example.test",
    });
    const r = await status("jwt-mod-aal2");
    expect(r.body).toMatchObject({ status: "completed" });
    expect(completes()).toHaveLength(1);
    expect(completes()[0].args).toEqual({ p_user_id: MOD_ID, p_session_id: SESSION_ID });
    expect(sent).toHaveBeenCalledTimes(1);
    expect((sent.mock.calls[0][1] as Record<string, string>)["Idempotency-Key"]).toBe(
      `recovery:${REC_ID}:completed:1`,
    );
  });

  it("si el factor nuevo aún no está verificado NO se completa y el estado se mantiene (sin correo)", async () => {
    fake.rpc.admin_mfa_recovery_current = ok(CUR);
    fake.rpc.admin_mfa_recovery_complete = ok({
      ok: false,
      reason: "new_factor_required",
    });
    const r = await status("jwt-mod-aal1");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "factors_deleted" });
    expect(sent).not.toHaveBeenCalled();
    expect(
      fake.rpcCalls.filter((c) => c.name === "admin_mfa_recovery_current"),
    ).toHaveLength(1); // sin releer
  });

  it("un fallo de la base o de Auth al reconciliar no completa nada y no rompe la consulta", async () => {
    fake.rpc.admin_mfa_recovery_current = ok(CUR);
    fake.rpc.admin_mfa_recovery_complete = {
      data: null,
      error: { code: "XX000", message: "interno" },
    };
    const r = await status("jwt-mod-aal2");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "factors_deleted" });
    expect(JSON.stringify(r.body)).not.toContain("interno");
    expect(sent).not.toHaveBeenCalled();
  });

  it.each([
    "none",
    "pending_email",
    "pending_approval",
    "approved",
    "executing",
    "completed",
    "cancelled",
    "denied",
    "expired",
  ])("en el estado «%s» la consulta NO intenta reconciliar", async (st) => {
    fake.rpc.admin_mfa_recovery_current = ok({ status: st, recoveryId: REC_ID });
    await status("jwt-mod-aal2");
    expect(completes()).toHaveLength(0);
  });

  it("ya completada (respuesta estable): consultas repetidas no vuelven a reconciliar ni a enviar correos", async () => {
    fake.rpc.admin_mfa_recovery_current = ok({ status: "completed", recoveryId: REC_ID });
    for (let i = 0; i < 3; i++) await status("jwt-mod-aal2");
    expect(completes()).toHaveLength(0);
    expect(sent).not.toHaveBeenCalled();
  });

  it("consultas simultáneas: una sola finalización efectiva y un solo correo", async () => {
    let n = 0;
    fake.rpc.admin_mfa_recovery_current = ok(CUR);
    fake.rpc.admin_mfa_recovery_complete = () => {
      n += 1;
      return n === 1
        ? ok({ ok: true, already: false, recoveryId: REC_ID, email: "mod@example.test" })
        : ok({ ok: true, already: true, recoveryId: REC_ID, email: "mod@example.test" });
    };
    await Promise.all([
      status("jwt-mod-aal2"),
      status("jwt-mod-aal2"),
      status("jwt-mod-aal2"),
    ]);
    expect(completes()).toHaveLength(3);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("aunque la base ofreciera enviar de nuevo, el registro de envío (idempotencia) impide un segundo correo", async () => {
    fake.rpc.admin_mfa_recovery_current = ok(CUR);
    fake.rpc.admin_mfa_recovery_complete = ok({
      ok: true,
      already: false,
      recoveryId: REC_ID,
      email: "mod@example.test",
    });
    let starts = 0;
    fake.rpc.admin_mfa_recovery_mail_start = () => {
      starts += 1;
      return ok(
        starts === 1
          ? { shouldSend: true, providerKey: `k:${starts}` }
          : { shouldSend: false, state: "accepted" },
      );
    };
    await status("jwt-mod-aal2");
    await status("jwt-mod-aal2");
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("un fallo del correo de finalización no revierte la recuperación", async () => {
    let calls = 0;
    fake.rpc.admin_mfa_recovery_current = () =>
      ok(++calls === 1 ? CUR : { ...CUR, status: "completed" });
    fake.rpc.admin_mfa_recovery_complete = ok({
      ok: true,
      already: false,
      recoveryId: REC_ID,
      email: "mod@example.test",
    });
    resendFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const r = await status("jwt-mod-aal2");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "completed" });
  });

  it("sin configuración de correo igualmente se completa (el aviso es accesorio)", async () => {
    vi.stubEnv("MFA_RECOVERY_RESEND_API_KEY", "");
    let calls = 0;
    fake.rpc.admin_mfa_recovery_current = () =>
      ok(++calls === 1 ? CUR : { ...CUR, status: "completed" });
    fake.rpc.admin_mfa_recovery_complete = ok({
      ok: true,
      already: false,
      recoveryId: REC_ID,
      email: "mod@example.test",
    });
    expect((await status("jwt-mod-aal2")).body).toMatchObject({ status: "completed" });
    expect(sent).not.toHaveBeenCalled();
  });

  it("la reconciliación usa SOLO la sesión del JWT: un session_id enviado en la consulta se ignora", async () => {
    fake.rpc.admin_mfa_recovery_current = ok(CUR);
    fake.rpc.admin_mfa_recovery_complete = ok({
      ok: false,
      reason: "new_factor_required",
    });
    const { res } = mockRes();
    await router(
      {
        method: "GET",
        headers: { authorization: "Bearer jwt-mod-aal2" },
        query: {
          action: "mfa-recovery",
          session_id: "00000000-0000-4000-8000-000000000000",
        },
      } as unknown as VercelRequest,
      res,
    );
    expect(completes()[0].args.p_session_id).toBe(SESSION_ID);
  });
});
