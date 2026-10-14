import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import UpminaLocaleProvider from "@/i18n/LocaleProvider";
import { usePrivilegedFailureReporter } from "@/hooks/privileged-failure";
import {
  alertKind,
  canRetry,
  fetchDeletionAlerts,
  retryAccountDeletion,
  type DeletionAlert,
} from "@/lib/account-deletion-client";

// Eliminaciones de cuenta pendientes (DEL-3) para Developer. Presenta lo que devuelve GET /api/admin/account-deletion-alerts y permite
// SOLICITAR el reintento (POST account-deletion-retry). Ocultar o mostrar esta sección NO es una frontera de seguridad: el servidor exige
// rol Developer + MFA reciente en cada llamada y la RPC lo reverifica.
//
//   * No se muestran identidades: el backend no envía user_id ni correo, y el id de la solicitud (interno) solo se usa para la acción.
//   * Reintentar SOLO reprograma las etapas incompletas: no restaura el acceso, no recrea la cuenta y no borra usuarios arbitrarios. Por
//     eso el resultado se presenta como «solicitado», jamás como «completado».
//   * La acción pide confirmación y se bloquea mientras hay una petición en curso (también entre filas).

const SECONDARY =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";

const STAGE_KEYS = [
  "auth_block",
  "copyright_claims",
  "community_content",
  "profile",
  "media_gc",
  "auth_delete",
] as const;
const ERROR_KEYS = [
  "r2_unavailable",
  "auth_unavailable",
  "db_error",
  "media_gc_pending",
  "last_admin_protected",
  "avatar_not_supported",
  "timeout",
  "unexpected",
] as const;
type StageKey = (typeof STAGE_KEYS)[number];
type ErrorKey = (typeof ERROR_KEYS)[number];
type NoticeKey = "requested" | "forbidden" | "notApplicable" | "notFound" | "failed";
const asStage = (v: string | null): StageKey | null =>
  (STAGE_KEYS as readonly string[]).includes(v ?? "") ? (v as StageKey) : null;
const asError = (v: string | null): ErrorKey | null =>
  (ERROR_KEYS as readonly string[]).includes(v ?? "") ? (v as ErrorKey) : null;

