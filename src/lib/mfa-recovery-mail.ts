import { renderBrandedEmailHtml, type EmailBlock } from "./mail-html.js";
import { createHmac, timingSafeEqual } from "node:crypto";

// MFA fase 2 — envío de correos transaccionales (SOLO servidor).
//
// Interfaz mínima `MailSender` con dos implementaciones: el adaptador de Resend (uso real, aún sin
// configurar) y un doble de pruebas (mfa-recovery-mail-fake.ts). Reglas:
//   * Credenciales solo desde variables de entorno del servidor: MFA_RECOVERY_RESEND_API_KEY,
//     MFA_RECOVERY_MAIL_FROM, MFA_RECOVERY_APP_URL (origen https para el enlace del desafío; NUNCA se
//     deriva de la cabecera Host de la petición) y RESEND_WEBHOOK_SECRET. Nada llega al navegador.
//   * Un envío ACEPTADO por el proveedor no es una ENTREGA: el estado «delivered» solo lo establece un
//     evento firmado del proveedor (verifyResendWebhook). «Entregado» tampoco significa «leído».
//   * Clave de idempotencia por evento (cabecera Idempotency-Key): reintentar el mismo evento no
//     duplica el correo.
//   * Los errores del proveedor se reducen a una CLASE; el cuerpo de la respuesta, la dirección y la
//     clave nunca se registran ni se devuelven.

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

export type MailErrorClass =
  | "not_configured"
  | "rejected"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "invalid_response";

/** ok=true → providerMessageId; ok=false → errorClass. (Interfaz plana: la unión discriminada no se
 *  estrecha con la configuración de TypeScript del proyecto.) */
export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  errorClass?: MailErrorClass;
}

export interface MailSender {
  send(message: MailMessage): Promise<SendResult>;
}

type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_TIMEOUT_MS = 8000;

