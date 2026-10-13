// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { buildCopyrightEmail } from "./copyright-mail";
import { notifyCommunityStrike } from "./community-strike-notice";
import type { MailConfig } from "./mfa-recovery-mail";

// Aviso por correo de un strike de Community confirmado: Supabase y proveedor de correo DOBLES; no se envía nada real.

const MOD = "0f000000-0000-4000-8000-000000000001";
const STRIKE = "0f000000-0000-4000-8000-0000000000d1";
const REASON =
  "Reason written by the moderator: contenido no permitido (texto original).";

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
const context = (strike: Record<string, unknown> = {}) => ({
  strikeId: STRIKE,
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
  const send = vi.fn(async (_m: Record<string, unknown>) => result);
  return {
    send,
    config: { sender: { send }, appUrl: "https://app.example" } as unknown as MailConfig,
  };
}
const okRecord: Rpc = () => ({
  data: { strikeId: STRIKE, alreadyNotified: false },
  error: null,
});

describe("contenido del correo (inglés, mismo generador)", () => {
  const email = (strike: {
    level: 1 | 2 | 3;
    permanent: boolean;
    endsAt: string | null;
  }) =>
    buildCopyrightEmail({
      kind: "community_strike",
      reference: "",
      reason: REASON,
      windowMinutes: 0,
      strike,
    });

  it("nivel 1-2: nivel real, restricción y vencimiento UTC reales, motivo fiel y la regla de acumulación", () => {
    const { subject, text, html } = email({
      level: 2,
      permanent: false,
      endsAt: "2026-11-14T10:00:00.000Z",
    });
    expect(subject).toBe("Upmina Community - Community strike applied to your account");
    expect(text).toContain(
      "Your account has received a Community strike following a moderation decision concerning a reported post.",
    );
    expect(text).toContain("Strike level: 2 of 3.");
    expect(text).toContain(
      "While this strike is active, you cannot publish or edit posts in Community. The restriction ends on 2026-11-14 (UTC).",
    );
    expect(text).toContain(`Reason recorded by the moderator: ${REASON}`); // sin traducir ni alterar
    expect(text).toContain(
      "Strikes of every kind count together when the level of a new strike is decided.",
    );
    expect(text).toContain(
      "Nobody on the team will ever ask you for a password or an identity document.",
    );
    expect(html).toContain("<p>");
  });

  it("nivel 3: restricción permanente y sin fecha inventada", () => {
    const { text } = email({ level: 3, permanent: true, endsAt: null });
    expect(text).toContain("Strike level: 3 of 3.");
    expect(text).toContain("This restriction is permanent.");
    expect(text).not.toMatch(/ends on|\d{4}-\d{2}-\d{2}/);
  });

  it("sin enlaces, sin apelación y sin datos del denunciante ni internos de moderación", () => {
    const { text } = email({
      level: 1,
      permanent: false,
      endsAt: "2026-10-28T10:00:00.000Z",
    });
    expect(text).not.toMatch(
      /https?:|appeal|claimant|CPY-|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i,
    ); // ni enlaces ni ids internos (caso, decisión, reporte)
  });

  it("escapa el HTML del motivo", () => {
    const { html } = buildCopyrightEmail({
      kind: "community_strike",
      reference: "",
      reason: "<script>alert(1)</script>",
      windowMinutes: 0,
      strike: { level: 1, permanent: false, endsAt: "2026-10-28T10:00:00.000Z" },
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("notifyCommunityStrike", () => {
  it("envía UN correo con los datos reales del strike y registra el envío", async () => {
    const mail = mailFake();
    const { rpc, client } = fakeClient({
      community_strike_notice_context: () => ({ data: context(), error: null }),
      community_strike_notice_record: okRecord,
    });
    const out = await notifyCommunityStrike(client, () => mail.config, MOD, STRIKE);
    expect(out).toEqual({ notice: "sent" });
    expect(mail.send).toHaveBeenCalledTimes(1);
    const message = mail.send.mock.calls[0]![0] as Record<string, string>;
    expect(message.to).toBe("autor@example.com");
    expect(message.idempotencyKey).toBe(`community-strike:${STRIKE}`);
    expect(message.text).toContain("Strike level: 2 of 3.");
    expect(message.text).toContain("ends on 2026-11-14 (UTC)");
    expect(message.text).toContain(REASON);
    expect(rpc).toHaveBeenCalledWith("community_strike_notice_record", {
      p_actor_user_id: MOD,
      p_strike_id: STRIKE,
      p_ok: true,
      p_error_class: null,
    });
  });

  it("un reintento tras un aviso ya enviado o un strike revocado NO envía nada", async () => {
    const mail = mailFake();
    const { rpc, client } = fakeClient({
      community_strike_notice_context: () => ({
        data: null,
        error: { code: "P0001", message: "invalid_transition" },
      }),
    });
    const out = await notifyCommunityStrike(client, () => mail.config, MOD, STRIKE);
    expect(out).toEqual({ notice: "skipped" });
    expect(mail.send).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith(
      "community_strike_notice_record",
      expect.anything(),
    );
  });

  it("un fallo del proveedor queda registrado como fallido y reintentable, sin lanzar ni tocar el strike", async () => {
    const mail = mailFake({ ok: false, errorClass: "provider_unavailable" });
    const { rpc, client } = fakeClient({
      community_strike_notice_context: () => ({ data: context(), error: null }),
      community_strike_notice_record: okRecord,
    });
    const out = await notifyCommunityStrike(client, () => mail.config, MOD, STRIKE);
    expect(out).toEqual({ notice: "failed", noticeError: "provider_unavailable" });
    expect(rpc).toHaveBeenCalledWith("community_strike_notice_record", {
      p_actor_user_id: MOD,
      p_strike_id: STRIKE,
      p_ok: false,
      p_error_class: "provider_unavailable",
    });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual([
      "community_strike_notice_context",
      "community_strike_notice_record",
    ]); // en ningún caso vuelve a aplicar un strike
  });

  it("sin configuración de correo o sin destinatario: registrado como fallido, sin envío", async () => {
    for (const [mailDep, strike, expected] of [
      [() => null, {}, "not_configured"],
      [() => mailFake().config, { authorEmail: null }, "no_recipient"],
    ] as const) {
      const { rpc, client } = fakeClient({
        community_strike_notice_context: () => ({ data: context(strike), error: null }),
        community_strike_notice_record: okRecord,
      });
      const out = await notifyCommunityStrike(client, mailDep, MOD, STRIKE);
      expect(out).toEqual({ notice: "failed", noticeError: expected });
      expect(rpc).toHaveBeenCalledWith(
        "community_strike_notice_record",
        expect.objectContaining({ p_ok: false, p_error_class: expected }),
      );
    }
  });

  it("errores de la base de datos o respuestas incoherentes: fallo seguro, nunca una excepción", async () => {
    const mail = mailFake();
    const unexpected = fakeClient({
      community_strike_notice_context: () => ({
        data: null,
        error: { code: "XX000", message: "interno" },
      }),
    });
    expect(
      await notifyCommunityStrike(unexpected.client, () => mail.config, MOD, STRIKE),
    ).toEqual({
      notice: "failed",
      noticeError: "provider_unavailable",
    });
    const broken = fakeClient({
      community_strike_notice_context: () => ({
        data: { strikeId: STRIKE, strike: { level: 9 } },
        error: null,
      }),
    });
    expect(
      await notifyCommunityStrike(broken.client, () => mail.config, MOD, STRIKE),
    ).toEqual({
      notice: "failed",
      noticeError: "invalid_response",
    });
    const throwing = {
      rpc: vi.fn(async () => {
        throw new Error("red caída");
      }),
    } as unknown as SupabaseClient;
    expect(await notifyCommunityStrike(throwing, () => mail.config, MOD, STRIKE)).toEqual(
      {
        notice: "failed",
        noticeError: "provider_unavailable",
      },
    );
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("si el registro del resultado falla, el aviso se considera fallido (reintentable) aunque el correo saliera", async () => {
    const mail = mailFake();
    const { client } = fakeClient({
      community_strike_notice_context: () => ({ data: context(), error: null }),
      community_strike_notice_record: () => ({
        data: null,
        error: { code: "XX000", message: "x" },
      }),
    });
    const out = await notifyCommunityStrike(client, () => mail.config, MOD, STRIKE);
    expect(out).toMatchObject({ notice: "failed" });
    expect(mail.send).toHaveBeenCalledTimes(1);
  });
});
