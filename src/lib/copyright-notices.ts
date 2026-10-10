// COPY-1: plantillas DETERMINISTAS (es/en/de) de las notificaciones al usuario por una reclamación
// especial de copyright. Sin IA, sin texto libre del moderador salvo los campos CONFIRMADOS del
// expediente que se pasan explícitamente (obra identificada, medida decidida). Este módulo solo
// formatea: no decide infracciones, no envía nada y no explica leyes. Aún no está conectado a
// ningún backend ni canal de entrega (diseño en docs/REP-1-COPY-1.md §3).
//
// REVISIÓN JURÍDICA PENDIENTE: la redacción de las tres lenguas debe ser revisada por un jurista
// antes de enviarse a usuarios reales. La frase de recomendación de la primera retirada es literal
// del texto aprobado por el propietario (es) y su traducción (en/de) debe validarse igualmente.

export type NoticeLocale = "es" | "en" | "de";
export type CopyrightNoticeKind =
  | "first_removal" // primera retirada confirmada: advertencia educativa, sin strike
  | "repeat_removal" // reincidencia confirmada, sin sanción adicional
  | "removal_with_sanction" // retirada con una medida decidida por un moderador
  | "claim_dismissed"; // reclamación descartada (cuando corresponda notificar)

export interface CopyrightNoticeInput {
  kind: CopyrightNoticeKind;
  locale: NoticeLocale;
  /** Identificador del expediente (p. ej. "CPY-2026-000123"). */
  claimRef: string;
  /** Fecha de la decisión del moderador (ISO 8601); se muestra como AAAA-MM-DD (UTC). */
  decidedAt: string;
  /** Obra protegida tal como la CONFIRMÓ el moderador en el expediente. */
  workDescription: string;
  /** Solo `removal_with_sanction`: medida decidida por el moderador, tal como consta en el expediente. */
  sanctionDescription?: string;
  /** Opcional: instrucciones de contranotificación SOLO si el procedimiento legal aplicable existe y
   *  está definido. Si no se pasa, la notificación no promete ningún canal. */
  counterNoticeInstructions?: string;
}

export interface CopyrightNotice {
  subject: string;
  body: string;
}

export class CopyrightNoticeInputError extends Error {
  constructor(readonly field: string) {
    super(`invalid_notice_input:${field}`);
    this.name = "CopyrightNoticeInputError";
  }
}

const CLAIM_REF = /^[A-Z0-9][A-Z0-9-]{3,31}$/;
const LIMITS = {
  workDescription: 300,
  sanctionDescription: 200,
  counterNoticeInstructions: 400,
};
// Sin saltos de línea ni controles: evita inyección de cabeceras si el texto viaja por correo.
const hasControl = (v: string) =>
  Array.from(v).some((ch) => {
    const c = ch.codePointAt(0)!;
    return c < 32 || c === 127 || c === 0x2028 || c === 0x2029;
  });

function text(field: keyof typeof LIMITS, value: string | undefined, required: boolean) {
  if (value === undefined) {
    if (required) throw new CopyrightNoticeInputError(field);
    return undefined;
  }
  const v = value.trim();
  if (v === "" || hasControl(v) || Array.from(v).length > LIMITS[field])
    throw new CopyrightNoticeInputError(field);
  return v;
}

function utcDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new CopyrightNoticeInputError("decidedAt");
  return d.toISOString().slice(0, 10);
}

interface Strings {
  subject: Record<CopyrightNoticeKind, string>;
  greeting: string;
  removed: (ref: string, date: string, work: string) => string;
  warningOnly: string;
  recommend: string; // solo primera retirada
  repeat: string;
  sanction: (measure: string) => string;
  dismissed: (ref: string, date: string, work: string) => string;
  noAction: string;
  counter: (instructions: string) => string;
  closing: string;
}

