import { describe, expect, it } from "vitest";
import {
  CopyrightNoticeInputError,
  renderCopyrightNotice,
  type CopyrightNoticeInput,
  type CopyrightNoticeKind,
  type NoticeLocale,
} from "./copyright-notices";

const KINDS: CopyrightNoticeKind[] = [
  "first_removal",
  "repeat_removal",
  "removal_with_sanction",
  "claim_dismissed",
];
const LOCALES: NoticeLocale[] = ["es", "en", "de"];
const RECOMMEND_ES =
  "Por favor, evita volver a utilizar o publicar el contenido por el que recibiste esta reclamación, salvo que tengas la autorización correspondiente o exista una base legal que permita su uso.";

const base = (
  kind: CopyrightNoticeKind,
  locale: NoticeLocale,
  extra: Partial<CopyrightNoticeInput> = {},
): CopyrightNoticeInput => ({
  kind,
  locale,
  claimRef: "CPY-2026-000123",
  decidedAt: "2026-11-03T15:20:00.000Z",
  workDescription: "Ilustración «Luna roja» de la autora X",
  ...(kind === "removal_with_sanction"
    ? { sanctionDescription: "restricción de publicar durante 7 días" }
    : {}),
  ...extra,
});

describe("plantillas de notificación de copyright (deterministas, es/en/de)", () => {
  it.each(KINDS.flatMap((k) => LOCALES.map((l) => [k, l] as const)))(
    "%s/%s: es determinista y solo usa datos del expediente",
    (kind, locale) => {
      const input = base(kind, locale);
      const a = renderCopyrightNotice(input);
      const b = renderCopyrightNotice({ ...input });
      expect(a).toEqual(b);
      expect(a.subject.length).toBeGreaterThan(10);
      expect(a.body).toContain("CPY-2026-000123");
      expect(a.body).toContain("2026-11-03");
      expect(a.body).toContain("Ilustración «Luna roja» de la autora X");
      // Sin marcadores sin resolver ni valores vacíos.
      expect(a.body).not.toMatch(/\{|\}|undefined|null|NaN/);
      expect(a.subject).not.toMatch(/\{|\}|undefined|null/);
      if (kind === "removal_with_sanction")
        expect(a.body).toContain("restricción de publicar durante 7 días");
    },
  );

  it("primera retirada: advertencia educativa, SIN sanción, y la recomendación literal en español", () => {
    const n = renderCopyrightNotice(base("first_removal", "es"));
    expect(n.body).toContain(RECOMMEND_ES);
    expect(n.body).toContain("advertencia educativa");
    expect(n.body).toContain("no se aplica ninguna sanción");
    expect(n.body).not.toMatch(/strike/i);
  });

  it("la recomendación solo aparece en la primera retirada", () => {
    for (const locale of LOCALES) {
      const first = renderCopyrightNotice(base("first_removal", locale)).body;
      expect(first).toContain(
        { es: "evita volver", en: "avoid using or posting again", de: "nicht erneut" }[
          locale
        ],
      );
      for (const kind of [
        "repeat_removal",
        "removal_with_sanction",
        "claim_dismissed",
      ] as const) {
        const body = renderCopyrightNotice(base(kind, locale)).body;
        expect(body).not.toContain(
          { es: "evita volver", en: "avoid using or posting again", de: "nicht erneut" }[
            locale
          ],
        );
      }
    }
  });

  it("reincidencia sin sanción: lo dice; con sanción: solo aparece la medida decidida", () => {
    expect(renderCopyrightNotice(base("repeat_removal", "es")).body).toContain(
      "ninguna sanción adicional",
    );
    expect(renderCopyrightNotice(base("repeat_removal", "en")).body).toContain(
      "no additional penalty",
    );
    expect(renderCopyrightNotice(base("repeat_removal", "de")).body).toContain(
      "keine zusätzliche Sanktion",
    );
    const sanction = renderCopyrightNotice(base("removal_with_sanction", "en")).body;
    expect(sanction).toContain("a moderator decided to apply this measure");
    expect(sanction).not.toContain("no additional penalty");
  });

  it("reclamación descartada: no retira nada y no pide acciones", () => {
    const n = renderCopyrightNotice(base("claim_dismissed", "es"));
    expect(n.body).toContain("decidió no retirar el contenido");
    expect(n.body).toContain("No tienes que hacer nada");
    expect(n.body).not.toContain(RECOMMEND_ES);
  });

  it("la contranotificación solo se menciona si el operador aporta las instrucciones", () => {
    const without = renderCopyrightNotice(base("first_removal", "es")).body;
    expect(without).not.toMatch(/no estás de acuerdo/);
    const withIt = renderCopyrightNotice(
      base("first_removal", "es", {
        counterNoticeInstructions: "responde a este mensaje indicando el expediente",
      }),
    ).body;
    expect(withIt).toContain(
      "Si no estás de acuerdo con la retirada: responde a este mensaje indicando el expediente",
    );
    // En una reclamación descartada no hay retirada que impugnar.
    expect(
      renderCopyrightNotice(
        base("claim_dismissed", "es", { counterNoticeInstructions: "no debe aparecer" }),
      ).body,
    ).not.toContain("no debe aparecer");
  });

  it("no inventa información: ni claimante, ni explicaciones legales, ni IA", () => {
    for (const kind of KINDS)
      for (const locale of LOCALES) {
        const body = renderCopyrightNotice(base(kind, locale)).body;
        expect(body).not.toMatch(
          /DMCA|ley |law |Gesetz|artículo|article|§|\bIA\b|\bAI\b|\bKI\b/,
        );
      }
  });

  it.each([
    ["claimRef", { claimRef: "x" }],
    ["claimRef", { claimRef: "cpy-2026-1" }],
    ["claimRef", { claimRef: "CPY-1\nBcc: x@y.z" }],
    ["decidedAt", { decidedAt: "no es fecha" }],
    ["workDescription", { workDescription: "" }],
    ["workDescription", { workDescription: "   " }],
    ["workDescription", { workDescription: "linea1\nlinea2" }],
    ["workDescription", { workDescription: "a".repeat(301) }],
    ["workDescription", { workDescription: "tab\there" }],
    ["counterNoticeInstructions", { counterNoticeInstructions: "a\nb" }],
  ] as const)("rechaza datos inválidos (%s): %j", (field, extra) => {
    try {
      renderCopyrightNotice(
        base("first_removal", "es", extra as Partial<CopyrightNoticeInput>),
      );
      throw new Error("debió lanzar");
    } catch (e) {
      expect(e).toBeInstanceOf(CopyrightNoticeInputError);
      expect((e as CopyrightNoticeInputError).field).toBe(field);
    }
  });

  it("la sanción es obligatoria con sanción y está prohibida sin ella", () => {
    expect(() =>
      renderCopyrightNotice(
        base("removal_with_sanction", "es", { sanctionDescription: undefined }),
      ),
    ).toThrow(CopyrightNoticeInputError);
    for (const kind of ["first_removal", "repeat_removal", "claim_dismissed"] as const)
      expect(() =>
        renderCopyrightNotice(base(kind, "es", { sanctionDescription: "algo" })),
      ).toThrow(CopyrightNoticeInputError);
  });

  it("rechaza idioma o tipo desconocidos", () => {
    expect(() =>
      renderCopyrightNotice({
        ...base("first_removal", "es"),
        locale: "fr" as NoticeLocale,
      }),
    ).toThrow(CopyrightNoticeInputError);
    expect(() =>
      renderCopyrightNotice({
        ...base("first_removal", "es"),
        kind: "strike" as CopyrightNoticeKind,
      }),
    ).toThrow(CopyrightNoticeInputError);
  });

  it("la fecha se fija en UTC (sin depender de la zona horaria del servidor)", () => {
    const n = renderCopyrightNotice(
      base("first_removal", "es", { decidedAt: "2026-11-03T23:59:59-06:00" }),
    );
    expect(n.body).toContain("2026-11-04");
  });
});
