import { describe, expect, it } from "vitest";
import {
  checkPostText,
  COMMUNITY_POST_MAX_MEDIA,
  COMMUNITY_POST_TEXT_MAX,
} from "./community-post-fields";

// Reutiliza EXACTAMENTE el pipeline de profile-fields.ts (checkText/checkBio) — ver ese archivo
// para la cobertura genérica de NFC/controles/invisibles/surrogates. Aquí solo se confirma que
// checkPostText lo aplica con los límites propios de Comunidad (2000, saltos de línea permitidos)
// y el contrato "null o solo-espacios ⇒ ausente".

describe("checkPostText", () => {
  it("null explícito ⇒ { ok: true, value: null }", () => {
    expect(checkPostText(null)).toEqual({ ok: true, value: null });
  });

  it("cadena vacía o solo-espacios ⇒ ausente (value: null), nunca un post 'vacío pero con texto'", () => {
    expect(checkPostText("")).toEqual({ ok: true, value: null });
    expect(checkPostText("   \n\t  ")).toEqual({ ok: true, value: null });
  });

  it("admite saltos de línea (igual que la bio — texto libre del usuario)", () => {
    const result = checkPostText("línea uno\nlínea dos");
    expect(result).toEqual({ ok: true, value: "línea uno\nlínea dos" });
  });

  it(`exactamente ${COMMUNITY_POST_TEXT_MAX} code points: aceptado`, () => {
    const text = "a".repeat(COMMUNITY_POST_TEXT_MAX);
    const result = checkPostText(text);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(Array.from(result.value ?? "")).toHaveLength(COMMUNITY_POST_TEXT_MAX);
  });

  it(`${COMMUNITY_POST_TEXT_MAX + 1} code points: rechazado`, () => {
    const text = "a".repeat(COMMUNITY_POST_TEXT_MAX + 1);
    expect(checkPostText(text)).toEqual({ ok: false });
  });

  it("normaliza a NFC (mismo pipeline que profile-fields.ts)", () => {
    // "é" en forma NFD (e + combining acute) debe normalizarse a NFC (é precompuesto).
    const nfd = "café";
    const result = checkPostText(nfd);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("café".normalize("NFC"));
  });

  it("rechaza caracteres de control C0/C1 (excepto LF)", () => {
    expect(checkPostText("hola\u0000mundo")).toEqual({ ok: false });
    expect(checkPostText("hola\u007Fmundo")).toEqual({ ok: false });
  });

  it("rechaza invisibles peligrosos (p. ej. RLO U+202E)", () => {
    expect(checkPostText("hola‮mundo")).toEqual({ ok: false });
  });

  it("recorta espacios exteriores pero conserva los internos", () => {
    expect(checkPostText("  hola mundo  ")).toEqual({ ok: true, value: "hola mundo" });
  });
});

describe("constantes exportadas coinciden con la migración/RPC", () => {
  it("COMMUNITY_POST_TEXT_MAX es 2000 (community_posts_text_length)", () => {
    expect(COMMUNITY_POST_TEXT_MAX).toBe(2000);
  });

  it("COMMUNITY_POST_MAX_MEDIA es 10 (límite validado en community_post_save/_reorder_media)", () => {
    expect(COMMUNITY_POST_MAX_MEDIA).toBe(10);
  });
});