function DeletionAlerts() {
  const t = useTranslations("auth.accountDeletion.developer");
  const locale = useLocale();
  const headingId = useId();
  const reportFailure = usePrivilegedFailureReporter();
  const [items, setItems] = useState<DeletionAlert[] | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; key: NoticeKey } | null>(null);
  const sendingRef = useRef(false);
  const mounted = useRef(true);
  const request = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const mine = ++request.current;
    const current = () => mounted.current && request.current === mine;
    setLoading(true);
    const outcome = await fetchDeletionAlerts();
    if (!current()) return;
    setLoading(false);
    if (outcome.kind === "ok") {
      setError(false);
      setItems(outcome.alerts);
      return;
    }
    if (outcome.kind === "failure") reportFailure(outcome.response);
    setError(true);
  }, [reportFailure]);

  useEffect(() => {
    void load();
  }, [load]);

  const date = (iso: string | null) => {
    if (!iso) return t("none");
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime())
      ? t("none")
      : new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(parsed);
  };

  async function retry(requestId: string) {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(requestId);
    setNotice(null);
    const outcome = await retryAccountDeletion(requestId);
    sendingRef.current = false;
    if (!mounted.current) return;
    setSending(null);
    setConfirming(null);
    if (outcome.kind === "requested") {
      setNotice({ ok: true, key: "requested" });
      void load();
      return;
    }
    if (outcome.kind === "forbidden") {
      reportFailure(outcome.response);
      setNotice({ ok: false, key: "forbidden" });
    } else if (outcome.kind === "not_applicable") {
      setNotice({ ok: false, key: "notApplicable" });
      void load();
    } else if (outcome.kind === "not_found") {
      setNotice({ ok: false, key: "notFound" });
      void load();
    } else {
      if (outcome.kind === "failure") reportFailure(outcome.response);
      setNotice({ ok: false, key: "failed" });
    }
  }

  return (
    <section aria-labelledby={headingId} className="mt-10">
      <h2 id={headingId} className="font-display text-xl text-text-primary">
        {t("title")}
      </h2>
      <p className="mt-2 text-sm text-text-secondary">{t("intro")}</p>
      <div className="mt-3">
        <button
          type="button"
          className={SECONDARY}
          disabled={loading}
          onClick={() => void load()}
        >
          {t("refresh")}
        </button>
      </div>
      {notice ? (
        <p
          role={notice.ok ? "status" : "alert"}
          className={`mt-3 text-sm ${notice.ok ? "text-text-secondary" : "text-accent-live"}`}
        >
          {t(`retry.${notice.key}`)}
        </p>
      ) : null}
      {loading && items === null ? (
        <p role="status" className="mt-4 text-sm text-text-secondary">
          {t("loading")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-4 text-sm text-accent-live">
          {t("error")}
        </p>
      ) : null}
      {items !== null && items.length === 0 && !error ? (
        <p className="mt-4 text-sm text-text-secondary">{t("empty")}</p>
      ) : null}
      {items !== null && items.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {items.map((a, index) => {
            const kind = alertKind(a);
            const stage = asStage(a.failedStage);
            const code = asError(a.errorCode);
            return (
              <li
                key={a.requestId}
                className="rounded-md border border-border-subtle p-4"
              >
                <p className="font-semibold text-text-primary">
                  {t("item")} #{index + 1}
                  <span className="ml-2 rounded border border-accent-live/60 px-2 py-0.5 text-xs font-semibold text-accent-live">
                    {t(`kind.${kind}`)}
                  </span>
                  <span className="ml-2 text-sm font-normal text-text-secondary">
                    {t("blocked")}
                  </span>
                </p>
                <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="inline text-text-muted">{t("status")}: </dt>
                    <dd className="inline text-text-primary">
                      {t(`statusLabels.${a.status}`)}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline text-text-muted">{t("stage")}: </dt>
                    <dd className="inline text-text-primary">
                      {stage ? t(`stages.${stage}`) : t("none")}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline text-text-muted">{t("errorCode")}: </dt>
                    <dd className="inline text-text-primary">
                      {code ? t(`errors.${code}`) : t("none")}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline text-text-muted">{t("attempts")}: </dt>
                    <dd className="inline text-text-primary">{a.totalAttempts}</dd>
                  </div>
                  <div>
                    <dt className="inline text-text-muted">{t("lastAttempt")}: </dt>
                    <dd className="inline text-text-primary">{date(a.lastAttemptAt)}</dd>
                  </div>
                  <div>
                    <dt className="inline text-text-muted">{t("nextRetry")}: </dt>
                    <dd className="inline text-text-primary">{date(a.nextRetryAt)}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="inline text-text-muted">{t("pending")}: </dt>
                    <dd className="inline text-text-primary">
                      {a.pendingStages.length === 0
                        ? t("none")
                        : a.pendingStages
                            .map((s) => {
                              const known = asStage(s);
                              return known ? t(`stages.${known}`) : s;
                            })
                            .join(", ")}
                    </dd>
                  </div>
                </dl>
                {canRetry(a) ? (
                  confirming === a.requestId ? (
                    <div
                      role="group"
                      aria-label={t("retry.confirmTitle")}
                      className="mt-3"
                    >
                      <p className="text-sm font-semibold">{t("retry.confirmTitle")}</p>
                      <p className="mt-1 text-sm text-text-secondary">
                        {t("retry.confirmBody")}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-3">
                        <button
                          type="button"
                          className={SECONDARY}
                          disabled={sending !== null}
                          onClick={() => void retry(a.requestId)}
                        >
                          {sending === a.requestId
                            ? t("retry.sending")
                            : t("retry.confirm")}
                        </button>
                        <button
                          type="button"
                          className={SECONDARY}
                          disabled={sending !== null}
                          onClick={() => setConfirming(null)}
                        >
                          {t("retry.cancel")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={`mt-3 ${SECONDARY}`}
                      disabled={sending !== null}
                      onClick={() => {
                        setNotice(null);
                        setConfirming(a.requestId);
                      }}
                    >
                      {t("retry.button")}
                    </button>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

export default function DeveloperAccountDeletionsSection() {
  return (
    <UpminaLocaleProvider>
      <DeletionAlerts />
    </UpminaLocaleProvider>
  );
}
