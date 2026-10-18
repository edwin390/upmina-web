// @vitest-environment node
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAuthError } from "./admin-auth";
import {
  buildAccountDeletionEmail,
  buildAccountDeletionLink,
  readAccountDeletionMailConfig,
  sendAccountDeletionEmail,
} from "./account-deletion-mail";
import {
  handleAccountDeletionAlerts,
  handleAccountDeletionConfirm,
  handleAccountDeletionPreview,
  handleAccountDeletionRequest,
  handleAccountDeletionRetry,
  handleAccountDeletionRun,
  hashDeletionToken,
  type DeletionHandlerDeps,
} from "./account-deletion-handlers";
import {
  DELETION_STAGES,
  RUN_SIGNATURE_HEADER,
  RUN_TIMESTAMP_HEADER,
  runAccountDeletionBatch,
  runDeletionJob,
  signRunRequest,
  verifyRunRequest,
  type AuthAdmin,
  type AuthAdminOutcome,
  type DeletionDb,
  type WorkerDeps,
} from "./account-deletion-worker";
import type { MailConfig } from "./mfa-recovery-mail";

// DEL-2 · pruebas con DOBLES (sin red, sin Supabase, sin correo real). Cubren el CONTRATO de los endpoints y del ejecutor frente a las
// RPC de DEL-1. La integración contra el SQL real (PGlite) está en account-deletion-sql.test.ts; RLS, Auth y R2 reales NO se validan aquí.

const auth = vi.hoisted(() => ({
  authenticated: vi.fn(),
  capability: vi.fn(),
}));
vi.mock("./admin-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./admin-auth")>()),
  requireAuthenticated: auth.authenticated,
  requireCapability: auth.capability,
}));

const USER = "11111111-1111-4111-8111-111111111111";
const DEV = "22222222-2222-4222-8222-222222222222";
const REQ_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "A".repeat(43);

function res() {
  const out = {
    status: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
  };
  const r = {
    setHeader(k: string, v: string) {
      out.headers[k.toLowerCase()] = v;
      return r;
    },
    status(code: number) {
      out.status = code;
      return r;
    },
    json(body: unknown) {
      out.body = body;
      return r;
    },
  };
  return { out, r: r as unknown as VercelResponse };
}
const request = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  ({ method, body, headers, query: {} }) as unknown as VercelRequest;

type Handler = (
  fn: string,
  args: Record<string, unknown>,
) => { data?: unknown; error?: { message: string } | null };
function fakeDeps(
  handlers: Record<string, Handler>,
  over: Partial<DeletionHandlerDeps> = {},
) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const db: DeletionDb = {
    rpc: async (fn, args = {}) => {
      calls.push({ fn, args });
      const h = handlers[fn];
      if (!h) return { data: null, error: { message: `unexpected ${fn}` } };
      const out = h(fn, args);
      return { data: out.data ?? null, error: out.error ?? null };
    },
  };
  const sent: Array<Record<string, unknown>> = [];
  const mailConfig = {
    sender: {
      send: async (m: Record<string, unknown>) => {
        sent.push(m);
        return { ok: true };
      },
    },
    appUrl: "https://app.example",
  } as unknown as MailConfig;
  const kick = vi.fn(async () => undefined);
  const deps: DeletionHandlerDeps = {
    db: () => db,
    mail: () => mailConfig,
    newToken: () => TOKEN,
    kick,
    ...over,
  };
  return { deps, calls, sent, kick };
}

beforeEach(() => {
  auth.authenticated.mockReset();
  auth.capability.mockReset();
  auth.authenticated.mockResolvedValue({ userId: USER, aal: "aal1" });
  auth.capability.mockResolvedValue({ userId: DEV, aal: "aal2", role: "developer" });
});