const STRINGS: Record<NoticeLocale, Strings> = {
  es: {
    subject: {
      first_removal:
        "Hemos retirado una publicación por una reclamación de derechos de autor",
      repeat_removal:
        "Hemos retirado otra publicación por una reclamación de derechos de autor",
      removal_with_sanction: "Retirada de una publicación y medida en tu cuenta",
      claim_dismissed: "Hemos revisado una reclamación sobre tu publicación",
    },
    greeting: "Hola:",
    removed: (ref, date, work) =>
      `El ${date}, un moderador revisó la reclamación de derechos de autor ${ref} y confirmó que tiene fundamento. Por eso retiramos la publicación afectada. Obra indicada en el expediente: ${work}.`,
    warningOnly:
      "Esta es una advertencia educativa: no se aplica ninguna sanción a tu cuenta por esta retirada.",
    recommend:
      "Por favor, evita volver a utilizar o publicar el contenido por el que recibiste esta reclamación, salvo que tengas la autorización correspondiente o exista una base legal que permita su uso.",
    repeat:
      "Ya habías recibido una retirada confirmada anteriormente. En esta ocasión no se aplica ninguna sanción adicional a tu cuenta.",
    sanction: (m) =>
      `Además, un moderador decidió aplicar esta medida a tu cuenta: ${m}.`,
    dismissed: (ref, date, work) =>
      `El ${date}, un moderador revisó la reclamación de derechos de autor ${ref} sobre tu publicación (obra indicada: ${work}) y decidió no retirar el contenido.`,
    noAction: "No tienes que hacer nada y no se aplica ninguna medida a tu cuenta.",
    counter: (i) => `Si no estás de acuerdo con la retirada: ${i}`,
    closing: "El equipo de moderación de Upminaa Web",
  },
  en: {
    subject: {
      first_removal: "We removed a post because of a copyright claim",
      repeat_removal: "We removed another post because of a copyright claim",
      removal_with_sanction:
        "A post was removed and a measure was applied to your account",
      claim_dismissed: "We reviewed a claim about your post",
    },
    greeting: "Hello,",
    removed: (ref, date, work) =>
      `On ${date}, a moderator reviewed copyright claim ${ref} and confirmed that it is well founded. We therefore removed the affected post. Work identified in the case file: ${work}.`,
    warningOnly:
      "This is an educational warning: no penalty is applied to your account for this removal.",
    recommend:
      "Please avoid using or posting again the content that led to this claim, unless you have the corresponding authorisation or there is a legal basis that allows its use.",
    repeat:
      "You had already received a confirmed removal before. This time no additional penalty is applied to your account.",
    sanction: (m) =>
      `In addition, a moderator decided to apply this measure to your account: ${m}.`,
    dismissed: (ref, date, work) =>
      `On ${date}, a moderator reviewed copyright claim ${ref} about your post (work identified: ${work}) and decided not to remove the content.`,
    noAction: "You do not need to do anything and no measure is applied to your account.",
    counter: (i) => `If you disagree with the removal: ${i}`,
    closing: "The Upminaa Web moderation team",
  },
  de: {
    subject: {
      first_removal:
        "Wir haben einen Beitrag wegen einer Urheberrechtsbeanstandung entfernt",
      repeat_removal:
        "Wir haben einen weiteren Beitrag wegen einer Urheberrechtsbeanstandung entfernt",
      removal_with_sanction:
        "Ein Beitrag wurde entfernt und eine Maßnahme für dein Konto wurde verhängt",
      claim_dismissed: "Wir haben eine Beanstandung zu deinem Beitrag geprüft",
    },
    greeting: "Hallo,",
    removed: (ref, date, work) =>
      `Am ${date} hat ein Moderator die Urheberrechtsbeanstandung ${ref} geprüft und festgestellt, dass sie begründet ist. Deshalb haben wir den betroffenen Beitrag entfernt. In der Akte genanntes Werk: ${work}.`,
    warningOnly:
      "Dies ist eine Hinweis-Verwarnung zur Aufklärung: Für diese Entfernung wird keine Sanktion gegen dein Konto verhängt.",
    recommend:
      "Bitte verwende den Inhalt, der zu dieser Beanstandung geführt hat, nicht erneut und veröffentliche ihn nicht noch einmal, es sei denn, du hast die entsprechende Erlaubnis oder es gibt eine Rechtsgrundlage, die seine Nutzung erlaubt.",
    repeat:
      "Du hattest bereits zuvor eine bestätigte Entfernung erhalten. Diesmal wird keine zusätzliche Sanktion gegen dein Konto verhängt.",
    sanction: (m) =>
      `Außerdem hat ein Moderator beschlossen, folgende Maßnahme auf dein Konto anzuwenden: ${m}.`,
    dismissed: (ref, date, work) =>
      `Am ${date} hat ein Moderator die Urheberrechtsbeanstandung ${ref} zu deinem Beitrag (genanntes Werk: ${work}) geprüft und beschlossen, den Inhalt nicht zu entfernen.`,
    noAction: "Du musst nichts tun und es wird keine Maßnahme gegen dein Konto verhängt.",
    counter: (i) => `Wenn du mit der Entfernung nicht einverstanden bist: ${i}`,
    closing: "Das Moderationsteam von Upminaa Web",
  },
};

/** Renderiza la notificación. Lanza `CopyrightNoticeInputError` si falta o es inválido algún dato
 *  del expediente: nunca se rellena ni se inventa información. */
export function renderCopyrightNotice(input: CopyrightNoticeInput): CopyrightNotice {
  const s = STRINGS[input.locale];
  if (!s) throw new CopyrightNoticeInputError("locale");
  if (!(input.kind in s.subject)) throw new CopyrightNoticeInputError("kind");
  if (typeof input.claimRef !== "string" || !CLAIM_REF.test(input.claimRef))
    throw new CopyrightNoticeInputError("claimRef");
  const date = utcDate(input.decidedAt);
  const work = text("workDescription", input.workDescription, true)!;
  const counter = text(
    "counterNoticeInstructions",
    input.counterNoticeInstructions,
    false,
  );
  const measure = text(
    "sanctionDescription",
    input.sanctionDescription,
    input.kind === "removal_with_sanction",
  );
  if (input.kind !== "removal_with_sanction" && input.sanctionDescription !== undefined)
    throw new CopyrightNoticeInputError("sanctionDescription");

  const parts: string[] = [s.greeting];
  switch (input.kind) {
    case "first_removal":
      parts.push(s.removed(input.claimRef, date, work), s.warningOnly, s.recommend);
      break;
    case "repeat_removal":
      parts.push(s.removed(input.claimRef, date, work), s.repeat);
      break;
    case "removal_with_sanction":
      parts.push(s.removed(input.claimRef, date, work), s.sanction(measure!));
      break;
    case "claim_dismissed":
      parts.push(s.dismissed(input.claimRef, date, work), s.noAction);
      break;
  }
  if (counter && input.kind !== "claim_dismissed") parts.push(s.counter(counter));
  parts.push(s.closing);
  return { subject: s.subject[input.kind], body: parts.join("\n\n") };
}
