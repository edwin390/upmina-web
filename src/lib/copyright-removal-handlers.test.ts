// @vitest-environment node
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./admin-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./admin-auth.js")>()),
  requireCapability: vi.fn(),
  requireAuthenticated: vi.fn(),
}));

import { AdminAuthError, requireAuthenticated, requireCapability } from "./admin-auth.js";
import {
  appealWindowMinutes,
  readCopyrightMailConfig,
  defaultRemovalDeps,
  handleCopyrightAppealContext,
  handleCopyrightAppealResolve,
  handleCopyrightAppealSubmit,
  handleCopyrightClaimNotice,
  handleCopyrightClaimPurge,
  handleCopyrightClaimRemove,
  hashAppealToken,
  type CopyrightRemovalDeps,
} from "./copyright-removal-handlers";
import type { MailConfig } from "./mfa-recovery-mail";

// COPY-1 fase 2B: handlers REALES con Supabase y correo dobles. No se envía nada real ni se toca ninguna base de datos.

const MOD = "0f000000-0000-4000-8000-000000000001";
const AUTHOR = "0f000000-0000-4000-8000-0000000000a1";
const CLAIM = "0f000000-0000-4000-8000-0000000000c1";
const REF = "CPY-2026-000001";
const TOKEN = "A".repeat(43);
const REASON = "El contenido reproduce la obra identificada sin autorización";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

interface Reply {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}
function call(
  handler: (req: VercelRequest, res: VercelResponse) => unknown,
  init: { method?: string; body?: unknown },
): Promise<Reply> {
  const reply: Reply = { status: 0, body: undefined, headers: {} };
  const res = {
    setHeader: (k: string, v: string) => {
      reply.headers[k] = v;
      return res;
    },
    status: (s: number) => {
      reply.status = s;
      return res;
    },
    json: (b: unknown) => {
      reply.body = b;
      return res;
    },
  } as unknown as VercelResponse;
  const req = {
    method: init.method ?? "POST",
    body: init.body,
    headers: {},
    query: {},
  } as unknown as VercelRequest;
  return Promise.resolve(handler(req, res)).then(() => reply);
}

type RpcHandler = (params: Record<string, unknown>) => { data: unknown; error: unknown };
function fakeClient(handlers: Record<string, RpcHandler>) {
  const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
    const h = handlers[name];
    return h
      ? h(params)
      : { data: null, error: { code: "XX000", message: "unexpected" } };
  });
  return { rpc, client: { rpc } as unknown as SupabaseClient };
}
const okRecord: RpcHandler = () => ({ data: { id: CLAIM, version: 4 }, error: null });
const removeOut = (over: Record<string, unknown> = {}) => ({
  id: CLAIM,
  reference: REF,
  status: "removed",
  version: 3,
  updatedAt: "2026-10-12T10:00:00.000Z",
  notice: {
    kind: "removal",
    authorEmail: "autor@example.com",
    reason: REASON,
    windowMinutes: 60,
  },
  ...over,
});

function mailFake(result: { ok: boolean; errorClass?: string } = { ok: true }) {
  const send = vi.fn(async () => result);
  const config = {
    sender: { send },
    appUrl: "https://app.example",
  } as unknown as MailConfig;
  return { send, config };
}
function deps(
  client: SupabaseClient | null,
  over: Partial<CopyrightRemovalDeps> = {},
): CopyrightRemovalDeps {
  return {
    client: () => client,
    ipSecret: () => "synthetic-secret",
    mail: () => mailFake().config,
    newToken: () => TOKEN,
    windowMinutes: () => 1440,
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(requireCapability).mockReset();
  vi.mocked(requireCapability).mockResolvedValue({ userId: MOD } as never);
  vi.mocked(requireAuthenticated).mockReset();
  vi.mocked(requireAuthenticated).mockResolvedValue({ userId: AUTHOR } as never);
});

