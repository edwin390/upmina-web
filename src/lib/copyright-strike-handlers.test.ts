// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./admin-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./admin-auth.js")>()),
  requireCapability: vi.fn(),
  requireAuthenticated: vi.fn(),
}));

import { AdminAuthError, requireCapability } from "./admin-auth.js";
import {
  handleCopyrightStrikeApply,
  handleCopyrightStrikeNotice,
  handleCopyrightStrikeState,
  type CopyrightRemovalDeps,
} from "./copyright-removal-handlers";
import type { MailConfig } from "./mfa-recovery-mail";

// Strikes manuales de Copyright: handlers REALES con Supabase y correo dobles. No se envía nada real ni se toca ninguna base de datos.

const MOD = "0f000000-0000-4000-8000-000000000001";
const CLAIM = "0f000000-0000-4000-8000-0000000000c1";
const STRIKE = "0f000000-0000-4000-8000-0000000000d1";
const REF = "CPY-2026-000001";
const REASON = "Copyright infringement confirmed after the permanent deletion.";

interface Reply {
  status: number;
  body: unknown;
}
function call(
  handler: (req: VercelRequest, res: VercelResponse) => unknown,
  init: { method?: string; body?: unknown },
): Promise<Reply> {
  const reply: Reply = { status: 0, body: undefined };
  const res = {
    setHeader: () => res,
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

type Rpc = (params: Record<string, unknown>) => { data: unknown; error: unknown };
function fakeClient(handlers: Record<string, Rpc>) {
  const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
    const h = handlers[name];
    return h
      ? h(params)
      : { data: null, error: { code: "XX000", message: "unexpected" } };
  });
  return { rpc, client: { rpc } as unknown as SupabaseClient };
}
const business = (message: string) => ({ code: "P0001", message });
const applyOut = (over: Record<string, unknown> = {}) => ({
  strikeId: STRIKE,
  claimId: CLAIM,
  reference: REF,
  level: 2,
  permanent: false,
  startsAt: "2026-10-14T10:00:00.000Z",
  endsAt: "2026-11-14T10:00:00.000Z",
  ...over,
});
const noticeContext = (strike: Record<string, unknown> = {}) => ({
  id: CLAIM,
  reference: REF,
  strike: {
    authorEmail: "autor@example.com",
    level: 2,
    permanent: false,
    endsAt: "2026-11-14T10:00:00.000Z",
    reason: REASON,
    ...strike,
  },
});
function mailFake(result: { ok: boolean; errorClass?: string } = { ok: true }) {
  const send = vi.fn(async (_message: Record<string, unknown>) => result);
  return {
    send,
    config: { sender: { send }, appUrl: "https://app.example" } as unknown as MailConfig,
  };
}
function deps(
  client: SupabaseClient | null,
  over: Partial<CopyrightRemovalDeps> = {},
): CopyrightRemovalDeps {
  return {
    client: () => client,
    ipSecret: () => "synthetic-secret",
    mail: () => mailFake().config,
    newToken: () => "A".repeat(43),
    windowMinutes: () => 1440,
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(requireCapability).mockReset();
  vi.mocked(requireCapability).mockResolvedValue({ userId: MOD } as never);
});

const apply = (body: unknown, d: CopyrightRemovalDeps, method?: string) =>
  call((req, res) => handleCopyrightStrikeApply(req, res, d), { body, method });

