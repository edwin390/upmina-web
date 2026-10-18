import { renderBrandedEmailHtml, type EmailBlock } from "./mail-html.js";
import type { MailConfig, MailErrorClass } from "./mfa-recovery-mail.js";
import type {
  CopyrightNoticeErrorClass,
  CopyrightNoticeKind,
} from "./copyright-contract.js";

// COPY-1 fase 2B — avisos por correo al AUTOR de una publicación retirada por copyright (SOLO servidor).
// Reutiliza el adaptador de Resend existente (MailSender/readMailConfig de mfa-recovery-mail.ts): no se crea otro canal.
//   * Todo el texto fijo está en INGLÉS y es ASCII. Solo el motivo y la justificación que escribió la moderación se copian tal cual
//     (y se escapan en HTML). Nunca se incluyen datos del reclamante ni su correo.
//   * El enlace de apelación lleva el token en el FRAGMENTO (#t=…): el navegador no lo envía al servidor ni lo deja en Referer.
//   * Sin IA y sin lenguaje legal improvisado: el texto de la plantilla está pendiente de revisión jurídica.
//   * Un fallo del proveedor se reduce a una CLASE; el cuerpo de la respuesta, la dirección y la clave nunca se registran.

export interface CopyrightMailInput {
  /** «community_strike»: aviso de un strike originado por un reporte de Community (mismo generador y mismo formato que el de Copyright). */
  kind: CopyrightNoticeKind | "community_strike";
  reference: string;
  /** Motivo de la retirada que escribió la moderación. */
  reason: string;
  windowMinutes: number;
  /** Enlace personal de apelación (solo en el aviso inicial). */
  appealLink?: string;
  /** Justificación de la moderación al resolver la apelación. */
  resolutionNote?: string | null;
  /** Solo en el aviso de strike: nivel y duración de la sanción que ya calculó la BD. En ese aviso `reason` es el motivo del strike. */
  strike?: { level: 1 | 2 | 3; permanent: boolean; endsAt: string | null };
}

/** «1 hour», «24 hours», «90 minutes». */
export function describeWindow(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return `${minutes} minutes`;
}

export function buildCopyrightEmail(input: CopyrightMailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const ref = input.reference;
  const footer =
    "This message was sent because your account published the post. Nobody on the team will ever ask you for a password or an identity document.";
  let subject: string;
  let lines: string[];
  switch (input.kind) {
    case "removal":
      subject = `Upminaa Web: your post was hidden after a copyright claim (${ref})`;
      lines = [
        `A moderator reviewed copyright claim ${ref} and hid one of your posts on Upminaa Web. The post has not been deleted and its files are intact for now.`,
        `Reason recorded by the moderator: ${input.reason}`,
        `If you believe this is a mistake, you can appeal within ${describeWindow(input.windowMinutes)} of receiving this message. Sign in with the account that published the post, then open this personal link (do not share it):`,
        input.appealLink ?? "",
        "The appeal form asks for contact details, your reasons and evidence as text or links. You do not need to upload files or identity documents.",
        "A moderator decides every appeal. Nothing is deleted automatically when the time runs out; after that time a moderator may decide to delete the post permanently, unless an appeal is pending.",
        footer,
      ];
      break;
    case "appeal_accepted":
      subject = `Upminaa Web: your appeal was accepted (${ref})`;
      lines = [
        `A moderator accepted your appeal for copyright claim ${ref}. Your post has been restored.`,
        input.resolutionNote ? `Moderator note: ${input.resolutionNote}` : "",
        "No further action is needed.",
        footer,
      ];
      break;
    case "appeal_rejected":
      subject = `Upminaa Web: your appeal was rejected (${ref})`;
      lines = [
        `A moderator reviewed your appeal for copyright claim ${ref} and decided to keep the post hidden.`,
        input.resolutionNote ? `Moderator note: ${input.resolutionNote}` : "",
        "A moderator may now decide to delete the post permanently. This is not done automatically.",
        footer,
      ];
      break;
    case "community_strike": {
      const strike = input.strike;
      const until =
        strike && !strike.permanent && strike.endsAt
          ? new Date(strike.endsAt).toISOString().slice(0, 10)
          : null;
      subject = "Upmina Community - Community strike applied to your account";
      lines = [
        "Your account has received a Community strike following a moderation decision concerning a reported post.",
        strike ? `Strike level: ${strike.level} of 3.` : "",
        strike?.permanent
          ? "While this strike is active, you cannot publish or edit posts in Community. This restriction is permanent."
          : until
            ? `While this strike is active, you cannot publish or edit posts in Community. The restriction ends on ${until} (UTC).`
            : "",
        `Reason recorded by the moderator: ${input.reason}`,
        "Strikes of every kind count together when the level of a new strike is decided.",
        footer,
      ];
      break;
    }
    case "strike": {
      const strike = input.strike;
      const until =
        strike && !strike.permanent && strike.endsAt
          ? new Date(strike.endsAt).toISOString().slice(0, 10)
          : null;
      subject = `Upminaa Web: a copyright strike was applied to your account (${ref})`;
      lines = [
        `Copyright claim ${ref} ended with the permanent deletion of one of your posts. A moderator has now decided to apply a copyright strike to your account.`,
        strike ? `Strike level: ${strike.level} of 3.` : "",
        strike?.permanent
          ? "While this strike is active you cannot publish or edit posts in Community. This restriction is permanent."
          : until
            ? `While this strike is active you cannot publish or edit posts in Community. The restriction ends on ${until} (UTC).`
            : "",
        `Reason recorded by the moderator: ${input.reason}`,
        "Strikes of every kind count together when the level of a new strike is decided.",
        footer,
      ];
      break;
    }
  }
  const kept = lines.filter((l) => l !== "");
  const text = kept.join("\n\n");
  const html = renderBrandedEmailHtml(
    subject,
    kept.map((l): EmailBlock =>
      /^https:\/\/\S+$/.test(l)
        ? { type: "link", href: l, label: "Open link" }
        : { type: "text", text: l },
    ),
  );
  return { subject, text, html };
}

/** Enlace personal de apelación: el origen sale de la configuración del servidor (nunca de la petición). */
export function buildAppealLink(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}/copyright/appeal#t=${token}`;
}

export type CopyrightSendOutcome =
  { ok: true } | { ok: false; errorClass: CopyrightNoticeErrorClass };

const MAIL_ERROR_TO_NOTICE: Record<MailErrorClass, CopyrightNoticeErrorClass> = {
  not_configured: "not_configured",
  rejected: "rejected",
  rate_limited: "rate_limited",
  provider_unavailable: "provider_unavailable",
  timeout: "timeout",
  invalid_response: "invalid_response",
};

/** Envía el aviso. Nunca lanza: devuelve ok o una clase de error segura. */
export async function sendCopyrightNotice(
  config: MailConfig | null,
  params: {
    to: string | null;
    idempotencyKey: string;
    input: CopyrightMailInput;
  },
): Promise<CopyrightSendOutcome> {
  if (!params.to) return { ok: false, errorClass: "no_recipient" };
  if (!config) return { ok: false, errorClass: "not_configured" };
  try {
    const { subject, text, html } = buildCopyrightEmail(params.input);
    const result = await config.sender.send({
      to: params.to,
      subject,
      text,
      html,
      idempotencyKey: params.idempotencyKey,
    });
    if (result.ok) return { ok: true };
    return {
      ok: false,
      errorClass: MAIL_ERROR_TO_NOTICE[result.errorClass ?? "provider_unavailable"],
    };
  } catch {
    return { ok: false, errorClass: "provider_unavailable" };
  }
}
