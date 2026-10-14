import {
  readMailConfig,
  type MailConfig,
  type MailErrorClass,
} from "./mfa-recovery-mail.js";

// DEL-2: correo (en inglés) con el enlace de confirmación de la eliminación de la cuenta. Reutiliza el remitente transaccional
// existente (Resend). El enlace lleva el token en el FRAGMENTO (#t=...): el navegador nunca lo envía al servidor en el GET ni lo
// filtra por Referer; la pantalla de DEL-3 lo lee de location.hash. Sin datos de moderación, Copyright ni del perfil.

/** Origen del enlace: ACCOUNT_DELETION_APP_URL (https, sin ruta) si existe, si no el de la configuración base. Inválido ⇒ no se envía. */
export function readAccountDeletionMailConfig(
  env: NodeJS.ProcessEnv = process.env,
): MailConfig | null {
  const base = readMailConfig(env);
  const own = env.ACCOUNT_DELETION_APP_URL?.trim().replace(/\/+$/, "");
  if (!base || own === undefined || own === "") return base;
  return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(own) ? { ...base, appUrl: own } : null;
}

export function buildAccountDeletionLink(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}/account/delete#t=${token}`;
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function buildAccountDeletionEmail(input: {
  link: string;
  expiresInMinutes: number;
}): {
  subject: string;
  text: string;
  html: string;
} {
  const paragraphs = [
    "We received a request to permanently delete your Upmina Community account.",
    "Nothing has been deleted yet. Opening the link below only shows a confirmation page: your account is deleted only if you sign in and confirm there.",
    "Deleting your account is irreversible. As soon as you confirm, you lose access immediately: your sessions are closed, you cannot sign in again, and the account cannot be restored or reactivated. Your profile, username, posts and likes are removed. Limited records needed for moderation and legal purposes are kept under restricted access.",
    `The link works once and expires in ${input.expiresInMinutes} minutes.`,
  ];
  const closing =
    "If you did not request this, ignore this email: your account stays as it is. Nobody on the team will ever ask you for your password.";
  const subject = "Upmina Community - Confirm the deletion of your account";
  const text = [...paragraphs, `Confirmation link: ${input.link}`, closing].join("\n\n");
  const html = [
    ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    `<p><a href="${escapeHtml(input.link)}">Review and confirm the deletion</a></p>`,
    `<p>${escapeHtml(closing)}</p>`,
  ].join("\n");
  return { subject, text, html };
}

export type AccountDeletionSendOutcome =
  { ok: true } | { ok: false; errorClass: MailErrorClass | "no_recipient" };

/** Nunca lanza: devuelve ok o una clase de error segura (jamás la dirección, la clave ni el cuerpo del proveedor). */
export async function sendAccountDeletionEmail(
  config: MailConfig | null,
  params: {
    to: string | null;
    token: string;
    expiresInMinutes: number;
    idempotencyKey: string;
  },
): Promise<AccountDeletionSendOutcome> {
  if (!params.to) return { ok: false, errorClass: "no_recipient" };
  if (!config) return { ok: false, errorClass: "not_configured" };
  try {
    const { subject, text, html } = buildAccountDeletionEmail({
      link: buildAccountDeletionLink(config.appUrl, params.token),
      expiresInMinutes: params.expiresInMinutes,
    });
    const result = await config.sender.send({
      to: params.to,
      subject,
      text,
      html,
      idempotencyKey: params.idempotencyKey,
    });
    return result.ok
      ? { ok: true }
      : { ok: false, errorClass: result.errorClass ?? "provider_unavailable" };
  } catch {
    return { ok: false, errorClass: "provider_unavailable" };
  }
}
