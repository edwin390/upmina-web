import type { MailMessage, MailSender, SendResult } from "./mfa-recovery-mail.js";

/** Adaptador simulado de correo para pruebas locales: no sale a la red. Registra lo «enviado»,
 *  respeta la idempotencia por clave y permite forzar fallos. */
export function createFakeMailSender(): MailSender & {
  sent: MailMessage[];
  failWith: SendResult | null;
} {
  const byKey = new Map<string, SendResult>();
  const fake = {
    sent: [] as MailMessage[],
    failWith: null as SendResult | null,
    async send(message: MailMessage): Promise<SendResult> {
      const prior = byKey.get(message.idempotencyKey);
      if (prior) return prior; // misma clave → mismo resultado, sin duplicar
      if (fake.failWith) return fake.failWith;
      fake.sent.push(message);
      const result: SendResult = {
        ok: true,
        providerMessageId: `fake-${fake.sent.length}`,
      };
      byKey.set(message.idempotencyKey, result);
      return result;
    },
  };
  return fake;
}
