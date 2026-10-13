import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import {
  applyCopyrightStrike,
  fetchCopyrightStrikeState,
  resendCopyrightStrikeNotice,
} from "@/lib/copyright-client";
import {
  STRIKE_REASON_MAX,
  type CopyrightClaimDetail,
  type CopyrightStrikeBlocker,
  type CopyrightStrikeState,
} from "@/lib/copyright-contract";
import { ModerationClientError } from "@/lib/moderation-client";

// Strike MANUAL de Copyright (solo con la reclamación en `purged`). La interfaz solo refleja lo que el servidor calcula: el nivel, la
// elegibilidad y el estado del aviso salen de la base de datos, que repite todas las condiciones al confirmar. Nada se aplica solo ni
// al eliminar la publicación: es una decisión humana, independiente y con motivo obligatorio.

const buttonClass =
  "min-h-11 rounded-md border border-border-subtle px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary disabled:opacity-50";
const dangerClass =
  "min-h-11 rounded-md border border-accent-live px-4 py-2 text-sm font-semibold text-accent-live focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-live disabled:opacity-50";
const fieldClass =
  "mt-1 w-full rounded-md border border-border-subtle bg-bg-base px-3 py-2 text-text-primary outline-none focus:border-accent-secondary focus-visible:ring-2 focus-visible:ring-accent-secondary";

type ErrorKey =
  | "level_changed"
  | "strike_already_issued"
  | "claim_not_purged"
  | "author_unavailable"
  | "self_strike_forbidden"
  | "reason_required"
  | "generic";
const KNOWN_ERRORS: readonly string[] = [
  "level_changed",
  "strike_already_issued",
  "claim_not_purged",
  "author_unavailable",
  "self_strike_forbidden",
  "reason_required",
];
type Feedback =
  | { kind: "ok" | "warn"; key: "done" | "doneNoticeFailed" }
  | { kind: "error"; key: ErrorKey };
type Load =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; state: CopyrightStrikeState };

