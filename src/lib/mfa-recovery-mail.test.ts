import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildRecoveryEmail,
  createResendSender,
  mapResendEvent,
  readMailConfig,
  verifyResendWebhook,
} from "./mfa-recovery-mail";
import { createFakeMailSender } from "./mfa-recovery-mail-fake";
import {
  hashChallenge,
  isChallengeToken,
  newChallengeToken,
  runRecoveryDeletion,
  sendRecoveryMail,
} from "./admin-mfa-recovery";

// MFA fase 2 — adaptador de correo, plantillas, firma del webhook, desafío y borrado exacto de la
// instantánea. Todo con dobles: NO prueba Resend ni Supabase Auth reales. Datos sintéticos.

const msg = {
  to: "ana@example.test",
  subject: "s",
  text: "t",
  html: "<p>t</p>",
  idempotencyKey: "recovery:abc:challenge:1:1",
};
const resp = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("adaptador de Resend", () => {
  it("envía con clave de idempotencia y devuelve el id del proveedor", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, { id: "msg-1" }));
    const sender = createResendSender({
      apiKey: "re_sintetica",
      from: "Upminaa <a@mail.example.test>",
      fetchImpl,
    });
    expect(await sender.send(msg)).toEqual({ ok: true, providerMessageId: "msg-1" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers["Idempotency-Key"]).toBe(msg.idempotencyKey);
    expect(init.headers.Authorization).toBe("Bearer re_sintetica");
    expect(JSON.parse(init.body)).toMatchObject({
      to: ["ana@example.test"],
      from: "Upminaa <a@mail.example.test>",
    });
  });

  it.each([
    [429, "rate_limited"],
    [500, "provider_unavailable"],
    [422, "rejected"],
    [401, "rejected"],
  ])("HTTP %i → clase %s, sin filtrar el cuerpo ni la clave", async (status, cls) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(resp(status, { message: "re_sintetica ana@example.test" }));
    const r = await createResendSender({
      apiKey: "re_sintetica",
      from: "a@b.test",
      fetchImpl,
    }).send(msg);
    expect(r).toEqual({ ok: false, errorClass: cls });
    expect(JSON.stringify(r)).not.toMatch(/re_sintetica|ana@/);
  });

  it("respuesta sin id, red caída y timeout → clases controladas", async () => {
    const mk = (fetchImpl: never, timeoutMs?: number) =>
      createResendSender({ apiKey: "k", from: "a@b.test", fetchImpl, timeoutMs });
    expect(await mk(vi.fn().mockResolvedValue(resp(200, {})) as never).send(msg)).toEqual(
      { ok: false, errorClass: "invalid_response" },
    );
    expect(
      await mk(vi.fn().mockRejectedValue(new Error("ECONNRESET")) as never).send(msg),
    ).toEqual({ ok: false, errorClass: "provider_unavailable" });
    const hang = vi.fn().mockImplementation(
      (_u: string, init: { signal: AbortSignal }) =>
        new Promise((_r, rej) => {
          init.signal.addEventListener("abort", () =>
            rej(Object.assign(new Error("abort"), { name: "AbortError" })),
          );
        }),
    );
    expect(await mk(hang as never, 10).send(msg)).toEqual({
      ok: false,
      errorClass: "timeout",
    });
  });

  it("la configuración exige las tres variables y un origen https; nunca usa el host de la petición", () => {
    const base = {
      MFA_RECOVERY_RESEND_API_KEY: "k",
      MFA_RECOVERY_MAIL_FROM: "a@b.test",
      MFA_RECOVERY_APP_URL: "https://dev.example.test/",
    } as NodeJS.ProcessEnv;
    expect(readMailConfig(base)?.appUrl).toBe("https://dev.example.test");
    expect(readMailConfig({ ...base, MFA_RECOVERY_RESEND_API_KEY: "" })).toBeNull();
    expect(readMailConfig({ ...base, MFA_RECOVERY_MAIL_FROM: undefined })).toBeNull();
    expect(
      readMailConfig({ ...base, MFA_RECOVERY_APP_URL: "http://dev.example.test" }),
    ).toBeNull();
    expect(
      readMailConfig({ ...base, MFA_RECOVERY_APP_URL: "https://x.test/ruta" }),
    ).toBeNull();
    expect(readMailConfig({})).toBeNull();
    // La clave del correo de verificación (RESEND_API_KEY) NO habilita la recuperación de MFA.
    const legacy = { ...base, RESEND_API_KEY: "otra" } as NodeJS.ProcessEnv;
    delete legacy.MFA_RECOVERY_RESEND_API_KEY;
    expect(readMailConfig(legacy)).toBeNull();
  });

  it("el doble de pruebas es idempotente por clave y permite forzar fallos", async () => {
    const fake = createFakeMailSender();
    const a = await fake.send(msg);
    const b = await fake.send(msg);
    expect(a).toEqual(b);
    expect(fake.sent).toHaveLength(1);
    fake.failWith = { ok: false, errorClass: "rejected" };
    expect(
      await fake.send({ ...msg, idempotencyKey: "recovery:abc:challenge:2:1" }),
    ).toEqual({ ok: false, errorClass: "rejected" });
  });
});

