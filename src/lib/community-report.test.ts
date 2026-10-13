import { describe, expect, it } from "vitest";
import {
  REPORT_DETAIL_MAX,
  REPORT_REASONS,
  validateReportForm,
} from "./community-report";
import { readFileSync } from "node:fs";

describe("validación del formulario de reporte (REP-1)", () => {
  it("los motivos ofrecidos son exactamente los que acepta el servidor hoy", () => {
    expect([...REPORT_REASONS]).toEqual([
      "harassment",
      "hate_speech",
      "sexual_content",
      "violence",
      "off_topic",
      "ai_generated",
      "spam",
      "other",
    ]);
    // Coinciden con la lista cerrada del handler y con el CHECK de la migración.
    const quoted = (src: string) =>
      [...src.matchAll(/"(\w+)"/g)].map((m) => m[1]!).sort();
    const handler = readFileSync("src/lib/moderation-handlers.ts", "utf8");
    const handlerList = handler.match(/const REASONS = \[([^\]]*)\] as const/)![1]!;
    expect(quoted(handlerList)).toEqual([...REPORT_REASONS].sort());
    const migration = readFileSync(
      "supabase/migrations/20261106120000_community_report_reasons.sql",
      "utf8",
    );
    const check = migration.match(
      /community_post_reports_reason_check\s+check \(reason in \(([^)]*)\)/,
    )![1]!;
    expect([...check.matchAll(/'(\w+)'/g)].map((m) => m[1]!).sort()).toEqual(
      [...REPORT_REASONS].sort(),
    );
  });

  it("exige un motivo conocido", () => {
    for (const r of [null, "", "copyright", "Violence", "Spam", "__proto__"]) {
      expect(validateReportForm(r, "")).toEqual({ ok: false, error: "reasonRequired" });
    }
  });

  it("la explicación es opcional y se recorta", () => {
    expect(validateReportForm("spam", "")).toEqual({
      ok: true,
      reason: "spam",
      detail: undefined,
    });
    expect(validateReportForm("other", "   \n ")).toEqual({
      ok: true,
      reason: "other",
      detail: undefined,
    });
    expect(validateReportForm("other", "  hola  ")).toEqual({
      ok: true,
      reason: "other",
      detail: "hola",
    });
  });

  it("límite de longitud por puntos de código, no por unidades UTF-16", () => {
    expect(validateReportForm("spam", "a".repeat(REPORT_DETAIL_MAX)).ok).toBe(true);
    expect(validateReportForm("spam", "a".repeat(REPORT_DETAIL_MAX + 1))).toEqual({
      ok: false,
      error: "detailTooLong",
    });
    // 1000 emojis = 2000 unidades UTF-16 pero 1000 puntos de código: válido (igual que el servidor).
    expect(validateReportForm("spam", "😀".repeat(REPORT_DETAIL_MAX)).ok).toBe(true);
    expect(validateReportForm("spam", "😀".repeat(REPORT_DETAIL_MAX + 1).trim()).ok).toBe(
      false,
    );
  });

  it("rechaza NUL y caracteres de control, pero admite saltos de línea y tabulaciones", () => {
    for (const bad of ["a\u0000b", "a\u0007b", "a\u001bb", "a\u007fb"]) {
      expect(validateReportForm("spam", bad)).toEqual({
        ok: false,
        error: "detailInvalid",
      });
    }
    expect(validateReportForm("spam", "linea 1\nlinea 2\tfin").ok).toBe(true);
  });
});