export default function CopyrightStrikeSection({
  claim,
  onChanged,
  onAccessError,
}: {
  claim: CopyrightClaimDetail;
  /** Recarga el detalle (el historial incluye el nuevo evento). */
  onChanged: () => Promise<void> | void;
  onAccessError: (err: unknown) => void;
}) {
  const t = useTranslations("moderation.copyright.panel.strike");
  const locale = useLocale();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const mounted = useRef(true);
  // Doble clic y reintentos: un único envío en vuelo, decidido sincrónicamente (el estado `busy` llega un render tarde).
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const state = await fetchCopyrightStrikeState(claim.id);
      if (mounted.current) setLoad({ kind: "ready", state });
    } catch (err) {
      if (!mounted.current) return;
      onAccessError(err);
      setLoad({ kind: "error" });
    }
  }, [claim.id, onAccessError]);

  // Al abrir otra reclamación se parte de cero.
  useEffect(() => {
    setLoad({ kind: "loading" });
    setConfirming(false);
    setReason("");
    setReasonError(false);
    setFeedback(null);
    void refresh();
  }, [claim.id, refresh]);
  useEffect(() => {
    if (confirming) heading.current?.focus();
  }, [confirming]);

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );

  async function submit(nextLevel: 1 | 2 | 3) {
    if (inFlight.current) return;
    const text = reason.trim();
    if (text.length === 0 || [...text].length > STRIKE_REASON_MAX) {
      setReasonError(true);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setReasonError(false);
    setFeedback(null);
    try {
      const result = await applyCopyrightStrike({
        id: claim.id,
        reason: text,
        expectedLevel: nextLevel,
      });
      if (!mounted.current) return;
      setConfirming(false);
      setReason("");
      setFeedback(
        result.notice === "sent"
          ? { kind: "ok", key: "done" }
          : { kind: "warn", key: "doneNoticeFailed" },
      );
      await refresh();
      await onChanged();
    } catch (err) {
      if (!mounted.current) return;
      onAccessError(err);
      const code = err instanceof ModerationClientError ? err.code : undefined;
      const key: ErrorKey =
        code && KNOWN_ERRORS.includes(code) ? (code as ErrorKey) : "generic";
      // El estado cambió mientras se confirmaba: se muestra de nuevo el estado real y hay que volver a confirmar.
      if (key === "level_changed" || key === "strike_already_issued") {
        setConfirming(false);
        await refresh();
      }
      setFeedback({ kind: "error", key });
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function resend() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      const out = await resendCopyrightStrikeNotice(claim.id);
      if (!mounted.current) return;
      setFeedback(
        out.notice === "sent"
          ? { kind: "ok", key: "done" }
          : { kind: "warn", key: "doneNoticeFailed" },
      );
      await refresh();
      await onChanged();
    } catch (err) {
      if (!mounted.current) return;
      onAccessError(err);
      setFeedback({ kind: "error", key: "generic" });
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const state = load.kind === "ready" ? load.state : null;
  const strike = state?.strike ?? null;

  return (
    <section
      aria-label={t("title")}
      className="flex min-w-0 flex-col gap-3 border-t border-border-subtle pt-4"
    >
      <h4 className="font-semibold">{t("title")}</h4>
      <p className="text-text-secondary">{t("intro")}</p>

      {load.kind === "loading" && <p role="status">{t("loading")}</p>}
      {load.kind === "error" && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-accent-live">
            {t("loadError")}
          </p>
          <button type="button" className={buttonClass} onClick={() => void refresh()}>
            {t("retry")}
          </button>
        </div>
      )}

      {strike && (
        <div className="flex min-w-0 flex-col gap-2">
          <h5 className="font-semibold">{t("applied.title")}</h5>
          <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
            <dt className="font-semibold">{t("applied.level")}</dt>
            <dd>
              {strike.level} / 3 · {t(`effect.${strike.level}`)}
            </dd>
            <dt className="font-semibold">{t("applied.starts")}</dt>
            <dd>{formatDate(strike.startsAt)}</dd>
            <dt className="font-semibold">{t("applied.ends")}</dt>
            <dd>
              {strike.permanent || !strike.endsAt
                ? t("applied.permanent")
                : formatDate(strike.endsAt)}
            </dd>
            <dt className="font-semibold">{t("applied.reason")}</dt>
            <dd className="whitespace-pre-wrap break-words">{strike.reason}</dd>
          </dl>
          {strike.revokedAt && (
            <p className="text-text-secondary">
              {t("applied.revoked", { date: formatDate(strike.revokedAt) })}
            </p>
          )}
          {state?.notice && (
            <div className="flex flex-wrap items-center gap-3">
              <p>
                <span className="font-semibold">{t("notice.title")}: </span>
                {state.notice.status === "failed"
                  ? t("notice.failed", { error: state.notice.error ?? "-" })
                  : t(`notice.${state.notice.status}`)}
              </p>
              {state.notice.status !== "sent" && (
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => void resend()}
                >
                  {busy ? t("notice.resending") : t("notice.resend")}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {state && !strike && !state.eligible && state.blocker && (
        <p className="text-text-secondary">
          {t(`blockers.${state.blocker satisfies CopyrightStrikeBlocker}`)}
        </p>
      )}

      {state && !strike && state.eligible && state.nextLevel && !confirming && (
        <div>
          <button
            type="button"
            className={dangerClass}
            disabled={busy}
            onClick={() => {
              setFeedback(null);
              setConfirming(true);
            }}
          >
            {t("apply")}
          </button>
        </div>
      )}

      {state && !strike && state.eligible && state.nextLevel && confirming && (
        <div
          role="group"
          aria-labelledby="copyright-strike-confirm-title"
          className="rounded-md border border-accent-live p-4"
        >
          <h5
            id="copyright-strike-confirm-title"
            ref={heading}
            tabIndex={-1}
            className="font-semibold outline-none"
          >
            {t("confirm.title")}
          </h5>
          <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
            <dt className="font-semibold">{t("confirm.reference")}</dt>
            <dd className="font-mono">{claim.reference}</dd>
            <dt className="font-semibold">{t("confirm.level")}</dt>
            <dd>
              {state.nextLevel} / 3 · {t(`effect.${state.nextLevel}`)}
            </dd>
          </dl>
          <label htmlFor="copyright-strike-reason" className="mt-3 block font-semibold">
            {t("confirm.reasonLabel")}
          </label>
          <textarea
            id="copyright-strike-reason"
            rows={3}
            maxLength={STRIKE_REASON_MAX}
            value={reason}
            disabled={busy}
            aria-invalid={reasonError}
            aria-describedby="copyright-strike-reason-help"
            onChange={(event) => {
              setReason(event.target.value);
              setReasonError(false);
            }}
            className={fieldClass}
          />
          <p
            id="copyright-strike-reason-help"
            className={`mt-1 text-xs ${reasonError ? "text-accent-live" : "text-text-secondary"}`}
          >
            {reasonError ? t("confirm.reasonError") : t("confirm.reasonHelp")}
          </p>
          <p className="mt-2 text-text-secondary">{t("confirm.irreversible")}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              className={dangerClass}
              disabled={busy}
              onClick={() => void submit(state.nextLevel!)}
            >
              {busy ? t("confirm.working") : t("confirm.submit")}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                setReason("");
                setReasonError(false);
              }}
            >
              {t("confirm.cancel")}
            </button>
          </div>
        </div>
      )}

      {feedback?.kind === "ok" && (
        <p role="status" className="text-sm">
          {t(feedback.key)}
        </p>
      )}
      {feedback?.kind === "warn" && (
        <p role="status" className="text-sm text-accent-live">
          {t(feedback.key)}
        </p>
      )}
      {feedback?.kind === "error" && (
        <p role="alert" className="text-sm text-accent-live">
          {t(`errors.${feedback.key}`)}
        </p>
      )}
    </section>
  );
}
