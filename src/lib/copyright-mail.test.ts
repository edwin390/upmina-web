// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  buildAppealLink,
  buildCopyrightEmail,
  describeWindow,
  sendCopyrightNotice,
} from "./copyright-mail";
import type { MailConfig } from "./mfa-recovery-mail";

// COPY-1 fase 2B: avisos al autor. Plantillas en INGLÉS (ASCII fuera del texto de la moderación), sin datos del reclamante.

const REASON = "Reproduces the identified artwork";
const base = { reference: "CPY-2026-000001", reason: REASON, windowMinutes: 60 };
// eslint-disable-next-line no-control-regex
const ASCII = /^[\x09\x0a\x20-\x7e]*$/;

describe("plantillas", () => {
  it("el aviso inicial está en inglés, lleva referencia, motivo, plazo y enlace personal, y promete que nada se borra solo", () => {
    const link = buildAppealLink("https://app.example/", "T".repeat(43));
    const mail = buildCopyrightEmail({ kind: "removal", ...base, appealLink: link });
    expect(link).toBe(`https://app.example/copyright/appeal#t=${"T".repeat(43)}`);
    expect(mail.subject).toMatch(
      /^Upminaa Web: your post was hidden after a copyright claim \(CPY-2026-000001\)$/,
    );
    for (const part of [
      base.reference,
      REASON,
      "within 1 hour",
      link,
      "Nothing is deleted automatically",
    ])
      expect(mail.text).toContain(part);
    expect(mail.text).toContain("do not need to upload files or identity documents");
    expect(ASCII.test(mail.subject)).toBe(true);
    expect(ASCII.test(mail.text)).toBe(true);
    expect(mail.html).toContain(`<a href="${link}" `);
  });

  it("el token va en el fragmento (#t=), nunca en la ruta ni en la consulta", () => {
    const link = buildAppealLink("https://app.example", "abc");
    expect(new URL(link).search).toBe("");
    expect(new URL(link).hash).toBe("#t=abc");
    expect(new URL(link).pathname).toBe("/copyright/appeal");
  });

  it("los avisos de resolución están en inglés, incluyen la justificación y no llevan enlace de apelación", () => {
    const accepted = buildCopyrightEmail({
      kind: "appeal_accepted",
      ...base,
      resolutionNote: "Verified ownership",
    });
    expect(accepted.subject).toBe(
      "Upminaa Web: your appeal was accepted (CPY-2026-000001)",
    );
    expect(accepted.text).toMatch(/has been restored/);
    expect(accepted.text).toContain("Moderator note: Verified ownership");
    const rejected = buildCopyrightEmail({
      kind: "appeal_rejected",
      ...base,
      resolutionNote: "Not enough evidence",
    });
    expect(rejected.subject).toBe(
      "Upminaa Web: your appeal was rejected (CPY-2026-000001)",
    );
    expect(rejected.text).toMatch(/keep the post hidden/);
    expect(rejected.text).toContain("not done automatically");
    for (const mail of [accepted, rejected]) {
      expect(mail.text).not.toContain("/copyright/appeal");
      expect(ASCII.test(mail.text)).toBe(true);
    }
  });

  it("nunca incluye datos del reclamante y escapa el HTML de lo escrito por la moderación", () => {
    const mail = buildCopyrightEmail({
      kind: "removal",
      ...base,
      reason: '<script>alert("x")</script>',
      appealLink: "https://app.example/copyright/appeal#t=x",
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.text).not.toMatch(/claimant|signature|@/i);
  });

  it("describe el plazo", () => {
    expect(describeWindow(60)).toBe("1 hour");
    expect(describeWindow(1440)).toBe("24 hours");
    expect(describeWindow(90)).toBe("90 minutes");
  });
});

describe("envío", () => {
  const input = {
    kind: "removal" as const,
    ...base,
    appealLink: "https://app.example/copyright/appeal#t=x",
  };
  const config = (result: { ok: boolean; errorClass?: string }) => {
    const send = vi.fn(async () => result);
    return {
      send,
      config: {
        sender: { send },
        appUrl: "https://app.example",
      } as unknown as MailConfig,
    };
  };

  it("envía una sola vez con la clave de idempotencia y devuelve ok", async () => {
    const mail = config({ ok: true });
    expect(
      await sendCopyrightNotice(mail.config, {
        to: "a@example.com",
        idempotencyKey: "k1",
        input,
      }),
    ).toEqual({ ok: true });
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(
      (mail.send.mock.calls[0] as unknown as [Record<string, unknown>])[0],
    ).toMatchObject({
      to: "a@example.com",
      idempotencyKey: "k1",
    });
  });

  it("sin destinatario o sin configuración no envía y devuelve una clase segura", async () => {
    const mail = config({ ok: true });
    expect(
      await sendCopyrightNotice(mail.config, { to: null, idempotencyKey: "k", input }),
    ).toEqual({
      ok: false,
      errorClass: "no_recipient",
    });
    expect(
      await sendCopyrightNotice(null, {
        to: "a@example.com",
        idempotencyKey: "k",
        input,
      }),
    ).toEqual({
      ok: false,
      errorClass: "not_configured",
    });
    expect(mail.send).not.toHaveBeenCalled();
  });

  it.each([
    "rejected",
    "rate_limited",
    "provider_unavailable",
    "timeout",
    "invalid_response",
  ])("un fallo del proveedor (%s) se reduce a su clase", async (errorClass) => {
    const mail = config({ ok: false, errorClass });
    expect(
      await sendCopyrightNotice(mail.config, {
        to: "a@example.com",
        idempotencyKey: "k",
        input,
      }),
    ).toEqual({ ok: false, errorClass });
  });

  it("una excepción del adaptador nunca se propaga", async () => {
    const send = vi.fn(async () => {
      throw new Error("secret-provider-detail");
    });
    const config = {
      sender: { send },
      appUrl: "https://app.example",
    } as unknown as MailConfig;
    const result = await sendCopyrightNotice(config, {
      to: "a@example.com",
      idempotencyKey: "k",
      input,
    });
    expect(result).toEqual({ ok: false, errorClass: "provider_unavailable" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
