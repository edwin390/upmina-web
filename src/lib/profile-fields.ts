// Normalización y validación SERVER-SIDE de display_name y bio (Bloque 7D.2). La base de
// datos sigue siendo la autoridad final (profiles_display_name_length,
// profiles_display_name_no_control_chars, profiles_bio_length en
// supabase/migrations/20260924120000_profiles.sql); estas reglas son iguales o más
// estrictas para que un valor inválido se rechace con 422 antes de llegar a Postgres.
//
// Pipeline (ambos campos): string → trim exterior → vacío ⇒ NULL → NFC → controles /
// invisibles → longitud en CODE POINTS (char_length de Postgres cuenta code points, no
// unidades UTF-16 como String.length). No se colapsan espacios internos ni se transliteran
// caracteres. HTML/Markdown NO se interpretan ni se sanitizan: es texto plano que la UI
// debe renderizar siempre como texto.

export const DISPLAY_NAME_MAX = 40;
export const BIO_MAX = 280;

// C0 (U+0000–U+001F), DEL (U+007F) y C1 (U+0080–U+009F).
// eslint-disable-next-line no-control-regex -- los controles son justamente lo que se rechaza
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
// Igual, pero permitiendo LF (U+000A): la bio admite varias líneas.
// eslint-disable-next-line no-control-regex -- los controles son justamente lo que se rechaza
const CONTROL_CHARS_EXCEPT_LF = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
// Controles bidireccionales e invisibles peligrosos (vector de impersonación visual) que
// el CHECK [[:cntrl:]] de la DB no cubre: U+200B–U+200F, U+202A–U+202E, U+2066–U+2069,
// U+FEFF.
const DANGEROUS_INVISIBLES = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
// Surrogate suelto (alto sin bajo o bajo sin alto): Postgres no puede almacenarlo.
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export type TextFieldCheck = { ok: true; value: string | null } | { ok: false };

/** Longitud en code points (equivalente a char_length de Postgres). */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}

function checkText(
  raw: string,
  max: number,
  controls: RegExp,
  allowLineBreaks: boolean,
): TextFieldCheck {
  if (LONE_SURROGATE.test(raw)) return { ok: false };
  let text = raw;
  if (allowLineBreaks) text = text.replace(/\r\n?/g, "\n");
  text = text.trim();
  if (text === "") return { ok: true, value: null };
  text = text.normalize("NFC");
  if (controls.test(text) || DANGEROUS_INVISIBLES.test(text)) return { ok: false };
  if (codePointLength(text) > max) return { ok: false };
  return { ok: true, value: text };
}

/** `null` explícito ⇒ NULL. Cualquier tipo distinto de string/null lo descarta el handler
 *  como 400 antes de llegar aquí. */
export function checkDisplayName(raw: string | null): TextFieldCheck {
  if (raw === null) return { ok: true, value: null };
  return checkText(raw, DISPLAY_NAME_MAX, CONTROL_CHARS, false);
}

export function checkBio(raw: string | null): TextFieldCheck {
  if (raw === null) return { ok: true, value: null };
  return checkText(raw, BIO_MAX, CONTROL_CHARS_EXCEPT_LF, true);
}
