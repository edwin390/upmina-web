// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildAccountDeletionCompletedEmail,
  type DeletionNoticeLocale,
} from "./account-deletion-completed-mail";

const LOCALES: DeletionNoticeLocale[] = ["es", "en", "de"];

describe("aviso final de eliminación de cuenta", () => {
  it.each(LOCALES)("%s: texto plano y HTML coherentes, sin enlaces ni tokens", (l) => {
    const m = buildAccountDeletionCompletedEmail(l);
    expect(m.subject.startsWith("Upmina Community - ")).toBe(true);
    expect(m.text.length).toBeGreaterThan(100);
    expect(m.html).not.toMatch(/<a[\s>]|https?:\/\/|#t=|token/i);
    expect(m.text).not.toMatch(/https?:\/\/|#t=/i);
    expect(m.html).toMatch(/^[\n\x20-\x7e]+$/); // solo ASCII
    expect(m.html).toContain("#171f30"); // identidad visual actual
    expect(m.html).not.toContain("#ff2d95");
  });

  it("cada idioma usa su propio texto", () => {
    const [es, en, de] = LOCALES.map((l) => buildAccountDeletionCompletedEmail(l));
    expect(es.text).toContain("Hemos terminado");
    expect(en.text).toContain("We have finished");
    expect(de.text).toContain("Wir haben");
    expect(de.html).toContain("&#252;"); // ü codificada, no cruda
    expect(new Set([es.subject, en.subject, de.subject]).size).toBe(3);
  });

  it("un idioma desconocido cae a inglés", () => {
    const m = buildAccountDeletionCompletedEmail("fr" as DeletionNoticeLocale);
    expect(m.text).toContain("We have finished");
  });

  it("no afirma una eliminación pendiente ni restauración", () => {
    for (const l of LOCALES) {
      const m = buildAccountDeletionCompletedEmail(l);
      expect(m.text).not.toMatch(/reactivat|reactiv|reaktiv/i);
    }
  });
});
