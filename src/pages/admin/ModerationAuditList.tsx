import { useLocale, useTranslations } from "use-intl";
import {
  MODERATION_AUDIT_ACTIONS,
  type ModerationAuditAction,
  type ModerationCaseItem,
} from "@/lib/moderation-case-contract";

// R5-F: historial de auditoría del detalle de caso, legible y traducible (es/en/de, namespace
// `moderation`). Solo muestra lo que el contrato ya entrega: acción (lista cerrada), tipo de actor
// (sistema / acción humana), fecha, transiciones de estado y, en eventos de strike, el nivel.
// NO recibe ni muestra identidad del actor: el contrato no la incluye y exponerla exigiría ampliar la
// lectura SQL y decidir una política de permisos (ver docs/9K-R5F-AUDIT-VISUAL.md).

type AuditItem = ModerationCaseItem["audit"][number];
type Category = "automatic" | "moderation" | "restoration" | "decision" | "sanction";

const CATEGORY: Record<ModerationAuditAction, Category> = {
  report_status_changed: "moderation",
  post_hidden: "moderation",
  post_restored: "restoration",
  post_quarantined: "automatic",
  case_rejected: "decision",
  content_actioned: "decision",
  strike_applied: "sanction",
  strike_revoked: "sanction",
  post_purged: "automatic",
};

// Distinción por texto (insignia) Y por color del borde: el color nunca es la única señal.
const BORDER: Record<Category, string> = {
  automatic: "border-l-text-muted",
  moderation: "border-l-accent-primary",
  restoration: "border-l-accent-secondary",
  decision: "border-l-accent-primary",
  sanction: "border-l-accent-live",
};

const isKnownAction = (value: string): value is ModerationAuditAction =>
  (MODERATION_AUDIT_ACTIONS as readonly string[]).includes(value);

export default function ModerationAuditList({ audit }: { audit: AuditItem[] }) {
  const t = useTranslations("moderation.audit");
  const locale = useLocale();
  const format = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const state = (group: "postStatus" | "reportStatus", value: string | null) => {
    if (value === null) return t("transition.none");
    const key = `${group}.${value}`;
    return t.has(key as never) ? t(key as never) : t("transition.none");
  };

  return (
    <section aria-label={t("regionLabel")}>
      <h2 className="font-semibold">{t("title")}</h2>
      {audit.length === 0 ? (
        <p className="mt-2 text-sm text-text-muted">{t("empty")}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {audit.map((a) => {
            const known = isKnownAction(a.action);
            const category: Category =
              a.actorKind === "system"
                ? "automatic"
                : known
                  ? CATEGORY[a.action]
                  : "moderation";
            const label = known ? t(`actions.${a.action}.label`) : t("unknown.label");
            const description = known
              ? t(`actions.${a.action}.description`)
              : t("unknown.description");
            const post = a.states.fromPostStatus || a.states.toPostStatus;
            const report = a.states.fromReportStatus || a.states.toReportStatus;
            return (
              <li
                key={a.id}
                data-category={category}
                className={`min-w-0 break-words rounded border border-border-subtle border-l-4 p-3 text-sm ${BORDER[category]}`}
              >
                <p>
                  <span className="mr-2 inline-block rounded border border-border-subtle px-2 py-0.5 text-xs uppercase tracking-wide">
                    {t(`category.${category}`)}
                  </span>{" "}
                  <span className="font-semibold">{label}</span>
                  {a.strikeLevel
                    ? ` · ${t("strikeLevel", { level: a.strikeLevel })}`
                    : ""}
                  {" · "}
                  {a.actorKind === "system" ? t("actor.system") : t("actor.human")}
                  {" · "}
                  <time dateTime={a.createdAt}>
                    {format.format(new Date(a.createdAt))}
                  </time>
                </p>
                <p className="mt-1 text-text-secondary">{description}</p>
                {(post || report) && (
                  <p className="mt-1 text-text-muted">
                    {post
                      ? t("transition.post", {
                          from: state("postStatus", a.states.fromPostStatus ?? null),
                          to: state("postStatus", a.states.toPostStatus ?? null),
                        })
                      : null}
                    {post && report ? " · " : null}
                    {report
                      ? t("transition.report", {
                          from: state("reportStatus", a.states.fromReportStatus ?? null),
                          to: state("reportStatus", a.states.toReportStatus ?? null),
                        })
                      : null}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
