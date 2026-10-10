import type { ModerationReportReason } from "./moderation-client";

// REP-1: validación del formulario de reporte de una publicación de Comunidad. Es UX: la autoridad
// (autenticación, motivo válido, longitud, existencia del post, auto-reporte, cuenta completa) es el
// servidor (handleModerationReportCreate) y la RPC community_post_report_submit.

/** Motivos que el SERVIDOR acepta hoy (CHECK community_post_reports_reason_check). Los motivos
 *  violence/off_topic/ai_generated requieren la migración 20261102120000 (propuesta, no aplicada).
 *  Copyright NO es un motivo ordinario: tiene circuito propio (docs/REP-1-COPY-1.md). */
export const REPORT_REASONS: readonly ModerationReportReason[] = [
  "harassment",
  "hate_speech",
  "sexual_content",
  "violence",
  "off_topic",
  "ai_generated",
  "spam",
  "other",
];

export const REPORT_DETAIL_MAX = 1000;

// Caracteres de control (salvo salto de línea y tabulador) y NUL: Postgres no admite NUL en text.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type ReportFormError = "reasonRequired" | "detailTooLong" | "detailInvalid";

export type ReportFormResult =
  | { ok: true; reason: ModerationReportReason; detail: string | undefined }
  | { ok: false; error: ReportFormError };

export const reportDetailLength = (raw: string) => Array.from(raw).length;

export function validateReportForm(
  reason: string | null,
  rawDetail: string,
): ReportFormResult {
  if (!reason || !(REPORT_REASONS as readonly string[]).includes(reason))
    return { ok: false, error: "reasonRequired" };
  const detail = rawDetail.trim();
  if (FORBIDDEN.test(detail)) return { ok: false, error: "detailInvalid" };
  if (reportDetailLength(detail) > REPORT_DETAIL_MAX)
    return { ok: false, error: "detailTooLong" };
  return {
    ok: true,
    reason: reason as ModerationReportReason,
    detail: detail === "" ? undefined : detail,
  };
}