export function createResendSender(options: {
  apiKey: string;
  from: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): MailSender {
  const { apiKey, from } = options;
  const doFetch: FetchLike = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async send(message) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": message.idempotencyKey,
          },
          body: JSON.stringify({
            from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            html: message.html,
          }),
          signal: controller.signal,
        });
        if (response.status === 429) return { ok: false, errorClass: "rate_limited" };
        if (response.status >= 500)
          return { ok: false, errorClass: "provider_unavailable" };
        if (!response.ok) return { ok: false, errorClass: "rejected" };
        const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
        if (
          !body ||
          typeof body.id !== "string" ||
          body.id.length === 0 ||
          body.id.length > 120
        ) {
          return { ok: false, errorClass: "invalid_response" };
        }
        return { ok: true, providerMessageId: body.id };
      } catch (err) {
        const aborted = (err as { name?: unknown } | null)?.name === "AbortError";
        return { ok: false, errorClass: aborted ? "timeout" : "provider_unavailable" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface MailConfig {
  sender: MailSender;
  /** Origen https sin barra final para construir enlaces (jamás derivado de la petición). */
  appUrl: string;
}

/** Configuración real desde el entorno del servidor, o null si falta algo (fail closed: la
 *  recuperación responde 503 sin crear ninguna solicitud). */
export function readMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig | null {
  const apiKey = env.MFA_RECOVERY_RESEND_API_KEY?.trim();
  const from = env.MFA_RECOVERY_MAIL_FROM?.trim();
  const appUrl = env.MFA_RECOVERY_APP_URL?.trim().replace(/\/+$/, "");
  if (!apiKey || !from || !appUrl) return null;
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(appUrl)) return null;
  return { sender: createResendSender({ apiKey, from }), appUrl };
}

// ---------------------------------------------------------------------------------------------
// Plantillas (texto plano y HTML mínimo). Sin datos sensibles salvo el enlace del desafío.
// ---------------------------------------------------------------------------------------------
export type RecoveryMailKind =
  | { kind: "challenge"; link: string; expiresMinutes: number }
  | { kind: "approved"; waitMinutes: number; cancelLink: string; exceptional?: boolean }
  | { kind: "closed"; reason: "denied" | "cancelled" | "expired" }
  | { kind: "completed" }
  // Recordatorio del aviso de aprobación ya entregado: NO lleva enlace de cancelación (el original sigue vigente).
  | { kind: "reminder"; waitMinutes: number; recoveryPageUrl: string };

const CLOSED_TEXT: Record<"denied" | "cancelled" | "expired", string> = {
  denied: "An administrator rejected the request.",
  cancelled: "The request was cancelled.",
  expired: "The request expired.",
};

/** Todos los correos del flujo de recuperación de MFA están en INGLÉS (solo ASCII). */
export function buildRecoveryEmail(spec: RecoveryMailKind): {
  subject: string;
  text: string;
  html: string;
} {
  const footer =
    "If this was not you, cancel the request by signing in to the dashboard and tell an administrator. Nobody on the team will ever ask you for this code.";
  let subject: string;
  let lines: string[];
  switch (spec.kind) {
    case "challenge":
      subject = "Upminaa Web: verify your authenticator reset request";
      lines = [
        "Someone (hopefully you) asked to reset the authenticator on your Upminaa Web team account.",
        `Open this link while signed in to verify your email (it expires in ${spec.expiresMinutes} minutes and works only once):`,
        spec.link,
        "After that, an administrator still has to approve the request. No authenticator has been removed yet.",
        footer,
      ];
      break;
    case "approved":
      subject = "Upminaa Web: your authenticator reset was approved";
      lines = [
        spec.exceptional
          ? `This request was authorized by a platform Developer because no other administrator was available to approve it. You will be able to carry it out ${spec.waitMinutes} minutes after this notice; at that point your current authenticator will be invalidated.`
          : `An administrator approved your request. You will be able to carry it out ${spec.waitMinutes} minutes after this notice; at that point your current authenticator will be invalidated.`,
        "Until then your authenticator keeps working.",
        "If this was NOT you, cancel the reset now with this link (no sign-in required; the link only cancels and can be used once):",
        spec.cancelLink,
        footer,
      ];
      break;
    case "reminder":
      subject = "Upminaa Web: reminder about your authenticator reset";
      lines = [
        "This is a reminder that your authenticator reset request on Upminaa Web was approved.",
        `You will be able to carry it out ${spec.waitMinutes} minutes after the approval notice was delivered; at that point your current authenticator will be invalidated.`,
        "Until then your authenticator keeps working.",
        "If this was NOT you, cancel the request now: sign in to Upminaa Web, open the authenticator recovery page below and choose Cancel. You can also use the cancellation link in the original approval email. This reminder does not contain a cancellation link.",
        spec.recoveryPageUrl,
        footer,
      ];
      break;
    case "closed":
      subject = "Upminaa Web: authenticator reset request closed";
      lines = [
        CLOSED_TEXT[spec.reason],
        "Your current authenticator was not changed. If you need help, contact an administrator.",
      ];
      break;
    case "completed":
      subject = "Upminaa Web: authenticator reset completed";
      lines = [
        "Your authenticator was reset and a new one is now verified on your account.",
        "If this was not you, contact an administrator right away.",
      ];
      break;
  }
  const text = lines.join("\n\n");
  const html = renderBrandedEmailHtml(
    subject,
    lines.map((l): EmailBlock =>
      /^https:\/\//.test(l)
        ? { type: "link", href: l, label: "Open link" }
        : { type: "text", text: l },
    ),
    "Automatic security notice from Upminaa Web. Please do not reply to this message.",
  );
  return { subject, text, html };
}

// ---------------------------------------------------------------------------------------------
// Webhook de Resend (firmas estilo Svix: id, timestamp, firma «v1,<base64>»)
// ---------------------------------------------------------------------------------------------
const WEBHOOK_TOLERANCE_SECONDS = 300;

export function verifyResendWebhook(params: {
  secret: string;
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  body: string;
  nowSeconds?: number;
}): boolean {
  const { secret, id, timestamp, signature, body } = params;
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > WEBHOOK_TOLERANCE_SECONDS)
    return false;
  const keyText = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(keyText, "base64");
  } catch {
    return false;
  }
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest();
  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) continue;
    const given = Buffer.from(value, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

/** Evento de proveedor → evento interno. Solo entrega y fallos cambian el estado; abrir o hacer
 *  clic jamás se interpreta como lectura ni como entrega. */
export function mapResendEvent(
  type: unknown,
): "delivered" | "bounced" | "failed" | "suppressed" | null {
  switch (type) {
    case "email.delivered":
      return "delivered";
    case "email.bounced":
      return "bounced";
    case "email.failed":
      return "failed";
    case "email.suppressed":
      return "suppressed";
    default:
      return null;
  }
}