describe("copyright-strike-apply", () => {
  it("aplica el strike, envía UN aviso en inglés sin enlaces y registra su resultado", async () => {
    const mail = mailFake();
    const { rpc, client } = fakeClient({
      copyright_strike_apply: () => ({ data: applyOut(), error: null }),
      copyright_strike_notice_context: () => ({ data: noticeContext(), error: null }),
      copyright_strike_notice_record: () => ({ data: { id: CLAIM }, error: null }),
    });
    const out = await apply(
      { id: CLAIM, reason: `  ${REASON}  `, expectedLevel: 2 },
      deps(client, { mail: () => mail.config }),
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      strike: {
        strikeId: STRIKE,
        claimId: CLAIM,
        reference: REF,
        level: 2,
        permanent: false,
        endsAt: "2026-11-14T10:00:00.000Z",
        notice: "sent",
        noticeError: null,
      },
    });
    expect(rpc).toHaveBeenCalledWith("copyright_strike_apply", {
      p_actor_user_id: MOD,
      p_claim_id: CLAIM,
      p_reason: REASON,
      p_expected_level: 2,
    });
    expect(mail.send).toHaveBeenCalledTimes(1);
    const message = mail.send.mock.calls[0]![0] as Record<string, string>;
    expect(message.to).toBe("autor@example.com");
    expect(message.idempotencyKey).toBe(`copyright:${CLAIM}:strike`);
    expect(message.subject).toContain("copyright strike");
    expect(message.text).toContain("Strike level: 2 of 3.");
    expect(message.text).toContain(REASON);
    expect(message.text).toContain("ends on 2026-11-14 (UTC)");
    // Sin apelación nueva ni enlaces ni datos del reclamante.
    expect(message.text).not.toMatch(/https?:\/\/|appeal|claimant/i);
    expect(rpc).toHaveBeenCalledWith("copyright_strike_notice_record", {
      p_actor_user_id: MOD,
      p_claim_id: CLAIM,
      p_ok: true,
      p_error_class: null,
    });
  });

  it("nivel 3: el aviso indica una restricción permanente", async () => {
    const mail = mailFake();
    const { client } = fakeClient({
      copyright_strike_apply: () => ({
        data: applyOut({ level: 3, permanent: true, endsAt: null }),
        error: null,
      }),
      copyright_strike_notice_context: () => ({
        data: noticeContext({ level: 3, permanent: true, endsAt: null }),
        error: null,
      }),
      copyright_strike_notice_record: () => ({ data: { id: CLAIM }, error: null }),
    });
    const out = await apply(
      { id: CLAIM, reason: REASON },
      deps(client, { mail: () => mail.config }),
    );
    expect(out.status).toBe(200);
    expect((mail.send.mock.calls[0]![0] as Record<string, string>).text).toContain(
      "This restriction is permanent.",
    );
  });

  it("un fallo del correo no deshace el strike: queda registrado como fallido y reintentable", async () => {
    const mail = mailFake({ ok: false, errorClass: "provider_unavailable" });
    const { rpc, client } = fakeClient({
      copyright_strike_apply: () => ({ data: applyOut(), error: null }),
      copyright_strike_notice_context: () => ({ data: noticeContext(), error: null }),
      copyright_strike_notice_record: () => ({ data: { id: CLAIM }, error: null }),
    });
    const out = await apply(
      { id: CLAIM, reason: REASON },
      deps(client, { mail: () => mail.config }),
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      strike: { notice: "failed", noticeError: "provider_unavailable" },
    });
    expect(rpc).toHaveBeenCalledWith("copyright_strike_notice_record", {
      p_actor_user_id: MOD,
      p_claim_id: CLAIM,
      p_ok: false,
      p_error_class: "provider_unavailable",
    });
  });

  it("sin configuración de correo o sin destinatario: aviso fallido registrado, nunca un envío", async () => {
    for (const [mailDep, expected] of [
      [() => null, "not_configured"],
      [() => mailFake().config, "no_recipient"],
    ] as const) {
      const { rpc, client } = fakeClient({
        copyright_strike_apply: () => ({ data: applyOut(), error: null }),
        copyright_strike_notice_context: () => ({
          data: noticeContext(expected === "no_recipient" ? { authorEmail: null } : {}),
          error: null,
        }),
        copyright_strike_notice_record: () => ({ data: { id: CLAIM }, error: null }),
      });
      const out = await apply(
        { id: CLAIM, reason: REASON },
        deps(client, { mail: mailDep }),
      );
      expect(out.body).toMatchObject({
        strike: { notice: "failed", noticeError: expected },
      });
      expect(rpc).toHaveBeenCalledWith(
        "copyright_strike_notice_record",
        expect.objectContaining({ p_ok: false, p_error_class: expected }),
      );
    }
  });

  it.each([
    ["claim_not_purged", 409],
    ["author_unavailable", 409],
    ["self_strike_forbidden", 409],
    ["strike_already_issued", 409],
    ["level_changed", 409],
    ["actor_not_moderator", 403],
    ["claim_not_found", 404],
    ["reason_required", 400],
    ["invalid_argument", 400],
  ])(
    "error de negocio %s → %i, sin aviso y sin filtrar detalles",
    async (code, status) => {
      const mail = mailFake();
      const { client } = fakeClient({
        copyright_strike_apply: () => ({ data: null, error: business(code) }),
      });
      const out = await apply(
        { id: CLAIM, reason: REASON },
        deps(client, { mail: () => mail.config }),
      );
      expect(out.status).toBe(status);
      expect(out.body).toEqual({ error: "No se pudo completar la acción", code });
      expect(mail.send).not.toHaveBeenCalled();
    },
  );

  it("un error inesperado de la base de datos responde 500 genérico", async () => {
    const { client } = fakeClient({
      copyright_strike_apply: () => ({
        data: null,
        error: { code: "XX000", message: "detalle interno sensible" },
      }),
    });
    const out = await apply({ id: CLAIM, reason: REASON }, deps(client));
    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toContain("sensible");
  });

  it.each([
    ["sin id", { reason: REASON }],
    ["id no UUID", { id: "x", reason: REASON }],
    ["sin motivo", { id: CLAIM }],
    ["motivo vacío", { id: CLAIM, reason: "   " }],
    ["motivo largo", { id: CLAIM, reason: "x".repeat(1001) }],
    ["motivo con control", { id: CLAIM, reason: "a\u0000b" }],
    ["nivel inválido", { id: CLAIM, reason: REASON, expectedLevel: 4 }],
    ["nivel textual", { id: CLAIM, reason: REASON, expectedLevel: "2" }],
    ["campo extra", { id: CLAIM, reason: REASON, level: 3 }],
    ["cuerpo no objeto", [CLAIM]],
  ])("rechaza con 400 sin llamar a la base de datos: %s", async (_name, body) => {
    const { rpc, client } = fakeClient({});
    const out = await apply(body, deps(client));
    expect(out.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("solo POST y solo moderación con MFA reciente", async () => {
    const { rpc, client } = fakeClient({});
    expect((await apply({ id: CLAIM, reason: REASON }, deps(client), "GET")).status).toBe(
      405,
    );
    vi.mocked(requireCapability).mockRejectedValue(
      new AdminAuthError("forbidden", 403) as never,
    );
    const denied = await apply({ id: CLAIM, reason: REASON }, deps(client));
    expect(denied.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
    expect(vi.mocked(requireCapability)).toHaveBeenCalledWith(
      expect.anything(),
      "moderation",
    );
  });

  it("sin cliente de base de datos: 500 genérico", async () => {
    expect((await apply({ id: CLAIM, reason: REASON }, deps(null))).status).toBe(500);
  });
});

describe("copyright-strike-notice (reintento)", () => {
  const retry = (d: CopyrightRemovalDeps) =>
    call((req, res) => handleCopyrightStrikeNotice(req, res, d), { body: { id: CLAIM } });

  it("reenvía el aviso fallido y lo registra", async () => {
    const mail = mailFake();
    const { rpc, client } = fakeClient({
      copyright_strike_notice_context: () => ({ data: noticeContext(), error: null }),
      copyright_strike_notice_record: () => ({ data: { id: CLAIM }, error: null }),
    });
    const out = await retry(deps(client, { mail: () => mail.config }));
    expect(out.body).toEqual({ notice: "sent", noticeError: null });
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "copyright_strike_notice_record",
      expect.objectContaining({ p_ok: true }),
    );
  });

  it("si el aviso ya se había enviado no se repite el correo", async () => {
    const mail = mailFake();
    const { rpc, client } = fakeClient({
      copyright_strike_notice_context: () => ({
        data: null,
        error: business("invalid_transition"),
      }),
    });
    const out = await retry(deps(client, { mail: () => mail.config }));
    expect(out.body).toEqual({ notice: "sent", noticeError: null });
    expect(mail.send).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith(
      "copyright_strike_notice_record",
      expect.anything(),
    );
  });

  it("valida el cuerpo y exige moderación", async () => {
    const { client } = fakeClient({});
    const bad = await call(
      (req, res) => handleCopyrightStrikeNotice(req, res, deps(client)),
      {
        body: { id: "x" },
      },
    );
    expect(bad.status).toBe(400);
    vi.mocked(requireCapability).mockRejectedValue(new AdminAuthError("x", 401) as never);
    const denied = await retry(deps(client));
    expect(denied.status).toBe(401);
  });
});

describe("copyright-strike-state", () => {
  const read = (d: CopyrightRemovalDeps, body: unknown = { id: CLAIM }) =>
    call((req, res) => handleCopyrightStrikeState(req, res, d), { body });

  it("devuelve el estado validado: elegible con el nivel siguiente", async () => {
    const { rpc, client } = fakeClient({
      copyright_strike_state: () => ({
        data: { eligible: true, blocker: null, nextLevel: 2, strike: null, notice: null },
        error: null,
      }),
    });
    const out = await read(deps(client));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      state: { eligible: true, blocker: null, nextLevel: 2, strike: null, notice: null },
    });
    expect(rpc).toHaveBeenCalledWith("copyright_strike_state", {
      p_actor_user_id: MOD,
      p_claim_id: CLAIM,
    });
  });

  it("rechaza una respuesta incoherente (elegible con bloqueo) con 500 genérico", async () => {
    const { client } = fakeClient({
      copyright_strike_state: () => ({
        data: {
          eligible: true,
          blocker: "claim_not_purged",
          nextLevel: 1,
          strike: null,
          notice: null,
        },
        error: null,
      }),
    });
    expect((await read(deps(client))).status).toBe(500);
  });

  it("valida el cuerpo y mapea los errores de negocio", async () => {
    const { client } = fakeClient({
      copyright_strike_state: () => ({ data: null, error: business("claim_not_found") }),
    });
    expect((await read(deps(client), { id: "x" })).status).toBe(400);
    expect((await read(deps(client), { id: CLAIM, extra: 1 })).status).toBe(400);
    expect((await read(deps(client))).status).toBe(404);
  });
});
