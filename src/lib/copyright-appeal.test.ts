import { describe, expect, it } from "vitest";
import {
  APPEAL_PAYLOAD_KEYS,
  APPEAL_REASON_VALUES,
  APPEAL_STATEMENT_VERSION,
  validateAppealForm,
  validateRemovalReason,
  type AppealFormInput,
} from "./copyright-appeal";

// COPY-1 fase 2B: validación compartida de la apelación (navegador y servidor). Solo texto y enlaces.

const valid = (over: Partial<AppealFormInput> = {}): AppealFormInput => ({
  contactName: "  Autor Original ",
  contactEmail: "  Autor@Example.COM ",
  reason: "own_work",
  explanation: "La ilustración es mía y la publiqué antes",
  evidenceText: "Archivo fuente con fechas",
  evidenceUrls: "https://example.com/uno\nhttps://example.com/dos",
  statementAccepted: true,
  ...over,
});

describe("validateAppealForm", () => {
  it("normaliza y devuelve exactamente las claves que acepta el servidor", () => {
    const result = validateAppealForm(valid());
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(Object.keys(result.payload).sort()).toEqual([...APPEAL_PAYLOAD_KEYS].sort());
    expect(result.payload).toMatchObject({
      contactName: "Autor Original",
      contactEmail: "autor@example.com",
      evidenceUrls: ["https://example.com/uno", "https://example.com/dos"],
      statementVersion: APPEAL_STATEMENT_VERSION,
      statementAccepted: true,
    });
  });

  it("acepta pruebas solo con texto o solo con enlaces, pero no ninguna", () => {
    expect(validateAppealForm(valid({ evidenceUrls: "" })).ok).toBe(true);
    expect(validateAppealForm(valid({ evidenceText: "" })).ok).toBe(true);
    const none = validateAppealForm(valid({ evidenceText: "  ", evidenceUrls: [] }));
    expect(none.ok).toBe(false);
    if (none.ok === false) expect(none.errors.evidence).toBe("required");
  });

  it.each(APPEAL_REASON_VALUES)("acepta la razón %s", (reason) => {
    expect(validateAppealForm(valid({ reason })).ok).toBe(true);
  });

  it.each([
    ["nombre corto", { contactName: "x" }, "contactName"],
    ["nombre con control", { contactName: "Ana\u0007" }, "contactName"],
    ["correo sin arroba", { contactEmail: "no" }, "contactEmail"],
    ["correo con espacios", { contactEmail: "a b@example.com" }, "contactEmail"],
    ["razón desconocida", { reason: "otra" }, "reason"],
    ["razón ausente", { reason: "" }, "reason"],
    ["explicación corta", { explanation: "corta" }, "explanation"],
    ["explicación larga", { explanation: "a".repeat(2001) }, "explanation"],
    ["texto de prueba largo", { evidenceText: "a".repeat(2001) }, "evidenceText"],
    ["enlace ftp", { evidenceUrls: "ftp://example.com/x" }, "evidenceUrls"],
    ["enlace con javascript", { evidenceUrls: "javascript:alert(1)" }, "evidenceUrls"],
    [
      "seis enlaces",
      { evidenceUrls: Array.from({ length: 6 }, (_, i) => `https://e.example/${i}`) },
      "evidenceUrls",
    ],
    ["sin declaración", { statementAccepted: false }, "statementAccepted"],
    ["declaración como texto", { statementAccepted: "true" }, "statementAccepted"],
  ])("rechaza %s", (_n, over, field) => {
    const result = validateAppealForm(valid(over as Partial<AppealFormInput>));
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(Object.keys(result.errors)).toContain(field);
  });

  it("no existe ningún campo de archivo o documento de identidad", () => {
    expect(APPEAL_PAYLOAD_KEYS.join(",")).not.toMatch(
      /file|document|upload|passport|identity/i,
    );
  });
});

describe("validateRemovalReason", () => {
  it("exige entre 10 y 1000 caracteres sin controles", () => {
    expect(validateRemovalReason("El contenido reproduce la obra").ok).toBe(true);
    for (const bad of ["", "corto", "a".repeat(1001), "texto largo\u0007", 5, null])
      expect(validateRemovalReason(bad).ok).toBe(false);
  });
});