describe("plazo de apelación decidido por el servidor", () => {
  it.each([
    [{ VERCEL_ENV: "production", COPYRIGHT_TEST_WINDOW_MINUTES: "60" }, 1440],
    [{ VERCEL_ENV: "production" }, 1440],
    [{ VERCEL_ENV: "preview", COPYRIGHT_TEST_WINDOW_MINUTES: "60" }, 60],
    [{ VERCEL_ENV: "development", COPYRIGHT_TEST_WINDOW_MINUTES: " 60 " }, 60],
    [{ VERCEL_ENV: "preview" }, 1440],
    [{ VERCEL_ENV: "preview", COPYRIGHT_TEST_WINDOW_MINUTES: "30" }, 1440],
    [{ VERCEL_ENV: "preview", COPYRIGHT_TEST_WINDOW_MINUTES: "1" }, 1440],
    [{ VERCEL_ENV: "preview", COPYRIGHT_TEST_WINDOW_MINUTES: "1440" }, 1440],
    [{ VERCEL_ENV: "preview", COPYRIGHT_TEST_WINDOW_MINUTES: "060" }, 1440],
    [{ COPYRIGHT_TEST_WINDOW_MINUTES: "60" }, 1440],
    [{ VERCEL_ENV: "Production", COPYRIGHT_TEST_WINDOW_MINUTES: "60" }, 1440],
    [{ VERCEL_ENV: "staging", COPYRIGHT_TEST_WINDOW_MINUTES: "60" }, 1440],
    [{}, 1440],
  ])("%j → %s minutos", (env, minutes) => {
    expect(appealWindowMinutes(env as NodeJS.ProcessEnv)).toBe(minutes);
    expect(defaultRemovalDeps(env as NodeJS.ProcessEnv).windowMinutes()).toBe(minutes);
  });
});