describe("plantillas", () => {
  it("el HTML usa la identidad actual (tablas, CSS en línea, sin recursos remotos) y conserva el texto plano", () => {
    const e = buildRecoveryEmail({
      kind: "challenge",
      link: "https://dev.example.test/admin/mfa/recovery#c=TOKEN",
      expiresMinutes: 15,
    });
    expect(e.html).toContain("<table");
    expect(e.html).toContain("UPMINAA");
    expect(e.html).toContain("#0b0d13");
    expect(e.html).toContain("#74b8f4");
    expect(e.html).not.toMatch(/<script|<img|<link|@import|url\(/i);
    expect(e.html).toContain("it expires in 15 minutes");
    expect(e.html).toContain("No authenticator has been removed yet.");
    expect(e.text.startsWith("Someone (hopefully you)")).toBe(true);
    expect(e.text).not.toContain("<");
  });
  it("el desafío incluye el enlace con fragmento y NO promete que ya se eliminó nada", () => {
    const e = buildRecoveryEmail({
      kind: "challenge",
      link: "https://dev.example.test/admin/mfa/recovery#c=TOKEN",
      expiresMinutes: 15,
    });
    expect(e.text).toContain("#c=TOKEN");
    expect(e.text).toMatch(/No authenticator has been removed yet/);
    expect(e.html).toContain(
      'href="https://dev.example.test/admin/mfa/recovery#c=TOKEN"',
    );
  });
  it("los demás avisos no llevan enlaces ni secretos y escapan HTML", () => {
    for (const spec of [
      { kind: "closed", reason: "denied" },
      { kind: "closed", reason: "cancelled" },
      { kind: "closed", reason: "expired" },
      { kind: "completed" },
    ] as const) {
      const e = buildRecoveryEmail(spec);
      expect(e.text).not.toMatch(/https?:\/\//);
      expect(e.subject.length).toBeGreaterThan(5);
    }
    const x = buildRecoveryEmail({
      kind: "challenge",
      link: 'https://x.test/#c=<script>"',
      expiresMinutes: 1,
    });
    expect(x.html).not.toContain("<script>");
  });
  it("TODOS los correos de la recuperación están en inglés: solo ASCII y sin palabras en español", () => {
    const specs = [
      {
        kind: "challenge",
        link: "https://x.test/admin/mfa/recovery#c=T",
        expiresMinutes: 15,
      },
      {
        kind: "approved",
        waitMinutes: 15,
        cancelLink: "https://x.test/admin/mfa/recovery/cancel#t=T",
      },
      { kind: "closed", reason: "denied" },
      { kind: "closed", reason: "cancelled" },
      { kind: "closed", reason: "expired" },
      { kind: "completed" },
      {
        kind: "reminder",
        waitMinutes: 15,
        recoveryPageUrl: "https://x.test/admin/mfa/recovery",
      },
    ] as const;
    for (const spec of specs) {
      const e = buildRecoveryEmail(spec);
      for (const part of [e.subject, e.text, e.html]) {
        expect(part).toMatch(/^[\x20-\x7e\n]+$/); // sin acentos, ¿, ¡ ni otros caracteres no ASCII
        expect(part).not.toMatch(
          /\b(tu|tus|solicitud|autenticador|correo|cancela|enlace|administrador)\b/i,
        );
      }
      expect(e.subject.startsWith("Upminaa Web:")).toBe(true);
    }
  });

  it("«recordatorio»: explica la espera y cómo cancelar desde la cuenta, SIN enlace de cancelación ni datos de la cuenta", () => {
    const page = "https://dev.example.test/admin/mfa/recovery";
    const e = buildRecoveryEmail({
      kind: "reminder",
      waitMinutes: 15,
      recoveryPageUrl: page,
    });
    expect(e.subject).toBe("Upminaa Web: reminder about your authenticator reset");
    expect(e.text).toMatch(
      /reminder that your authenticator reset request .* was approved/,
    );
    expect(e.text).toMatch(/15 minutes after the approval notice was delivered/);
    expect(e.text).toMatch(
      /sign in to Upminaa Web, open the authenticator recovery page/,
    );
    expect(e.text).toMatch(/does not contain a cancellation link/);
    expect(e.text).toContain(page);
    // el único enlace es la página de recuperación de la propia cuenta: ningún token ni enlace de cancelación
    expect([...e.text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0])).toEqual([page]);
    expect(e.text).not.toMatch(/#t=|#c=|\/cancel|@/);
    expect(e.html).toContain(`href="${page}"`);
  });

  it("«aprobado» explica la espera, incluye el enlace de cancelación y no afirma lectura ni entrega", () => {
    const link = "https://dev.example.test/admin/mfa/recovery/cancel#t=TOKEN";
    const e = buildRecoveryEmail({ kind: "approved", waitMinutes: 15, cancelLink: link });
    expect(e.text).toMatch(/15 minutes/);
    expect(e.text).toContain(link);
    expect(e.text).toMatch(/only cancels and can be used once/);
    expect(e.html).toContain(`href="${link}"`);
    expect(e.text).not.toMatch(/\bread\b|\bopened\b/i);
    // el enlace de cancelación no contiene el desafío de verificación ni datos de la cuenta
    expect(e.text).not.toMatch(/#c=|@/);
  });

  it("aprobación EXCEPCIONAL: indica en inglés que la autorizó un Developer; el resto (espera, enlace) es idéntico", () => {
    const link = "https://dev.example.test/admin/mfa/recovery/cancel#t=TOKEN";
    const normal = buildRecoveryEmail({
      kind: "approved",
      waitMinutes: 15,
      cancelLink: link,
    });
    const exceptional = buildRecoveryEmail({
      kind: "approved",
      waitMinutes: 15,
      cancelLink: link,
      exceptional: true,
    });
    expect(exceptional.text).toMatch(/authorized by a platform Developer/);
    expect(exceptional.text).toMatch(/no other administrator was available/);
    expect(normal.text).not.toMatch(/Developer/);
    expect(exceptional.subject).toBe(normal.subject);
    expect(exceptional.text).toContain(link);
    expect(exceptional.text).toMatch(/15 minutes/);
    expect(exceptional.text).toMatch(/only cancels and can be used once/);
    expect(exceptional.html).toContain(`href="${link}"`);
    for (const part of [exceptional.subject, exceptional.text, exceptional.html]) {
      expect(part).toMatch(/^[\x20-\x7e\n]+$/); // solo ASCII
    }
    // sin la marca el texto sigue siendo el de siempre
    expect(
      buildRecoveryEmail({
        kind: "approved",
        waitMinutes: 15,
        cancelLink: link,
        exceptional: false,
      }).text,
    ).toBe(normal.text);
  });
});

describe("firma del webhook (estilo Svix)", () => {
  const secret = "whsec_" + Buffer.from("secreto-sintetico").toString("base64");
  const NOW = 1_800_000_000;
  const sig = (body: string, id = "msg_1", ts = NOW) =>
    "v1," +
    createHmac("sha256", Buffer.from("secreto-sintetico"))
      .update(`${id}.${ts}.${body}`)
      .digest("base64");
  const verify = (over: Partial<Parameters<typeof verifyResendWebhook>[0]> = {}) =>
    verifyResendWebhook({
      secret,
      id: "msg_1",
      timestamp: String(NOW),
      signature: sig("{}"),
      body: "{}",
      nowSeconds: NOW,
      ...over,
    });

  it("acepta la firma correcta (incluida una lista con una firma antigua)", () => {
    expect(verify()).toBe(true);
    expect(verify({ signature: `v1,AAAA ${sig("{}")}` })).toBe(true);
  });
  it("rechaza cuerpo alterado, otro id, otro secreto, caducada, futura, ausente o con otra versión", () => {
    expect(verify({ body: "{ }" })).toBe(false);
    expect(verify({ id: "msg_2" })).toBe(false);
    expect(verify({ secret: "whsec_" + Buffer.from("otro").toString("base64") })).toBe(
      false,
    );
    expect(verify({ nowSeconds: NOW + 301 })).toBe(false);
    expect(verify({ nowSeconds: NOW - 301 })).toBe(false);
    expect(verify({ signature: undefined })).toBe(false);
    expect(verify({ id: undefined })).toBe(false);
    expect(verify({ timestamp: "no-es-numero" })).toBe(false);
    expect(verify({ signature: sig("{}").replace("v1,", "v2,") })).toBe(false);
    expect(verify({ secret: "" })).toBe(false);
  });
  it("solo entrega y fallos cambian estado; abrir, clic y enviado no", () => {
    expect(mapResendEvent("email.delivered")).toBe("delivered");
    expect(mapResendEvent("email.bounced")).toBe("bounced");
    expect(mapResendEvent("email.failed")).toBe("failed");
    expect(mapResendEvent("email.suppressed")).toBe("suppressed");
    for (const t of [
      "email.opened",
      "email.clicked",
      "email.sent",
      "email.delivery_delayed",
      undefined,
      5,
    ]) {
      expect(mapResendEvent(t)).toBeNull();
    }
  });
});

describe("desafío", () => {
  it("256 bits aleatorios en base64url y solo se persiste su SHA-256", () => {
    const a = newChallengeToken();
    const b = newChallengeToken();
    expect(a).not.toBe(b);
    expect(isChallengeToken(a)).toBe(true);
    expect(hashChallenge(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashChallenge(a)).not.toContain(a);
    expect(isChallengeToken("x".repeat(42))).toBe(false);
    expect(isChallengeToken(`${a}!`)).toBe(false);
    expect(isChallengeToken(123)).toBe(false);
  });
});

describe("sendRecoveryMail", () => {
  const rpcWith = (
    start: unknown,
    result = vi.fn().mockResolvedValue({ error: null }),
  ) => {
    const calls: string[] = [];
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      if (name === "admin_mfa_recovery_mail_start") return start as never;
      return result(name, args) as never;
    });
    return { client: { rpc } as never, calls, result };
  };
  const args = {
    recoveryId: "r",
    kind: "approved" as const,
    baseKey: "recovery:r:approved",
    to: "a@b.test",
    spec: {
      kind: "approved" as const,
      waitMinutes: 15,
      cancelLink: "https://x.test/c#t=T",
    },
  };

  it("ya enviado → no vuelve a enviar", async () => {
    const fake = createFakeMailSender();
    const { client } = rpcWith({
      data: { shouldSend: false, state: "accepted" },
      error: null,
    });
    expect(await sendRecoveryMail(client, fake, args)).toEqual({
      status: "already_sent",
    });
    expect(fake.sent).toHaveLength(0);
  });
  it("si no se puede registrar el intento NO se envía nada", async () => {
    const fake = createFakeMailSender();
    const { client } = rpcWith({ data: null, error: { code: "XX000" } });
    expect(await sendRecoveryMail(client, fake, args)).toEqual({
      status: "failed",
      errorClass: "mail_log_unavailable",
    });
    expect(fake.sent).toHaveLength(0);
  });
  it("envía con la clave del proveedor y registra aceptado; un fallo se registra como fallo y nunca lanza", async () => {
    const fake = createFakeMailSender();
    const { client, result } = rpcWith({
      data: { shouldSend: true, providerKey: "recovery:r:approved:1" },
      error: null,
    });
    expect(await sendRecoveryMail(client, fake, args)).toEqual({ status: "accepted" });
    expect(fake.sent[0].idempotencyKey).toBe("recovery:r:approved:1");
    expect(result).toHaveBeenCalledWith(
      "admin_mfa_recovery_mail_result",
      expect.objectContaining({ p_accepted: true, p_provider_message_id: "fake-1" }),
    );
    fake.failWith = { ok: false, errorClass: "rate_limited" };
    const second = rpcWith({
      data: { shouldSend: true, providerKey: "recovery:r:approved:2" },
      error: null,
    });
    expect(await sendRecoveryMail(second.client, fake, args)).toEqual({
      status: "failed",
      errorClass: "rate_limited",
    });
    const boom = { rpc: vi.fn().mockRejectedValue(new Error("red")) } as never;
    expect(await sendRecoveryMail(boom, fake, args)).toEqual({
      status: "failed",
      errorClass: "mail_unavailable",
    });
  });
});

describe("runRecoveryDeletion", () => {
  const F1 = "fffffff1-ffff-4fff-8fff-fffffffffff1";
  const F2 = "fffffff2-ffff-4fff-8fff-fffffffffff2";
  const NEW = "fffffff3-ffff-4fff-8fff-fffffffffff3";
  const USER = "33333333-3333-4333-8333-333333333333";
  function client(
    opts: {
      deleteErr?: (id: string) => unknown;
      listed?: { id: string }[];
      listErr?: unknown;
      recordErr?: unknown;
      allowed?: (call: number) => boolean;
    } = {},
  ) {
    let checks = 0;
    const deleted: string[] = [];
    const records: Record<string, unknown>[] = [];
    return {
      deleted,
      records,
      c: {
        auth: {
          admin: {
            mfa: {
              deleteFactor: async ({ id }: { id: string }) => {
                deleted.push(id);
                return { error: opts.deleteErr?.(id) ?? null };
              },
              listFactors: async () =>
                opts.listErr
                  ? { data: null, error: opts.listErr }
                  : { data: { factors: opts.listed ?? [] }, error: null },
            },
          },
        },
        rpc: async (n: string, a: Record<string, unknown>) => {
          if (n === "admin_mfa_recovery_execution_allowed") {
            checks += 1;
            return { data: opts.allowed ? opts.allowed(checks) : true, error: null };
          }
          records.push(a);
          return { data: "x", error: opts.recordErr ?? null };
        },
      } as never,
    };
  }
  const run = (c: never) =>
    runRecoveryDeletion(c, USER, { recoveryId: "rid", factorIds: [F1, F2] });

  it("borra solo la instantánea y registra; un factor NUEVO que sigue listado no se toca ni bloquea", async () => {
    const { c, deleted, records } = client({ listed: [{ id: NEW }] });
    expect(await run(c)).toEqual({ status: "factors_deleted", factorsDeleted: 2 });
    expect(deleted).toEqual([F1, F2]);
    expect(deleted).not.toContain(NEW);
    expect(records.at(-1)).toMatchObject({ p_ok: true, p_factors_deleted: 2 });
  });
  it("404 cuenta como resuelto (idempotente)", async () => {
    const { c } = client({ deleteErr: () => ({ status: 404 }) });
    expect(await run(c)).toEqual({ status: "factors_deleted", factorsDeleted: 0 });
  });
  it.each([
    [
      "borrado",
      { deleteErr: (id: string) => (id === F2 ? { status: 500 } : null) },
      "auth_delete_failed",
    ],
    ["listado", { listErr: { status: 500 } }, "auth_list_failed"],
    ["factor presente", { listed: [{ id: F1 }] }, "factor_still_present"],
  ])("fallo de %s → clase %s registrada", async (_n, opts, cls) => {
    const { c, records } = client(opts);
    expect(await run(c)).toEqual({ status: "failed", errorClass: cls });
    expect(records.at(-1)).toMatchObject({ p_ok: false, p_error_class: cls });
  });
  it("una cancelación a mitad de la ejecución detiene los borrados restantes y no registra éxito", async () => {
    const { c, deleted, records } = client({ allowed: (n) => n < 2 }); // permitido antes del 1.º, cancelado antes del 2.º
    expect(await run(c)).toEqual({ status: "failed", errorClass: "recovery_closed" });
    expect(deleted).toEqual([F1]);
    expect(records).toHaveLength(0);
  });
  it("cancelada antes de empezar: no se borra nada", async () => {
    const { c, deleted } = client({ allowed: () => false });
    expect(await run(c)).toEqual({ status: "failed", errorClass: "recovery_closed" });
    expect(deleted).toEqual([]);
  });
  it("si no se puede comprobar el estado antes de borrar, no se borra (falla cerrado) y queda registrado", async () => {
    const deleted: string[] = [];
    const records: Record<string, unknown>[] = [];
    const c = {
      auth: {
        admin: {
          mfa: {
            deleteFactor: async ({ id }: { id: string }) => {
              deleted.push(id);
              return { error: null };
            },
            listFactors: async () => ({ data: { factors: [] }, error: null }),
          },
        },
      },
      rpc: async (n: string, a: Record<string, unknown>) =>
        n === "admin_mfa_recovery_execution_allowed"
          ? { data: null, error: { code: "XX000" } }
          : (records.push(a), { data: "x", error: null }),
    } as never;
    expect(await run(c)).toEqual({ status: "failed", errorClass: "state_check_failed" });
    expect(deleted).toEqual([]);
    expect(records.at(-1)).toMatchObject({
      p_ok: false,
      p_error_class: "state_check_failed",
    });
  });
  it("si no se puede registrar el éxito, queda como fallo recuperable", async () => {
    const { c } = client({ recordErr: { code: "XX000" } });
    expect(await run(c)).toEqual({ status: "failed", errorClass: "record_failed" });
  });
});
