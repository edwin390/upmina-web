import {
  checkText,
  CONTROL_CHARS_EXCEPT_LF,
  type TextFieldCheck,
} from "./profile-fields.js";

// Normalización y validación SERVER-SIDE del texto de una publicación de Comunidad (Fase 9J-1C).
// Reutiliza EXACTAMENTE el mismo pipeline que profile-fields.ts (checkBio): trim exterior → vacío
// ⇒ NULL (texto solo-espacios cuenta como ausente) → NFC → controles/invisibles peligrosos →
// longitud en CODE POINTS. Nunca colapsa espacios internos ni translitera; HTML/Markdown no se
// interpretan. La base de datos (community_posts_text_length/_not_blank, ver la migración
// 20261004120000) es la autoridad final — esto solo evita viajes inútiles con un 422 temprano.

export const COMMUNITY_POST_TEXT_MAX = 2000;
export const COMMUNITY_POST_MAX_MEDIA = 10;

/** `null` explícito o texto solo-espacios ⇒ NULL (ausente). Admite saltos de línea (igual que
 *  la bio): una publicación de Comunidad es texto libre del usuario, no un campo de una línea. */
export function checkPostText(raw: string | null): TextFieldCheck {
  if (raw === null) return { ok: true, value: null };
  return checkText(raw, COMMUNITY_POST_TEXT_MAX, CONTROL_CHARS_EXCEPT_LF, true);
}