describe("solicitud", () => {
  const okRequest: Handler = () => ({
    data: { requestId: REQ_ID, expiresAt: "x", email: "persona@example.com" },
  });

  it("autenticada: el usuario sale de la sesión, solo se persiste el hash SHA-256 y el correo (inglés) lleva el token en el fragmento", async () => {
    const { deps, calls, sent } = fakeDeps({ account_deletion_request: okRequest });
    const { out, r } = res();
    await handleAccountDeletionRequest(request("POST", {}), r, deps);
    expect(out.status).toBe(200);
    expect(calls).toEqual([
      {
        fn: "account_deletion_request",
        args: {
          p_user_id: USER,
          p_token_hash: createHash("sha256").update(TOKEN).digest("hex"),
          p_ttl_minutes: 30,
        },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain(TOKEN); // el texto plano jamás llega a la BD
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "persona@example.com",
      idempotencyKey: `account-deletion:${REQ_ID}`,
    });
    expect(String(sent[0]!.text)).toContain(
      `https://app.example/account/delete#t=${TOKEN}`,
    );
    expect(String(sent[0]!.subject)).toMatch(/^Upmina Community - /);
    expect(JSON.stringify(out.body)).not.toContain(TOKEN);
    expect(JSON.stringify(out.body)).not.toContain("persona@example.com");
    expect(out.headers["cache-control"]).toBe("no-store");
    expect(out.headers["referrer-policy"]).toBe("no-referrer");
    expect(auth.authenticated).toHaveBeenCalledWith(expect.anything()); // con el gate por defecto (cuenta bloqueada ⇒ 401)
    expect(auth.authenticated.mock.calls[0]!.length).toBe(1);
  });

  it("nada del cliente es autoridad: un cuerpo con userId/correo se rechaza sin tocar la BD ni el correo", async () => {
    for (const body of [{ userId: DEV }, { email: "x@example.com" }, { confirm: true }]) {
      const { deps, calls, sent } = fakeDeps({ account_deletion_request: okRequest });
      const { out, r } = res();
      await handleAccountDeletionRequest(request("POST", body), r, deps);
      expect(out.status).toBe(400);
      expect(calls).toEqual([]);
      expect(sent).toEqual([]);
    }
  });

  it("sin sesión, con cuenta ya bloqueada o por GET: 401 / 401 / 405, sin efectos", async () => {
    auth.authenticated.mockRejectedValue(new AdminAuthError("No autenticado", 401));
    const a = fakeDeps({ account_deletion_request: okRequest });
    const one = res();
    await handleAccountDeletionRequest(request("POST", {}), one.r, a.deps);
    expect(one.out.status).toBe(401);
    expect(a.calls).toEqual([]);
    const two = res();
    await handleAccountDeletionRequest(request("GET"), two.r, a.deps);
    expect(two.out.status).toBe(405);
  });

  it("errores de la BD: privilegiada 403, límites 429, ya en eliminación 409, resto 500 genérico; sin detalles del proveedor", async () => {
    const cases: Array<[string, number]> = [
      ["privileged_account_requires_procedure", 403],
      ["request_too_soon", 429],
      ["too_many_requests", 429],
      ["account_deletion_in_progress", 409],
      ["no_email", 400],
      ["relation secret_table does not exist", 500],
    ];
    for (const [message, status] of cases) {
      const { deps, sent } = fakeDeps({
        account_deletion_request: () => ({ error: { message } }),
      });
      const { out, r } = res();
      await handleAccountDeletionRequest(request("POST", {}), r, deps);
      expect(out.status, message).toBe(status);
      expect(JSON.stringify(out.body)).not.toContain("secret_table");
      expect(sent).toEqual([]);
    }
  });

  it("sin configuración de correo no se crea ninguna solicitud (503); si el envío falla, 502 sin token y sin estado a medias", async () => {
    const a = fakeDeps({ account_deletion_request: okRequest }, { mail: () => null });
    const one = res();
    await handleAccountDeletionRequest(request("POST", {}), one.r, a.deps);
    expect(one.out.status).toBe(503);
    expect(a.calls).toEqual([]);
    const failing = fakeDeps(
      { account_deletion_request: okRequest },
      {
        mail: () =>
          ({
            sender: {
              send: async () => ({ ok: false, errorClass: "provider_unavailable" }),
            },
            appUrl: "https://app.example",
          }) as unknown as MailConfig,
      },
    );
    const two = res();
    await handleAccountDeletionRequest(request("POST", {}), two.r, failing.deps);
    expect(two.out.status).toBe(502);
    expect(JSON.stringify(two.out.body)).not.toContain(TOKEN);
    expect(failing.calls.map((c) => c.fn)).toEqual(["account_deletion_request"]); // no confirma, no bloquea
  });
});

describe("vista previa y confirmación", () => {
  it("la vista previa solo llama a la RPC de solo lectura, con allowDeletingAccount, y valida el formato del token", async () => {
    const { deps, calls } = fakeDeps({
      account_deletion_preview: () => ({ data: { state: "valid" } }),
    });
    const bad = res();
    await handleAccountDeletionPreview(request("POST", { token: "corto" }), bad.r, deps);
    expect(bad.out.status).toBe(400);
    const { out, r } = res();
    await handleAccountDeletionPreview(
      request("POST", { token: TOKEN, userId: DEV }),
      r,
      deps,
    );
    expect(out).toMatchObject({ status: 200, body: { state: "valid" } });
    expect(calls).toEqual([
      {
        fn: "account_deletion_preview",
        args: { p_user_id: USER, p_token_hash: hashDeletionToken(TOKEN) },
      },
    ]);
    expect(auth.authenticated).toHaveBeenLastCalledWith(expect.anything(), {
      allowDeletingAccount: true,
    });
  });

  const confirmed: Handler = () => ({
    data: { outcome: "confirmed", requestId: REQ_ID },
  });
  const gateOn: Handler = () => ({
    data: { blocked: true, requestId: REQ_ID, status: "access_blocked" },
  });

  it("sin la acción explícita confirm:true o con token mal formado no se toca la BD", async () => {
    for (const body of [
      { token: TOKEN },
      { token: TOKEN, confirm: "true" },
      { confirm: true },
      { token: "x", confirm: true },
      null,
    ]) {
      const { deps, calls } = fakeDeps({
        account_deletion_confirm: confirmed,
        account_deletion_gate: gateOn,
      });
      const { out, r } = res();
      await handleAccountDeletionConfirm(request("POST", body), r, deps);
      expect(out.status).toBe(400);
      expect(calls).toEqual([]);
    }
  });

  it("confirmada: 202 solo tras comprobar la barrera durable; la identidad es la de la sesión, nunca la del cuerpo", async () => {
    const { deps, calls, kick } = fakeDeps({
      account_deletion_confirm: confirmed,
      account_deletion_gate: gateOn,
    });
    const { out, r } = res();
    await handleAccountDeletionConfirm(
      request("POST", { token: TOKEN, confirm: true, userId: DEV }),
      r,
      deps,
    );
    expect(out).toMatchObject({ status: 202, body: { status: "accepted" } });
    expect(calls.map((c) => c.fn)).toEqual([
      "account_deletion_confirm",
      "account_deletion_gate",
    ]);
    expect(calls[0]!.args).toEqual({
      p_user_id: USER,
      p_token_hash: hashDeletionToken(TOKEN),
    });
    expect(kick).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(out.body)).not.toContain(REQ_ID);
  });

  it("si la barrera no quedó confirmada NO se responde éxito (500) ni se despierta el ejecutor", async () => {
    for (const gate of [
      () => ({ data: { blocked: false } }),
      () => ({ error: { message: "x" } }),
      () => ({ data: null }),
    ] as Handler[]) {
      const { deps, kick } = fakeDeps({
        account_deletion_confirm: confirmed,
        account_deletion_gate: gate,
      });
      const { out, r } = res();
      await handleAccountDeletionConfirm(
        request("POST", { token: TOKEN, confirm: true }),
        r,
        deps,
      );
      expect(out.status).toBe(500);
      expect(kick).not.toHaveBeenCalled();
    }
  });

  it("doble confirmación = already_deleting (200, idempotente); caducado 410; otra cuenta/consumido 400; privilegiada 403; error de BD 500", async () => {
    const table: Array<[unknown, number]> = [
      [{ outcome: "already_deleting", requestId: REQ_ID }, 200],
      [{ outcome: "expired" }, 410],
      [{ outcome: "invalid_token" }, 400],
      [{ outcome: "privileged_account" }, 403],
      [{ outcome: "user_not_found" }, 400],
      [{ outcome: "rarisimo" }, 400],
    ];
    for (const [data, status] of table) {
      const { deps, kick } = fakeDeps({
        account_deletion_confirm: () => ({ data }),
        account_deletion_gate: gateOn,
      });
      const { out, r } = res();
      await handleAccountDeletionConfirm(
        request("POST", { token: TOKEN, confirm: true }),
        r,
        deps,
      );
      expect(out.status, JSON.stringify(data)).toBe(status);
      expect(kick).not.toHaveBeenCalled();
    }
    const failing = fakeDeps({
      account_deletion_confirm: () => ({ error: { message: "boom" } }),
    });
    const { out, r } = res();
    await handleAccountDeletionConfirm(
      request("POST", { token: TOKEN, confirm: true }),
      r,
      failing.deps,
    );
    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toContain("boom");
  });

  it("sin sesión: 401 sin tocar la BD, también en confirmación", async () => {
    auth.authenticated.mockRejectedValue(new AdminAuthError("No autenticado", 401));
    const { deps, calls } = fakeDeps({ account_deletion_confirm: confirmed });
    const { out, r } = res();
    await handleAccountDeletionConfirm(
      request("POST", { token: TOKEN, confirm: true }),
      r,
      deps,
    );
    expect(out.status).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe("ejecutor firmado (/account-deletion-run)", () => {
  const SECRET = "s".repeat(40);
  const now = () => Math.floor(Date.now() / 1000);
  const signed = (ts = now(), secret = SECRET) =>
    request("POST", undefined, {
      [RUN_TIMESTAMP_HEADER]: String(ts),
      [RUN_SIGNATURE_HEADER]: signRunRequest(secret, ts),
    });

  it("solo ejecuta con firma válida, ventana de ±30 s, cuerpo vacío y sin parámetros del llamador", async () => {
    vi.stubEnv("ACCOUNT_DELETION_SHARED_SECRET", SECRET);
    const run = vi.fn(async () => ({ claimed: 0 }));
    const ok = res();
    await handleAccountDeletionRun(signed(), ok.r, run);
    expect(ok.out).toMatchObject({ status: 200, body: { claimed: 0 } });
    for (const bad of [
      request("POST"),
      signed(now() - 120),
      signed(now(), "otro-secreto-distinto-de-40-caracteres!!"),
      { ...signed(), body: { limit: 1000 } } as unknown as VercelRequest,
      {
        ...signed(),
        query: { action: "account-deletion-run", limit: "9" },
      } as unknown as VercelRequest,
    ]) {
      const { out, r } = res();
      await handleAccountDeletionRun(bad, r, run);
      expect([400, 401]).toContain(out.status);
    }
    expect(run).toHaveBeenCalledTimes(1);
    const get = res();
    await handleAccountDeletionRun(request("GET"), get.r, run);
    expect(get.out.status).toBe(405);
    vi.unstubAllEnvs();
    const noSecret = res();
    await handleAccountDeletionRun(signed(), noSecret.r, run);
    expect(noSecret.out.status).toBe(500); // fail-closed
  });

  it("una firma de otro dominio (GC de medios) no verifica", () => {
    expect(
      verifyRunRequest(SECRET, { timestamp: "1", signature: "abc", nowSeconds: 1 }),
    ).toBe(false);
    expect(
      verifyRunRequest(SECRET, {
        timestamp: String(now()),
        signature: signRunRequest(SECRET, now()),
        nowSeconds: now(),
      }),
    ).toBe(true);
    expect(
      verifyRunRequest(SECRET, {
        timestamp: String(now()),
        signature: signRunRequest("x".repeat(40), now()),
        nowSeconds: now(),
      }),
    ).toBe(false);
  });
});

describe("Developer: alertas y reintento", () => {
  it("un rol no developer (la capacidad lo rechaza con 403) no llega a la BD, ni en alertas ni en reintento", async () => {
    auth.capability.mockRejectedValue(new AdminAuthError("No autorizado", 403));
    const { deps, calls, kick } = fakeDeps({
      account_deletion_alerts: () => ({ data: [] }),
      account_deletion_developer_retry: () => ({ data: {} }),
    });
    const a = res();
    await handleAccountDeletionAlerts(request("GET"), a.r, deps);
    const b = res();
    await handleAccountDeletionRetry(request("POST", { requestId: REQ_ID }), b.r, deps);
    expect([a.out.status, b.out.status]).toEqual([403, 403]);
    expect(calls).toEqual([]);
    expect(kick).not.toHaveBeenCalled();
    expect(auth.capability).toHaveBeenCalledWith(expect.anything(), "developer_panel");
  });

  it("alertas: lee la RPC restringida con el actor de la sesión; reintento: valida el cuerpo, mapea errores y despierta al ejecutor", async () => {
    const alerts = [{ requestId: REQ_ID, status: "cleanup_manual_required" }];
    const { deps, calls, kick } = fakeDeps({
      account_deletion_alerts: () => ({ data: alerts }),
      account_deletion_developer_retry: () => ({
        data: { requestId: REQ_ID, status: "cleanup_retry_pending" },
      }),
    });
    const a = res();
    await handleAccountDeletionAlerts(request("GET"), a.r, deps);
    expect(a.out).toMatchObject({ status: 200, body: { alerts } });
    const bad = res();
    await handleAccountDeletionRetry(
      request("POST", { requestId: "no-uuid" }),
      bad.r,
      deps,
    );
    expect(bad.out.status).toBe(400);
    const extra = res();
    await handleAccountDeletionRetry(
      request("POST", { requestId: REQ_ID, userId: USER }),
      extra.r,
      deps,
    );
    expect(extra.out.status).toBe(400);
    const ok = res();
    await handleAccountDeletionRetry(request("POST", { requestId: REQ_ID }), ok.r, deps);
    expect(ok.out.status).toBe(200);
    expect(calls.filter((c) => c.fn === "account_deletion_developer_retry")).toEqual([
      {
        fn: "account_deletion_developer_retry",
        args: { p_actor_user_id: DEV, p_request_id: REQ_ID },
      },
    ]);
    expect(kick).toHaveBeenCalledTimes(1);
    for (const [message, status] of [
      ["request_not_found", 404],
      ["already_completed", 409],
      ["retry_not_applicable", 409],
      ["actor_not_developer", 403],
      ["otro", 500],
    ] as const) {
      const f = fakeDeps({
        account_deletion_developer_retry: () => ({ error: { message } }),
      });
      const { out, r } = res();
      await handleAccountDeletionRetry(request("POST", { requestId: REQ_ID }), r, f.deps);
      expect(out.status, message).toBe(status);
      expect(f.kick).not.toHaveBeenCalled();
    }
  });
});

describe("ejecutor: contrato frente a las RPC de DEL-1 (dobles)", () => {
  function workerFake(
    opts: {
      stage?: (fn: string) => { data?: unknown; error?: { message: string } };
      start?: (stage: string) => { data?: unknown; error?: { message: string } };
      ban?: AuthAdminOutcome;
      del?: AuthAdminOutcome;
      finish?: (args: Record<string, unknown>) => {
        data?: unknown;
        error?: { message: string };
      };
      now?: () => number;
    } = {},
  ) {
    const log: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const db: DeletionDb = {
      rpc: async (fn, args = {}) => {
        log.push({ fn, args });
        let out: { data?: unknown; error?: { message: string } };
        if (fn === "account_deletion_step_start")
          out = opts.start?.(String(args.p_stage)) ?? { data: { alreadyDone: false } };
        else if (fn === "account_deletion_step_finish")
          out = opts.finish?.(args) ?? {
            data: { completed: args.p_stage === "auth_delete" && args.p_ok === true },
          };
        else if (fn === "account_deletion_release") out = {};
        else if (fn === "account_deletion_stage_media")
          out = opts.stage?.(fn) ?? { data: { pending: 0 } };
        else out = opts.stage?.(fn) ?? { data: {} };
        return { data: out.data ?? null, error: out.error ?? null };
      },
    };
    const authCalls: string[] = [];
    const authAdmin: AuthAdmin = {
      banUser: async () => (authCalls.push("ban"), opts.ban ?? { outcome: "ok" }),
      deleteUser: async () => (authCalls.push("delete"), opts.del ?? { outcome: "ok" }),
    };
    const deps: WorkerDeps = {
      db,
      authAdmin,
      workerId: "w-test",
      ...(opts.now ? { now: opts.now } : {}),
    };
    return { deps, log, authCalls };
  }
  const job = { requestId: REQ_ID, userId: USER };
  const finishes = (log: Array<{ fn: string; args: Record<string, unknown> }>) =>
    log
      .filter((l) => l.fn === "account_deletion_step_finish")
      .map((l) => [l.args.p_stage, l.args.p_ok, l.args.p_error_code]);

  it("recorre las 6 etapas en orden, bloquea ANTES de borrar la identidad y completa", async () => {
    const { deps, log, authCalls } = workerFake();
    const summary = await runDeletionJob(deps, job);
    expect(summary).toMatchObject({ completed: true, stagesDone: 6, failedStage: null });
    expect(finishes(log).map((f) => f[0])).toEqual([...DELETION_STAGES]);
    expect(authCalls).toEqual(["ban", "delete"]);
    const order = log
      .map((l) => l.fn)
      .filter(
        (f) =>
          f !== "account_deletion_step_start" && f !== "account_deletion_step_finish",
      );
    expect(order).toEqual([
      "account_deletion_revoke_sessions",
      "account_deletion_stage_copyright",
      "account_deletion_stage_content",
      "account_deletion_stage_profile",
      "account_deletion_stage_media",
    ]);
    expect(
      log.every((l) => l.args.p_worker === undefined || l.args.p_worker === "w-test"),
    ).toBe(true);
  });

  it("fallo de Auth (bloqueo): etapa fallida con código seguro, se detiene y no se borra nada más", async () => {
    const { deps, log, authCalls } = workerFake({ ban: { outcome: "error" } });
    const summary = await runDeletionJob(deps, job);
    expect(summary).toMatchObject({ completed: false, failedStage: "auth_block" });
    expect(finishes(log)).toEqual([["auth_block", false, "auth_unavailable"]]);
    expect(authCalls).toEqual(["ban"]);
    expect(log.some((l) => l.fn === "account_deletion_stage_content")).toBe(false);
  });

  it("fallo al borrar la identidad: auth_unavailable; last_admin_protected se señala tal cual; identidad ya inexistente = éxito", async () => {
    const a = workerFake({ del: { outcome: "error" } });
    expect(await runDeletionJob(a.deps, job)).toMatchObject({
      failedStage: "auth_delete",
      completed: false,
    });
    expect(finishes(a.log).at(-1)).toEqual(["auth_delete", false, "auth_unavailable"]);
    const b = workerFake({ del: { outcome: "error", lastAdminProtected: true } });
    await runDeletionJob(b.deps, job);
    expect(finishes(b.log).at(-1)).toEqual([
      "auth_delete",
      false,
      "last_admin_protected",
    ]);
    const c = workerFake({
      del: { outcome: "not_found" },
      ban: { outcome: "not_found" },
    });
    expect(await runDeletionJob(c.deps, job)).toMatchObject({ completed: true });
  });

  it("GC de R2 aún pendiente: la etapa NO se marca hecha (media_gc_pending, reintento a 5 min) y la identidad no se toca", async () => {
    const { deps, log, authCalls } = workerFake({
      stage: (fn) =>
        fn === "account_deletion_stage_media" ? { data: { pending: 2 } } : { data: {} },
    });
    const summary = await runDeletionJob(deps, job);
    expect(summary).toMatchObject({ failedStage: "media_gc", completed: false });
    const last = log.filter((l) => l.fn === "account_deletion_step_finish").at(-1)!;
    expect(last.args).toMatchObject({
      p_stage: "media_gc",
      p_ok: false,
      p_error_code: "media_gc_pending",
      p_retry_after_seconds: 300,
    });
    expect(authCalls).toEqual(["ban"]);
    const bad = workerFake({
      stage: (fn) =>
        fn === "account_deletion_stage_media" ? { data: { pending: "x" } } : { data: {} },
    });
    await runDeletionJob(bad.deps, job);
    expect(finishes(bad.log).at(-1)).toEqual(["media_gc", false, "unexpected"]);
  });

  it("errores de la BD se reducen a códigos cerrados (avatar) o db_error, sin propagar el texto", async () => {
    const { deps, log } = workerFake({
      stage: (fn) =>
        fn === "account_deletion_stage_profile"
          ? { error: { message: "avatar_not_supported" } }
          : fn === "account_deletion_stage_copyright"
            ? {}
            : {},
    });
    await runDeletionJob(deps, job);
    expect(finishes(log).at(-1)).toEqual(["profile", false, "avatar_not_supported"]);
    const generic = workerFake({
      stage: (fn) =>
        fn === "account_deletion_stage_content"
          ? { error: { message: "violates foreign key constraint secret" } }
          : {},
    });
    await runDeletionJob(generic.deps, job);
    expect(finishes(generic.log).at(-1)).toEqual([
      "community_content",
      false,
      "db_error",
    ]);
    expect(JSON.stringify(generic.log)).not.toContain("secret");
  });

  it("lease perdido o fuera de orden: el ejecutor se retira SIN registrar nada (otro lo reanuda)", async () => {
    const a = workerFake({ start: () => ({ error: { message: "lease_lost" } }) });
    expect(await runDeletionJob(a.deps, job)).toMatchObject({
      stagesDone: 0,
      completed: false,
    });
    expect(a.log.map((l) => l.fn)).toEqual(["account_deletion_step_start"]);
    const b = workerFake({
      stage: (fn) =>
        fn === "account_deletion_stage_copyright"
          ? { error: { message: "lease_lost" } }
          : {},
    });
    await runDeletionJob(b.deps, job);
    expect(finishes(b.log).map((f) => f[0])).toEqual(["auth_block"]); // copyright_claims: sin finish
  });

  it("etapas ya hechas se saltan (idempotencia tras un reinicio) y un excepción inesperada se registra como unexpected", async () => {
    const done = new Set(["auth_block", "copyright_claims", "community_content"]);
    const a = workerFake({
      start: (stage) => ({ data: { alreadyDone: done.has(stage) } }),
    });
    const summary = await runDeletionJob(a.deps, job);
    expect(summary).toMatchObject({ completed: true, stagesDone: 6 });
    expect(a.authCalls).toEqual(["delete"]); // el bloqueo ya estaba hecho
    const boom = workerFake();
    boom.deps.authAdmin.banUser = async () => {
      throw new Error("red caída con detalle sensible");
    };
    await runDeletionJob(boom.deps, job);
    expect(finishes(boom.log).at(-1)).toEqual(["auth_block", false, "unexpected"]);
    expect(JSON.stringify(boom.log)).not.toContain("sensible");
  });

  it("sin tiempo disponible: libera la solicitud (sin contar fallo) antes de empezar otra etapa", async () => {
    let t = 0;
    const { deps, log } = workerFake({ now: () => (t += 1000) });
    const summary = await runDeletionJob(deps, job, 2500);
    expect(summary.released).toBe(true);
    expect(log.at(-1)!.fn).toBe("account_deletion_release");
    expect(
      log.some((l) => l.fn === "account_deletion_step_finish" && l.args.p_ok === false),
    ).toBe(false);
  });

  it("lote: reclama con lease, ignora filas incoherentes y cuenta resultados", async () => {
    const { deps, log } = workerFake();
    const claim = vi.spyOn(deps.db, "rpc");
    claim.mockImplementationOnce(async (fn, args) => {
      log.push({ fn, args: args ?? {} });
      return {
        data: [{ requestId: REQ_ID, userId: USER }, { requestId: 1 }, {}],
        error: null,
      };
    });
    const out = await runAccountDeletionBatch(deps, { limit: 2, leaseSeconds: 120 });
    expect(out).toEqual({ claimed: 1, completed: 1, failed: 0, released: 0 });
    expect(log[0]).toEqual({
      fn: "account_deletion_claim",
      args: { p_worker: "w-test", p_lease_seconds: 120, p_limit: 2 },
    });
    const broken: WorkerDeps = {
      ...deps,
      db: { rpc: async () => ({ data: null, error: { message: "x" } }) },
    };
    expect(await runAccountDeletionBatch(broken)).toEqual({
      claimed: 0,
      completed: 0,
      failed: 0,
      released: 0,
    });
  });
});

describe("correo de confirmación", () => {
  it("está en inglés, explica la irreversibilidad, lleva el token solo en el enlace con fragmento y no incluye moderación ni datos personales", () => {
    const link = buildAccountDeletionLink("https://app.example/", TOKEN);
    expect(link).toBe(`https://app.example/account/delete#t=${TOKEN}`);
    const { subject, text, html } = buildAccountDeletionEmail({
      link,
      expiresInMinutes: 30,
    });
    expect(subject).toBe("Upmina Community - Confirm the deletion of your account");
    expect(text).toContain("irreversible");
    expect(text).toContain("Nothing has been deleted yet");
    expect(text).toContain("expires in 30 minutes");
    expect(text.split(TOKEN).length - 1).toBe(1);
    expect(text).not.toMatch(/strike|copyright|appeal|claim|CPY-/i);
    expect(html).toContain("<p ");
  });

  it("la configuración propia (ACCOUNT_DELETION_APP_URL) solo acepta https y falla cerrada; sin configuración base no hay envío", async () => {
    const base = {
      MFA_RECOVERY_RESEND_API_KEY: "re_sintetica",
      MFA_RECOVERY_MAIL_FROM: "Upmina <no-reply@example.com>",
      MFA_RECOVERY_APP_URL: "https://prod.example",
    } as unknown as NodeJS.ProcessEnv;
    expect(readAccountDeletionMailConfig(base)?.appUrl).toBe("https://prod.example");
    expect(
      readAccountDeletionMailConfig({
        ...base,
        ACCOUNT_DELETION_APP_URL: "https://preview.example/",
      })?.appUrl,
    ).toBe("https://preview.example");
    expect(
      readAccountDeletionMailConfig({
        ...base,
        ACCOUNT_DELETION_APP_URL: "http://inseguro.example",
      }),
    ).toBeNull();
    expect(readAccountDeletionMailConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      await sendAccountDeletionEmail(null, {
        to: "a@example.com",
        token: TOKEN,
        expiresInMinutes: 30,
        idempotencyKey: "k",
      }),
    ).toEqual({ ok: false, errorClass: "not_configured" });
    expect(
      await sendAccountDeletionEmail(readAccountDeletionMailConfig(base), {
        to: null,
        token: TOKEN,
        expiresInMinutes: 30,
        idempotencyKey: "k",
      }),
    ).toEqual({ ok: false, errorClass: "no_recipient" });
  });
});
