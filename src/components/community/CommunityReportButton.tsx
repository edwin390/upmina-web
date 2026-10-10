import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import UpminaLocaleProvider from "@/i18n/LocaleProvider";
import { useAuth } from "@/lib/auth-context";
import {
  accountIncompleteReason,
  type AccountIncompleteReason,
} from "@/lib/account-incomplete";
import {
  REPORT_DETAIL_MAX,
  REPORT_REASONS,
  reportDetailLength,
  validateReportForm,
  type ReportFormError,
} from "@/lib/community-report";
import { submitCommunityReport } from "@/lib/moderation-client";
import AccountIncompleteNotice from "./AccountIncompleteNotice";

// REP-1: botón discreto de "Reportar" + diálogo accesible. Reutiliza submitCommunityReport (cliente)
// y moderation-report-create (servidor); no decide nada: el servidor valida sesión, motivo, post y
// permisos. El diálogo solo se monta al abrirse, así el botón es barato en cada tarjeta del feed.

const LOGIN_PATH = "/login?returnTo=/community";

type ErrorKey =
  | ReportFormError
  | "selfReport"
  | "notFound"
  | "notReportable"
  | "unauthenticated"
  | "generic";

const SERVER_ERRORS: Record<string, ErrorKey> = {
  self_report: "selfReport",
  post_not_found: "notFound",
  post_not_reportable: "notReportable",
  unauthenticated: "unauthenticated",
};

function FlagIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 21V4m0 0h11l-2 4 2 4H5" />
    </svg>
  );
}

const FOCUSABLE =
  "button:not([disabled]), textarea:not([disabled]), input:not([disabled]), a[href]";

function ReportDialog({
  postId,
  onClose,
  onReported,
}: {
  postId: string;
  onClose: () => void;
  onReported: () => void;
}) {
  const t = useTranslations("moderation.report");
  const queryClient = useQueryClient();
  const panelRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const [reason, setReason] = useState<string | null>(null);
  const [detail, setDetail] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [incomplete, setIncomplete] = useState<AccountIncompleteReason | null>(null);
  const [done, setDone] = useState<"sent" | "already" | null>(null);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('input[type="radio"]')?.focus();
  }, []);

  // Tras el éxito el foco pasa al botón de cierre.
  useEffect(() => {
    if (done) panelRef.current?.querySelector<HTMLElement>("[data-close]")?.focus();
  }, [done]);

  const requestClose = useCallback(() => {
    if (!sendingRef.current) onClose();
  }, [onClose]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      requestClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    );
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (sendingRef.current || done) return; // sin envíos duplicados
    const checked = validateReportForm(reason, detail);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setError(null);
    setIncomplete(null);
    try {
      const result = await submitCommunityReport(
        queryClient,
        postId,
        checked.reason,
        checked.detail,
      );
      onReported();
      setDone(result.alreadyReported ? "already" : "sent");
    } catch (err) {
      const status = (err as { status?: number }).status;
      const code = (err as { code?: string }).code;
      const reasonIncomplete = accountIncompleteReason(err);
      if (reasonIncomplete) setIncomplete(reasonIncomplete);
      else if (code && SERVER_ERRORS[code]) setError(SERVER_ERRORS[code]!);
      else if (status === 401) setError("unauthenticated");
      else setError("generic");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  const count = reportDetailLength(detail);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-bg-base/80 px-4 py-8 backdrop-blur-sm sm:items-center"
      onClick={requestClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="community-report-title"
        onKeyDown={onKeyDown}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-border-subtle bg-bg-surface p-5"
      >
        <h2
          id="community-report-title"
          className="font-display text-lg tracking-wide text-text-primary"
        >
          {done ? t("successTitle") : t("title")}
        </h2>

        {done ? (
          <div className="mt-3">
            <p role="status" className="text-sm text-text-secondary">
              {done === "already" ? t("successAlready") : t("successBody")}
            </p>
            <button
              type="button"
              data-close
              onClick={onClose}
              className="mt-4 inline-flex min-h-11 items-center rounded-md border border-border-subtle px-4 text-sm font-semibold text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
            >
              {t("close")}
            </button>
          </div>
        ) : (
          <form onSubmit={(e) => void onSubmit(e)} noValidate className="mt-3">
            <p className="text-sm text-text-secondary">{t("intro")}</p>
            <fieldset className="mt-4" disabled={sending}>
              <legend className="text-sm font-semibold text-text-primary">
                {t("reasonLegend")}
              </legend>
              {REPORT_REASONS.map((value) => (
                <label
                  key={value}
                  className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-text-primary"
                >
                  <input
                    type="radio"
                    name="community-report-reason"
                    value={value}
                    checked={reason === value}
                    onChange={() => setReason(value)}
                    aria-describedby={
                      error === "reasonRequired" ? "community-report-error" : undefined
                    }
                    className="h-4 w-4"
                  />
                  {t(`reasons.${value}`)}
                </label>
              ))}
            </fieldset>
            <p className="mt-1 text-xs text-text-secondary">{t("copyrightNote")}</p>

            <label
              htmlFor="community-report-detail"
              className="mt-4 block text-sm font-semibold text-text-primary"
            >
              {t("detailLabel")}
            </label>
            <textarea
              id="community-report-detail"
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              disabled={sending}
              rows={4}
              aria-describedby="community-report-detail-help"
              aria-invalid={error === "detailTooLong" || error === "detailInvalid"}
              className="mt-1 w-full rounded-md border border-border-subtle bg-bg-elevated px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
            />
            <p
              id="community-report-detail-help"
              className="mt-1 flex justify-between gap-3 text-xs text-text-secondary"
            >
              <span>{t("detailHelp")}</span>
              <span>{t("counter", { count, max: REPORT_DETAIL_MAX })}</span>
            </p>

            {error ? (
              <p
                id="community-report-error"
                role="alert"
                className="mt-3 text-sm text-accent-live"
              >
                {t(`errors.${error}`, { max: REPORT_DETAIL_MAX })}
              </p>
            ) : null}
            {incomplete ? <AccountIncompleteNotice reason={incomplete} /> : null}

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={requestClose}
                disabled={sending}
                className="inline-flex min-h-11 items-center rounded-md border border-border-subtle px-4 text-sm font-semibold text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
              >
                {t("cancel")}
              </button>
              <button
                type="submit"
                disabled={sending}
                aria-busy={sending}
                className="inline-flex min-h-11 items-center rounded-md border border-accent-primary/60 bg-accent-primary px-4 text-sm font-bold text-text-inverse hover:bg-accent-secondary disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
              >
                {sending ? t("sending") : t("submit")}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function ReportButtonInner({ postId }: { postId: string }) {
  const t = useTranslations("moderation.report");
  const { session } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [reported, setReported] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    // devuelve el foco al disparador (tras desmontar el diálogo)
    queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          if (!session) {
            navigate(LOGIN_PATH);
            return;
          }
          setOpen(true);
        }}
        disabled={reported}
        aria-haspopup="dialog"
        aria-label={reported ? t("reported") : t("triggerLabel")}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary"
      >
        <FlagIcon />
        <span className="hidden sm:inline">
          {reported ? t("reported") : t("trigger")}
        </span>
      </button>
      {open ? (
        <ReportDialog
          postId={postId}
          onClose={close}
          onReported={() => setReported(true)}
        />
      ) : null}
    </>
  );
}

export default function CommunityReportButton({ postId }: { postId: string }) {
  return (
    <UpminaLocaleProvider>
      <ReportButtonInner postId={postId} />
    </UpminaLocaleProvider>
  );
}