describe("retirada", () => {
  const valid = {
    id: CLAIM,
    expectedVersion: 2,
    expectedPostVersion: 5,
    confirmReference: REF,
    reason: REASON,
  };

  it("oculta, avisa al autor en inglés con el enlace personal y registra el envío; el token solo viaja hasta el correo", async () => {
    const mail = mailFake();
    const { rpc, client } = fakeClient({
      copyright_claim_remove: () => ({ data: removeOut(), error: null }),
      copyright_claim_notice_record: okRecord,
    });
    const reply = await call(
      (q, s) =>
        handleCopyrightClaimRemove(
          q,
          s,
          deps(client, { mail: () => mail.config, windowMinutes: () => 60 }),
        ),
      { body: valid },
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      claim: { status: "removed", reference: REF, notice: "sent", noticeError: null },
    });
    const removeCall = rpc.mock.calls.find((c) => c[0] === "copyright_claim_remove")![1];
    expect(removeCall).toEqual({
      p_actor_user_id: MOD,
      p_claim_id: CLAIM,
      p_expected_version: 2,
      p_expected_post_version: 5,
      p_confirm_reference: REF,
      p_reason: REASON,
      p_token_hash: sha(TOKEN),
      p_window_minutes: 60,
    });
    expect(JSON.stringify(removeCall)).not.toContain(TOKEN);
    const message = (mail.send.mock.calls[0] as unknown as [Record<string, string>])[0];
    expect(message.to).toBe("autor@example.com");
    expect(message.subject).toMatch(/^Upminaa Web: your post was hidden/);
    expect(message.text).toContain(`https://app.example/copyright/appeal#t=${TOKEN}`);
    expect(message.text).toContain(REF);
    expect(message.text).toContain(REASON);
    expect(message.text).toContain("1 hour");
    expect(message.idempotencyKey).toBe(`copyright:${CLAIM}:removal:v3`);
    expect(JSON.stringify(reply.body)).not.toContain(TOKEN);
    expect(JSON.stringify(reply.body)).not.toContain("autor@example.com");
    expect(rpc).toHaveBeenCalledWith("copyright_claim_notice_record", {
      p_actor_user_id: MOD,
      p_claim_id: CLAIM,
      p_kind: "removal",
      p_ok: true,
      p_error_class: null,
    });
  });

  it("el plazo lo fija el servidor: el cliente no puede enviarlo ni elegir otro", async () => {
    const { rpc, client } = fakeClient({
      copyright_claim_remove: () => ({ data: removeOut(), error: null }),
      copyright_claim_notice_record: okRecord,
    });
    const reply = await call((q, s) => handleCopyrightClaimRemove(q, s, deps(client)), {
      body: { ...valid, windowMinutes: 60 },
    });
    expect(reply.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
    await call(
      (q, s) =>
        handleCopyrightClaimRemove(q, s, deps(client, { windowMinutes: () => 1440 })),
      {
        body: valid,
      },
    );
    expect(
      rpc.mock.calls.find((c) => c[0] === "copyright_claim_remove")![1],
    ).toMatchObject({
      p_window_minutes: 1440,
    });
  });

  it("si el correo falla, la retirada se conserva y el fallo se registra con su clase (sin repetir la acción)", async () => {
    const mail = mailFake({ ok: false, errorClass: "provider_unavailable" });
    const { rpc, client } = fakeClient({
      copyright_claim_remove: () => ({ data: removeOut(), error: null }),
      copyright_claim_notice_record: okRecord,
    });
    const reply = await call(
      (q, s) =>
        handleCopyrightClaimRemove(q, s, deps(client, { mail: () => mail.config })),
      { body: valid },
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      claim: { status: "removed", notice: "failed", noticeError: "provider_unavailable" },
    });
    expect(rpc.mock.calls.filter((c) => c[0] === "copyright_claim_remove")).toHaveLength(
      1,
    );
    expect(rpc).toHaveBeenCalledWith(
      "copyright_claim_notice_record",
      expect.objectContaining({ p_ok: false, p_error_class: "provider_unavailable" }),
    );
  });

  it("sin correo configurado o sin destinatario el aviso queda fallido y reintentable", async () => {
    for (const [override, expected] of [
      [{ mail: () => null }, "not_configured"],
      [{ mail: () => mailFake().config }, "no_recipient"],
    ] as const) {
      const { rpc, client } = fakeClient({
        copyright_claim_remove: () => ({
          data: removeOut(
            expected === "no_recipient"
              ? {
                  notice: {
                    kind: "removal",
                    authorEmail: null,
                    reason: REASON,
                    windowMinutes: 60,
                  },
                }
              : {},
          ),
          error: null,
        }),
        copyright_claim_notice_record: okRecord,
      });
      const reply = await call(
        (q, s) => handleCopyrightClaimRemove(q, s, deps(client, override)),
        { body: valid },
      );
      expect(reply.body).toMatchObject({
        claim: { notice: "failed", noticeError: expected },
      });
      expect(rpc).toHaveBeenCalledWith(
        "copyright_claim_notice_record",
        expect.objectContaining({ p_ok: false, p_error_class: expected }),
      );
    }
  });

  it("si el registro del aviso también falla, se informa como fallido para que la moderación reintente", async () => {
    const { client } = fakeClient({
      copyright_claim_remove: () => ({ data: removeOut(), error: null }),
      copyright_claim_notice_record: () => ({
        data: null,
        error: { code: "XX000", message: "db" },
      }),
    });
    const reply = await call((q, s) => handleCopyrightClaimRemove(q, s, deps(client)), {
      body: valid,
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ claim: { notice: "failed" } });
  });

  it("exige moderación con MFA: sin capacidad no consulta nada ni envía nada", async () => {
    const mail = mailFake();
    const { rpc, client } = fakeClient({});
    for (const status of [401, 403] as const) {
      vi.mocked(requireCapability).mockRejectedValue(
        new AdminAuthError("rechazo", status),
      );
      const reply = await call(
        (q, s) =>
          handleCopyrightClaimRemove(q, s, deps(client, { mail: () => mail.config })),
        { body: valid },
      );
      expect(reply.status).toBe(status);
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it.each([
    ["método", { method: "GET" }, 405],
    ["cuerpo vacío", { body: undefined }, 400],
    ["clave desconocida", { body: { ...valid, extra: 1 } }, 400],
    ["id inválido", { body: { ...valid, id: "x" } }, 400],
    ["versión inválida", { body: { ...valid, expectedVersion: 0 } }, 400],
    [
      "versión de la publicación inválida",
      { body: { ...valid, expectedPostVersion: "2" } },
      400,
    ],
    ["confirmación inválida", { body: { ...valid, confirmReference: "otra" } }, 400],
    ["motivo ausente", { body: { ...valid, reason: undefined } }, 400],
    ["motivo corto", { body: { ...valid, reason: "corto" } }, 400],
    ["motivo con control", { body: { ...valid, reason: `${REASON}\u0007` } }, 400],
    ["motivo largo", { body: { ...valid, reason: "a".repeat(1001) } }, 400],
  ])("%s → rechazo sin consultar la base de datos", async (_name, init, status) => {
    const { rpc, client } = fakeClient({});
    const reply = await call(
      (q, s) => handleCopyrightClaimRemove(q, s, deps(client)),
      init,
    );
    expect(reply.status).toBe(status);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["version_conflict", 409],
    ["invalid_transition", 409],
    ["confirmation_mismatch", 409],
    ["post_state_conflict", 409],
    ["post_version_conflict", 409],
    ["post_not_found", 409],
    ["actor_not_moderator", 403],
    ["claim_not_found", 404],
  ])(
    "error de negocio %s → %s sin detalles internos y sin enviar correo",
    async (code, status) => {
      const mail = mailFake();
      const { client } = fakeClient({
        copyright_claim_remove: () => ({
          data: null,
          error: { code: "P0001", message: code },
        }),
      });
      const reply = await call(
        (q, s) =>
          handleCopyrightClaimRemove(q, s, deps(client, { mail: () => mail.config })),
        { body: valid },
      );
      expect(reply.status).toBe(status);
      expect(reply.body).toMatchObject({ code });
      expect(mail.send).not.toHaveBeenCalled();
    },
  );

  it("un error inesperado de la base de datos es genérico", async () => {
    const { client } = fakeClient({
      copyright_claim_remove: () => ({
        data: null,
        error: { code: "XX000", message: "relation copyright_secret does not exist" },
      }),
    });
    const reply = await call((q, s) => handleCopyrightClaimRemove(q, s, deps(client)), {
      body: valid,
    });
    expect(reply.status).toBe(500);
    expect(JSON.stringify(reply.body)).not.toContain("copyright_secret");
  });
});

describe("reintento de aviso", () => {
  it("el aviso inicial reemite un token NUEVO y lo envía; los avisos de resolución no llevan enlace", async () => {
    const mail = mailFake();
    let n = 0;
    const { rpc, client } = fakeClient({
      copyright_claim_notice_context: (p) => ({
        data: {
          id: CLAIM,
          reference: REF,
          status: p.p_kind === "removal" ? "removed" : "restored",
          version: 5,
          updatedAt: "2026-10-12T10:00:00.000Z",
          notice: {
            kind: p.p_kind,
            authorEmail: "autor@example.com",
            reason: REASON,
            windowMinutes: 1440,
            resolutionNote: "Justificación de la moderación",
          },
        },
        error: null,
      }),
      copyright_claim_notice_record: okRecord,
    });
    const d = deps(client, {
      mail: () => mail.config,
      newToken: () => `T${++n}`.padEnd(43, "x"),
    });
    const first = await call((q, s) => handleCopyrightClaimNotice(q, s, d), {
      body: { id: CLAIM, kind: "removal" },
    });
    expect(first.status).toBe(200);
    const ctx = rpc.mock.calls[0]![1];
    expect(ctx.p_token_hash).toBe(sha("T1".padEnd(43, "x")));
    const removalMail = (
      mail.send.mock.calls[0] as unknown as [Record<string, string>]
    )[0];
    expect(removalMail.text).toContain("#t=T1");
    expect(removalMail.idempotencyKey).toBe(`copyright:${CLAIM}:removal:v5`);

    const second = await call((q, s) => handleCopyrightClaimNotice(q, s, d), {
      body: { id: CLAIM, kind: "appeal_accepted" },
    });
    expect(second.status).toBe(200);
    expect(rpc.mock.calls[2]![1].p_token_hash).toBeNull();
    const accepted = (mail.send.mock.calls[1] as unknown as [Record<string, string>])[0];
    expect(accepted.text).not.toContain("/copyright/appeal");
    expect(accepted.text).toContain("Justificación de la moderación");
    expect(accepted.subject).toMatch(/appeal was accepted/);
  });

  it("rechaza tipos desconocidos y claves extra sin consultar nada", async () => {
    const { rpc, client } = fakeClient({});
    for (const body of [
      { id: CLAIM, kind: "otro" },
      { id: CLAIM, kind: "removal", extra: 1 },
      { id: "x", kind: "removal" },
    ]) {
      const reply = await call((q, s) => handleCopyrightClaimNotice(q, s, deps(client)), {
        body,
      });
      expect(reply.status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("resolución de la apelación", () => {
  const ok = {
    id: CLAIM,
    expectedVersion: 7,
    decision: "accept",
    note: "Se acepta la apelación",
  };
  const resolveOut = (status: string) => ({
    id: CLAIM,
    reference: REF,
    status,
    version: 8,
    updatedAt: "2026-10-12T10:00:00.000Z",
    notice: {
      kind: status === "restored" ? "appeal_accepted" : "appeal_rejected",
      authorEmail: "autor@example.com",
      reason: REASON,
      windowMinutes: 60,
      resolutionNote: "Se acepta la apelación",
    },
  });

  it("acepta o rechaza con justificación, envía el aviso y registra el resultado", async () => {
    for (const [decision, status] of [
      ["accept", "restored"],
      ["reject", "removed"],
    ] as const) {
      const mail = mailFake();
      const { rpc, client } = fakeClient({
        copyright_appeal_resolve: () => ({ data: resolveOut(status), error: null }),
        copyright_claim_notice_record: okRecord,
      });
      const reply = await call(
        (q, s) =>
          handleCopyrightAppealResolve(q, s, deps(client, { mail: () => mail.config })),
        { body: { ...ok, decision } },
      );
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ claim: { status, notice: "sent" } });
      expect(rpc.mock.calls[0]![1]).toEqual({
        p_actor_user_id: MOD,
        p_claim_id: CLAIM,
        p_expected_version: 7,
        p_decision: decision,
        p_note: "Se acepta la apelación",
      });
      expect(rpc).toHaveBeenCalledWith(
        "copyright_claim_notice_record",
        expect.objectContaining({
          p_kind: decision === "accept" ? "appeal_accepted" : "appeal_rejected",
          p_ok: true,
        }),
      );
    }
  });

  it("si el correo de resolución falla, la decisión se conserva y el aviso queda pendiente (sin repetir la acción)", async () => {
    const mail = mailFake({ ok: false, errorClass: "timeout" });
    const { rpc, client } = fakeClient({
      copyright_appeal_resolve: () => ({ data: resolveOut("restored"), error: null }),
      copyright_claim_notice_record: okRecord,
    });
    const reply = await call(
      (q, s) =>
        handleCopyrightAppealResolve(q, s, deps(client, { mail: () => mail.config })),
      { body: ok },
    );
    expect(reply.body).toMatchObject({
      claim: { status: "restored", notice: "failed", noticeError: "timeout" },
    });
    expect(
      rpc.mock.calls.filter((c) => c[0] === "copyright_appeal_resolve"),
    ).toHaveLength(1);
  });

  it.each([
    ["sin nota", { note: undefined }],
    ["nota vacía", { note: "   " }],
    ["decisión desconocida", { decision: "otra" }],
    ["versión inválida", { expectedVersion: 0 }],
    ["clave extra", { extra: true }],
  ])("%s → 400 sin consultar", async (_n, over) => {
    const { rpc, client } = fakeClient({});
    const reply = await call((q, s) => handleCopyrightAppealResolve(q, s, deps(client)), {
      body: { ...ok, ...over },
    });
    expect(reply.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("restore_unsafe se informa como conflicto y no envía correo", async () => {
    const mail = mailFake();
    const { client } = fakeClient({
      copyright_appeal_resolve: () => ({
        data: null,
        error: { code: "P0001", message: "restore_unsafe" },
      }),
    });
    const reply = await call(
      (q, s) =>
        handleCopyrightAppealResolve(q, s, deps(client, { mail: () => mail.config })),
      { body: ok },
    );
    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({ code: "restore_unsafe" });
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("exige moderación", async () => {
    vi.mocked(requireCapability).mockRejectedValue(new AdminAuthError("x", 403));
    const { rpc, client } = fakeClient({});
    expect(
      (
        await call((q, s) => handleCopyrightAppealResolve(q, s, deps(client)), {
          body: ok,
        })
      ).status,
    ).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("eliminación definitiva", () => {
  const ok = {
    id: CLAIM,
    expectedVersion: 9,
    confirmReference: REF,
    note: "Eliminación confirmada",
  };

  it("reenvía la confirmación y la nota a la RPC (que repite todas las condiciones) y devuelve el resumen", async () => {
    const mail = mailFake();
    const { rpc, client } = fakeClient({
      copyright_claim_purge: () => ({
        data: {
          id: CLAIM,
          reference: REF,
          status: "purged",
          version: 10,
          updatedAt: "2026-10-12T10:00:00.000Z",
          postDeleted: true,
          assetsMarked: 2,
          assetsRetained: 1,
        },
        error: null,
      }),
    });
    const reply = await call(
      (q, s) =>
        handleCopyrightClaimPurge(q, s, deps(client, { mail: () => mail.config })),
      { body: ok },
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      claim: {
        status: "purged",
        assetsMarked: 2,
        assetsRetained: 1,
        postDeleted: true,
        notice: "none",
      },
    });
    expect(rpc).toHaveBeenCalledWith("copyright_claim_purge", {
      p_actor_user_id: MOD,
      p_claim_id: CLAIM,
      p_expected_version: 9,
      p_confirm_reference: REF,
      p_note: "Eliminación confirmada",
    });
    expect(mail.send).not.toHaveBeenCalled();
  });

  it.each([
    ["purge_blocked", 409],
    ["version_conflict", 409],
    ["confirmation_mismatch", 409],
    ["post_state_conflict", 409],
    ["note_required", 400],
    ["actor_not_moderator", 403],
  ])(
    "el rechazo de la RPC (%s) llega como %s aunque el botón estuviera habilitado",
    async (code, status) => {
      const { client } = fakeClient({
        copyright_claim_purge: () => ({
          data: null,
          error: { code: "P0001", message: code },
        }),
      });
      const reply = await call((q, s) => handleCopyrightClaimPurge(q, s, deps(client)), {
        body: ok,
      });
      expect(reply.status).toBe(status);
      expect(reply.body).toMatchObject({ code });
    },
  );

  it.each([
    ["sin nota", { note: undefined }],
    ["sin confirmación", { confirmReference: undefined }],
    ["confirmación con otro formato", { confirmReference: "borrar" }],
    ["clave extra", { force: true }],
  ])("%s → 400 sin consultar", async (_n, over) => {
    const { rpc, client } = fakeClient({});
    const reply = await call((q, s) => handleCopyrightClaimPurge(q, s, deps(client)), {
      body: { ...ok, ...over },
    });
    expect(reply.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("no hay ningún camino automático: solo POST de un moderador con MFA", async () => {
    const { rpc, client } = fakeClient({});
    expect(
      (
        await call((q, s) => handleCopyrightClaimPurge(q, s, deps(client)), {
          method: "GET",
        })
      ).status,
    ).toBe(405);
    vi.mocked(requireCapability).mockRejectedValue(new AdminAuthError("x", 401));
    expect(
      (await call((q, s) => handleCopyrightClaimPurge(q, s, deps(client)), { body: ok }))
        .status,
    ).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("apelación del autor", () => {
  const form = {
    contactName: "Autor Original",
    contactEmail: " Autor@Example.com ",
    reason: "own_work",
    explanation: "La ilustración es mía y la publiqué antes que la reclamante",
    evidenceText: "Archivo fuente con fechas",
    evidenceUrls: ["https://example.com/portafolio"],
    statementVersion: "v1",
    statementAccepted: true,
  };

  it("el estado se consulta con sesión y token; el token se envía como SHA-256 y el autor viene de la sesión verificada", async () => {
    const { rpc, client } = fakeClient({
      copyright_appeal_context: () => ({
        data: {
          reference: REF,
          state: "open",
          reason: REASON,
          removedAt: "2026-10-12T10:00:00.000Z",
          appealDeadline: "2026-10-12T11:00:00.000Z",
          appealStatus: null,
          claimStatus: "removed",
        },
        error: null,
      }),
    });
    const reply = await call((q, s) => handleCopyrightAppealContext(q, s, deps(client)), {
      body: { token: TOKEN },
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      appeal: {
        reference: REF,
        state: "open",
        reason: REASON,
        removedAt: "2026-10-12T10:00:00.000Z",
        appealDeadline: "2026-10-12T11:00:00.000Z",
        appealStatus: null,
      },
    });
    expect(rpc).toHaveBeenCalledWith("copyright_appeal_context", {
      p_user_id: AUTHOR,
      p_token_hash: sha(TOKEN),
    });
    expect(hashAppealToken(TOKEN)).toBe(sha(TOKEN));
  });

  it("sin sesión → 401 y no consulta; la identidad del cuerpo se ignora", async () => {
    vi.mocked(requireAuthenticated).mockRejectedValue(
      new AdminAuthError("No autenticado", 401),
    );
    const { rpc, client } = fakeClient({});
    expect(
      (
        await call((q, s) => handleCopyrightAppealContext(q, s, deps(client)), {
          body: { token: TOKEN },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call((q, s) => handleCopyrightAppealSubmit(q, s, deps(client)), {
          body: { token: TOKEN, appeal: form },
        })
      ).status,
    ).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
    vi.mocked(requireAuthenticated).mockResolvedValue({ userId: AUTHOR } as never);
    expect(
      (
        await call((q, s) => handleCopyrightAppealContext(q, s, deps(client)), {
          body: { token: TOKEN, userId: "otro" },
        })
      ).status,
    ).toBe(400);
  });

  it("un token mal formado o inexistente responde igual (404 genérico) y nunca revela el motivo", async () => {
    const { rpc, client } = fakeClient({
      copyright_appeal_context: () => ({
        data: null,
        error: { code: "P0001", message: "appeal_not_available" },
      }),
    });
    for (const token of ["corto", "", "A".repeat(44), "!".repeat(43)]) {
      const reply = await call(
        (q, s) => handleCopyrightAppealContext(q, s, deps(client)),
        {
          body: { token },
        },
      );
      expect(reply.status).toBe(404);
      expect(reply.body).toMatchObject({ code: "appeal_not_available" });
    }
    expect(rpc).not.toHaveBeenCalled();
    const wrongAuthor = await call(
      (q, s) => handleCopyrightAppealContext(q, s, deps(client)),
      {
        body: { token: TOKEN },
      },
    );
    expect(wrongAuthor.status).toBe(404);
    expect(wrongAuthor.body).toMatchObject({ code: "appeal_not_available" });
  });

  it("la presentación envía a la RPC el cuerpo NORMALIZADO por el servidor y responde 201", async () => {
    const { rpc, client } = fakeClient({
      copyright_appeal_submit: () => ({
        data: { reference: REF, state: "submitted" },
        error: null,
      }),
    });
    const reply = await call((q, s) => handleCopyrightAppealSubmit(q, s, deps(client)), {
      body: { token: TOKEN, appeal: form },
    });
    expect(reply.status).toBe(201);
    expect(reply.body).toEqual({ appeal: { reference: REF, state: "submitted" } });
    expect(rpc).toHaveBeenCalledWith("copyright_appeal_submit", {
      p_user_id: AUTHOR,
      p_token_hash: sha(TOKEN),
      p_input: {
        contactName: "Autor Original",
        contactEmail: "autor@example.com",
        reason: "own_work",
        explanation: form.explanation,
        evidenceText: "Archivo fuente con fechas",
        evidenceUrls: ["https://example.com/portafolio"],
        statementVersion: "v1",
        statementAccepted: true,
      },
    });
  });

  it.each([
    ["clave extra (archivo)", { file: "x" }],
    ["sin declaración", { statementAccepted: false }],
    ["correo inválido", { contactEmail: "no" }],
    ["razón desconocida", { reason: "otra" }],
    ["explicación corta", { explanation: "corta" }],
    ["sin pruebas", { evidenceText: null, evidenceUrls: [] }],
    ["enlace no http", { evidenceUrls: ["ftp://example.com/x"] }],
    ["versión de declaración distinta", { statementVersion: "v9" }],
  ])("%s → 400 sin consultar la base de datos", async (_n, over) => {
    const { rpc, client } = fakeClient({});
    const reply = await call((q, s) => handleCopyrightAppealSubmit(q, s, deps(client)), {
      body: { token: TOKEN, appeal: { ...form, ...over } },
    });
    expect(reply.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["appeal_already_submitted", 409],
    ["appeal_window_closed", 409],
    ["appeal_not_available", 404],
    ["invalid_input", 400],
  ])("la RPC responde %s → %s", async (code, status) => {
    const { client } = fakeClient({
      copyright_appeal_submit: () => ({
        data: null,
        error: { code: "P0001", message: code },
      }),
    });
    const reply = await call((q, s) => handleCopyrightAppealSubmit(q, s, deps(client)), {
      body: { token: TOKEN, appeal: form },
    });
    expect(reply.status).toBe(status);
    expect(reply.body).toMatchObject({ code });
  });

  it("no envía correo ni toca nada más, y solo admite POST", async () => {
    const mail = mailFake();
    const { client } = fakeClient({
      copyright_appeal_submit: () => ({
        data: { reference: REF, state: "submitted" },
        error: null,
      }),
    });
    await call(
      (q, s) =>
        handleCopyrightAppealSubmit(q, s, deps(client, { mail: () => mail.config })),
      {
        body: { token: TOKEN, appeal: form },
      },
    );
    expect(mail.send).not.toHaveBeenCalled();
    expect(
      (
        await call((q, s) => handleCopyrightAppealSubmit(q, s, deps(client)), {
          method: "GET",
        })
      ).status,
    ).toBe(405);
  });
});

describe("readCopyrightMailConfig · origen del enlace de apelación", () => {
  const base = {
    MFA_RECOVERY_RESEND_API_KEY: "synthetic-key",
    MFA_RECOVERY_MAIL_FROM: "Test <test@example.invalid>",
    MFA_RECOVERY_APP_URL: "https://mfa.example.invalid",
  };
  const origin = (extra: Record<string, string>) =>
    readCopyrightMailConfig({ ...base, ...extra } as NodeJS.ProcessEnv)?.appUrl;

  it("sin COPYRIGHT_APPEAL_APP_URL usa el origen de MFA; con ella usa el propio", () => {
    expect(origin({})).toBe("https://mfa.example.invalid");
    expect(origin({ COPYRIGHT_APPEAL_APP_URL: "https://preview.example.invalid/" })).toBe(
      "https://preview.example.invalid",
    );
  });
  it("si está definida pero no es un origen https válido, no hay configuración (fail closed)", () => {
    for (const bad of [
      "http://x.example.invalid",
      "https://x.example.invalid/ruta",
      "no-url",
    ])
      expect(origin({ COPYRIGHT_APPEAL_APP_URL: bad })).toBeUndefined();
  });
  it("sin la configuración de correo base no hay configuración aunque exista el origen propio", () => {
    expect(
      readCopyrightMailConfig({
        COPYRIGHT_APPEAL_APP_URL: "https://p.example.invalid",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});
