import { renderBrandedEmailHtml, type EmailBlock } from "./mail-html.js";

// DEL-4 (DISEÑO + constructor puro): aviso FINAL de que la eliminación de la cuenta terminó. Solo construye el mensaje; NO está
// conectado al worker ni se envía desde ningún sitio todavía: el envío idempotente necesita una migración (ver
// docs/DEL-4-COMPLETION-NOTICE-DESIGN.md). Sin enlaces, sin tokens y sin datos de la cuenta: solo el texto fijo por idioma.

export type DeletionNoticeLocale = "es" | "en" | "de";

const COPY: Record<
  DeletionNoticeLocale,
  { subject: string; paragraphs: string[]; footer: string }
> = {
  es: {
    subject: "Upmina Community - Tu cuenta ha sido eliminada",
    paragraphs: [
      "Hemos terminado de eliminar tu cuenta de Upmina Community y los datos asociados.",
      "Ya no puedes iniciar sesión con ella y no se puede restaurar. Algunos registros restringidos pueden conservarse por motivos justificados, y las copias de seguridad pueden tardar en depurarse.",
      "Si no solicitaste esta eliminación, escríbenos cuanto antes. Nadie del equipo te pedirá nunca tu contraseña.",
    ],
    footer: "Mensaje automático de Upminaa Web. Por favor, no respondas a este mensaje.",
  },
  en: {
    subject: "Upmina Community - Your account has been deleted",
    paragraphs: [
      "We have finished deleting your Upmina Community account and its associated data.",
      "You can no longer sign in with it and it cannot be restored. Some restricted records may be kept for justified reasons, and backups may take time to be purged.",
      "If you did not request this deletion, contact us as soon as possible. Nobody on the team will ever ask you for your password.",
    ],
    footer: "Automatic message from Upminaa Web. Please do not reply to this message.",
  },
  de: {
    subject: "Upmina Community - Dein Konto wurde gelöscht",
    paragraphs: [
      "Wir haben die Löschung deines Upmina-Community-Kontos und der zugehörigen Daten abgeschlossen.",
      "Du kannst dich damit nicht mehr anmelden, und das Konto kann nicht wiederhergestellt werden. Einige eingeschränkte Datensätze können aus berechtigten Gründen aufbewahrt werden, und Backups können einige Zeit bestehen bleiben.",
      "Wenn du diese Löschung nicht beantragt hast, melde dich so bald wie möglich bei uns. Niemand aus dem Team wird dich jemals nach deinem Passwort fragen.",
    ],
    footer:
      "Automatische Nachricht von Upminaa Web. Bitte antworte nicht auf diese Nachricht.",
  },
};

/** El HTML de los correos es solo ASCII: lo no ASCII se codifica como referencia numérica. */
const toAscii = (html: string) =>
  html.replace(/[^\n\x20-\x7e]/g, (c) => `&#${c.codePointAt(0)};`);

export function buildAccountDeletionCompletedEmail(locale: DeletionNoticeLocale): {
  subject: string;
  text: string;
  html: string;
} {
  const copy = COPY[locale] ?? COPY.en;
  const text = [...copy.paragraphs, copy.footer].join("\n\n");
  const html = toAscii(
    renderBrandedEmailHtml(
      copy.subject,
      copy.paragraphs.map((p): EmailBlock => ({ type: "text", text: p })),
      copy.footer,
    ),
  );
  return { subject: copy.subject, text, html };
}
