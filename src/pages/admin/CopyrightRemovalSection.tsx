import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import {
  purgeCopyrightClaim,
  removeCopyrightClaim,
  resendCopyrightNotice,
  resolveCopyrightAppeal,
} from "@/lib/copyright-client";
import { validateRemovalReason } from "@/lib/copyright-appeal";
import { validateReviewNote } from "@/lib/copyright-claim";
import type {
  CopyrightActionResult,
  CopyrightClaimDetail,
  CopyrightNoticeKind,
} from "@/lib/copyright-contract";
import { ModerationClientError } from "@/lib/moderation-client";

// Retirada, apelación, restauración y eliminación manual dentro del detalle de una reclamación (COPY-1 fase 2B). La interfaz solo
// REFLEJA las condiciones: el servidor y la RPC las repiten en cada acción. Cada decisión es humana y pide una segunda confirmación
// que muestra la publicación y el motivo. Nada se elimina por vencimiento ni por proceso automático.

const buttonClass =
  "min-h-11 rounded-md border border-border-subtle px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary disabled:opacity-50";
const dangerClass =
  "min-h-11 rounded-md border border-accent-live px-4 py-2 text-sm font-semibold text-accent-live focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-live disabled:opacity-50";
const fieldClass =
  "mt-1 w-full rounded-md border border-border-subtle bg-bg-base px-3 py-2 text-text-primary outline-none focus:border-accent-secondary focus-visible:ring-2 focus-visible:ring-accent-secondary";

type ErrorKey =
  | "note_required"
  | "invalid_reason"
  | "invalid_note"
  | "version_conflict"
  | "invalid_transition"
  | "confirmation_mismatch"
  | "post_state_conflict"
  | "post_version_conflict"
  | "post_not_found"
  | "restore_unsafe"
  | "purge_blocked"
  | "generic";
const KNOWN_ERRORS: readonly ErrorKey[] = [
  "note_required",
  "invalid_reason",
  "invalid_note",
  "version_conflict",
  "invalid_transition",
  "confirmation_mismatch",
  "post_state_conflict",
  "post_version_conflict",
  "post_not_found",
  "restore_unsafe",
  "purge_blocked",
];
type Feedback =
  | { kind: "ok"; message: string }
  | { kind: "warn"; message: string }
  | { kind: "error"; key: ErrorKey };

export default function CopyrightRemovalSection({
  claim,
  onChanged,
  onAccessError,
}: {
  claim: CopyrightClaimDetail;
  /** Recarga el detalle y las colas tras una acción (o tras un conflicto de versión). */
  onChanged: () => Promise<void> | void;
  onAccessError: (err: unknown) => void;
}) {
  const t = useTranslations("moderation.copyright.panel.removal");
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState(false);
  const [resolveNote, setResolveNote] = useState("");
  const [purgeNote, setPurgeNote] = useState("");
  const [confirming, setConfirming] = useState<"remove" | "purge" | null>(null);
  const confirmHeading = useRef<HTMLHeadingElement | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (confirming) confirmHeading.current?.focus();
  }, [confirming]);
  // Al abrir otra reclamación se parte de cero.
  useEffect(() => {
    setConfirming(null);
    setFeedback(null);
    setReason("");
    setReasonError(false);
    setResolveNote("");
    setPurgeNote("");
  }, [claim.id]);

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );
  const removal = claim.removal;
  const post = claim.currentPost;

  async function run(
    action: () => Promise<CopyrightActionResult>,
    done: (result: CopyrightActionResult) => Feedback,
  ) {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await action();
      if (!mounted.current) return;
      setConfirming(null);
      setFeedback(done(result));
      await onChanged();
    } catch (err) {
      if (!mounted.current) return;
      onAccessError(err);
      const code = err instanceof ModerationClientError ? err.code : undefined;
      const key = (KNOWN_ERRORS as readonly (string | undefined)[]).includes(code)
        ? (code as ErrorKey)
        : "generic";
      if (key === "version_conflict" || key === "post_version_conflict") {
        setConfirming(null);
        await onChanged();
      }
      setFeedback({ kind: "error", key });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const noticeFeedback = (
    result: CopyrightActionResult,
    okKey:
      "remove.done" | "notice.resent" | "appeal.acceptedDone" | "appeal.rejectedDone",
  ): Feedback =>
    result.notice === "failed"
      ? {
          kind: "warn",
          message: t("notice.failedNow", {
            error: t(`noticeErrors.${result.noticeError ?? "provider_unavailable"}`),
          }),
        }
      : { kind: "ok", message: t(okKey) };

  const startRemoval = () => {
    const checked = validateRemovalReason(reason);
    if (!checked.ok) {
      setReasonError(true);
      return;
    }
    setReasonError(false);
    setFeedback(null);
    setConfirming("remove");
  };
  const confirmRemoval = () => {
    if (!post) return;
    const checked = validateRemovalReason(reason);
    if (!checked.ok) return;
    void run(
      () =>
        removeCopyrightClaim({
          id: claim.id,
          expectedVersion: claim.version,
          expectedPostVersion: post.version,
          confirmReference: claim.reference,
          reason: checked.reason,
        }),
      (result) => noticeFeedback(result, "remove.done"),
    );
  };
  const resolve = (decision: "accept" | "reject") => {
    const checked = validateReviewNote(resolveNote);
    if (resolveNote.trim() === "")
      return setFeedback({ kind: "error", key: "note_required" });
    if (!checked.ok) return setFeedback({ kind: "error", key: "invalid_note" });
    void run(
      () =>
        resolveCopyrightAppeal({
          id: claim.id,
          expectedVersion: claim.version,
          decision,
          note: checked.note,
        }),
      (result) =>
        noticeFeedback(
          result,
          decision === "accept" ? "appeal.acceptedDone" : "appeal.rejectedDone",
        ),
    );
    setResolveNote("");
  };
  const resend = (kind: CopyrightNoticeKind) =>
    void run(
      () => resendCopyrightNotice({ id: claim.id, kind }),
      (result) => noticeFeedback(result, "notice.resent"),
    );
  const confirmPurge = () => {
    if (purgeNote.trim() === "")
      return setFeedback({ kind: "error", key: "note_required" });
    const checked = validateReviewNote(purgeNote);
    if (!checked.ok) return setFeedback({ kind: "error", key: "invalid_note" });
    void run(
      () =>
        purgeCopyrightClaim({
          id: claim.id,
          expectedVersion: claim.version,
          confirmReference: claim.reference,
          note: checked.note,
        }),
      (result) => ({
        kind: "ok",
        message: t("purge.done", {
          marked: result.assetsMarked ?? 0,
          retained: result.assetsRetained ?? 0,
        }),
      }),
    );
    setPurgeNote("");
  };

  const windowLabel = (minutes: 60 | 1440) => t(`window.m${minutes}`);

  // ------------------------------------------------------------------------------------------------------------ retirar
  const canRemoveSection = claim.status === "in_review";
  let removeBlockedKey: "noPost" | "notPublished" | null = null;
  if (canRemoveSection) {
    if (!claim.postId || !post) removeBlockedKey = "noPost";
    else if (post.status !== "published") removeBlockedKey = "notPublished";
  }

  const confirmPanel = (
    title: string,
    body: React.ReactNode,
    actions: React.ReactNode,
  ) => (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="copyright-confirm-title"
      className="mt-3 rounded-md border border-accent-live p-4"
    >
      <h5
        id="copyright-confirm-title"
        ref={confirmHeading}
        tabIndex={-1}
        className="font-semibold outline-none"
      >
        {title}
      </h5>
      {body}
      <div className="mt-3 flex flex-wrap gap-3">{actions}</div>
    </div>
  );

  const postPreview = post ? (
    <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
      <dt className="font-semibold">{t("confirm.reference")}</dt>
      <dd className="font-mono">{claim.reference}</dd>
      <dt className="font-semibold">{t("confirm.post")}</dt>
      <dd className="whitespace-pre-wrap break-words">
        {post.text || t("confirm.noText")}
      </dd>
      <dt className="font-semibold">{t("confirm.details")}</dt>
      <dd>
        {t("confirm.media", { count: post.mediaCount })} ·{" "}
        {t("confirm.version", { version: post.version })} · {post.status}
      </dd>
    </dl>
  ) : null;

  const showRemovalInfo = removal !== null;

  return (
    <div className="flex min-w-0 flex-col gap-4 border-t border-border-subtle pt-4">
      <h4 className="font-semibold">{t("title")}</h4>

      {canRemoveSection && (
        <div>
          <p className="text-text-secondary">{t("remove.intro")}</p>
          {removeBlockedKey ? (
            <p className="mt-2 text-text-secondary">
              {removeBlockedKey === "notPublished"
                ? t("remove.notPublished", { status: post?.status ?? "" })
                : t("remove.noPost")}
            </p>
          ) : (
            <>
              <label
                htmlFor="copyright-removal-reason"
                className="mt-2 block font-semibold"
              >
                {t("remove.reasonLabel")}
              </label>
              <textarea
                id="copyright-removal-reason"
                rows={3}
                maxLength={1200}
                value={reason}
                disabled={busy || confirming === "remove"}
                aria-invalid={reasonError}
                aria-describedby="copyright-removal-reason-help"
                onChange={(event) => {
                  setReason(event.target.value);
                  setReasonError(false);
                }}
                className={fieldClass}
              />
              <p
                id="copyright-removal-reason-help"
                className={`mt-1 text-xs ${reasonError ? "text-accent-live" : "text-text-secondary"}`}
              >
                {t("remove.reasonHelp")}
              </p>
              {confirming !== "remove" && (
                <button
                  type="button"
                  className={`${buttonClass} mt-3`}
                  disabled={busy}
                  onClick={startRemoval}
                >
                  {t("remove.review")}
                </button>
              )}
              {confirming === "remove" &&
                confirmPanel(
                  t("confirm.removeTitle"),
                  <>
                    {postPreview}
                    <p className="mt-2 font-semibold">{t("confirm.reason")}</p>
                    <p className="whitespace-pre-wrap break-words">{reason.trim()}</p>
                    <p className="mt-2 text-text-secondary">
                      {t("confirm.removeWarning")}
                    </p>
                  </>,
                  <>
                    <button
                      type="button"
                      className={dangerClass}
                      disabled={busy}
                      onClick={confirmRemoval}
                    >
                      {busy ? t("working") : t("confirm.removeConfirm")}
                    </button>
                    <button
                      type="button"
                      className={buttonClass}
                      disabled={busy}
                      onClick={() => setConfirming(null)}
                    >
                      {t("confirm.cancel")}
                    </button>
                  </>,
                )}
            </>
          )}
        </div>
      )}

      {showRemovalInfo && removal && (
        <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr]">
          <dt className="font-semibold">{t("info.removedAt")}</dt>
          <dd>{formatDate(removal.removedAt)}</dd>
          <dt className="font-semibold">{t("info.reason")}</dt>
          <dd className="whitespace-pre-wrap break-words">{removal.reason}</dd>
          <dt className="font-semibold">{t("info.currentPost")}</dt>
          <dd>{post ? post.status : t("info.postGone")}</dd>
          <dt className="font-semibold">{t("info.notice")}</dt>
          <dd>
            {removal.notifiedAt
              ? t("info.noticeSent", { date: formatDate(removal.notifiedAt) })
              : t("info.noticePending")}
            {!removal.notifiedAt && removal.notifyAttempts > 0 && (
              <>
                {" "}
                · {t("info.attempts", { count: removal.notifyAttempts })}
                {removal.notifyLastError
                  ? ` · ${t("info.lastError", { error: t(`noticeErrors.${removal.notifyLastError}`) })}`
                  : ""}
              </>
            )}
          </dd>
          <dt className="font-semibold">{t("info.window")}</dt>
          <dd>{windowLabel(removal.windowMinutes)}</dd>
          <dt className="font-semibold">{t("info.deadline")}</dt>
          <dd>
            {removal.appealDeadline
              ? formatDate(removal.appealDeadline)
              : t("info.deadlinePending")}
          </dd>
        </dl>
      )}

      {removal && claim.status === "removed" && !removal.notifiedAt && (
        <div>
          <p role="status" className="text-accent-live">
            {t("notice.initialPending")}
          </p>
          <button
            type="button"
            className={`${buttonClass} mt-2`}
            disabled={busy}
            onClick={() => resend("removal")}
          >
            {t("notice.resendInitial")}
          </button>
        </div>
      )}

      {removal?.resolutionNoticePending &&
        claim.appeal &&
        claim.appeal.status !== "pending" && (
          <div>
            <p role="status" className="text-accent-live">
              {t("notice.resolutionPending")}
            </p>
            <button
              type="button"
              className={`${buttonClass} mt-2`}
              disabled={busy}
              onClick={() =>
                resend(
                  claim.appeal!.status === "accepted"
                    ? "appeal_accepted"
                    : "appeal_rejected",
                )
              }
            >
              {t("notice.resendResolution")}
            </button>
          </div>
        )}
      {removal && !removal.resolutionNoticePending && removal.resolutionNotifiedAt && (
        <p className="text-text-secondary">
          {t("notice.resolutionSent", { date: formatDate(removal.resolutionNotifiedAt) })}
        </p>
      )}

      {claim.appeal && (
        <div>
          <h5 className="font-semibold">{t("appeal.title")}</h5>
          <dl className="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr]">
            <dt className="font-semibold">{t("appeal.status")}</dt>
            <dd>{t(`appeal.statuses.${claim.appeal.status}`)}</dd>
            <dt className="font-semibold">{t("appeal.submittedAt")}</dt>
            <dd>{formatDate(claim.appeal.createdAt)}</dd>
            <dt className="font-semibold">{t("appeal.contact")}</dt>
            <dd className="break-all">
              {claim.appeal.contactName} · {claim.appeal.contactEmail}
            </dd>
            <dt className="font-semibold">{t("appeal.reason")}</dt>
            <dd>{t(`appeal.reasons.${claim.appeal.reason}`)}</dd>
            <dt className="font-semibold">{t("appeal.explanation")}</dt>
            <dd className="whitespace-pre-wrap break-words">
              {claim.appeal.explanation}
            </dd>
            {claim.appeal.evidenceText && (
              <>
                <dt className="font-semibold">{t("appeal.evidenceText")}</dt>
                <dd className="whitespace-pre-wrap break-words">
                  {claim.appeal.evidenceText}
                </dd>
              </>
            )}
            {claim.appeal.evidenceUrls.length > 0 && (
              <>
                <dt className="font-semibold">{t("appeal.evidenceUrls")}</dt>
                <dd>
                  <ul className="flex flex-col gap-1">
                    {claim.appeal.evidenceUrls.map((url) => (
                      <li key={url} className="break-all">
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          className="text-accent-primary hover:underline"
                        >
                          {url}
                        </a>
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {claim.appeal.resolvedAt && (
              <>
                <dt className="font-semibold">{t("appeal.resolvedAt")}</dt>
                <dd>{formatDate(claim.appeal.resolvedAt)}</dd>
                <dt className="font-semibold">{t("appeal.resolutionNote")}</dt>
                <dd className="whitespace-pre-wrap break-words">
                  {claim.appeal.resolutionNote}
                </dd>
              </>
            )}
          </dl>
          {claim.status === "appeal_pending" && claim.appeal.status === "pending" && (
            <div className="mt-3">
              <label htmlFor="copyright-appeal-note" className="block font-semibold">
                {t("appeal.noteLabel")}
              </label>
              <textarea
                id="copyright-appeal-note"
                rows={3}
                maxLength={1200}
                value={resolveNote}
                disabled={busy}
                aria-describedby="copyright-appeal-note-help"
                onChange={(event) => setResolveNote(event.target.value)}
                className={fieldClass}
              />
              <p
                id="copyright-appeal-note-help"
                className="mt-1 text-xs text-text-secondary"
              >
                {t("appeal.noteHelp")}
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => resolve("accept")}
                >
                  {t("appeal.accept")}
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => resolve("reject")}
                >
                  {t("appeal.reject")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {removal && (claim.status === "removed" || claim.status === "appeal_pending") && (
        <div>
          <h5 className="font-semibold">{t("purge.title")}</h5>
          <p className="mt-1 text-text-secondary">{t("purge.intro")}</p>
          {removal.purgeBlockers.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-text-secondary">
              {removal.purgeBlockers.map((blocker) => (
                <li key={blocker}>{t(`purge.blockers.${blocker}`)}</li>
              ))}
            </ul>
          )}
          {confirming !== "purge" && (
            <button
              type="button"
              className={`${dangerClass} mt-3`}
              disabled={busy || removal.purgeBlockers.length > 0}
              onClick={() => {
                setFeedback(null);
                setConfirming("purge");
              }}
            >
              {t("purge.button")}
            </button>
          )}
          {confirming === "purge" &&
            confirmPanel(
              t("confirm.purgeTitle"),
              <>
                {postPreview}
                <p className="mt-2 font-semibold">{t("confirm.reason")}</p>
                <p className="whitespace-pre-wrap break-words">{removal.reason}</p>
                <p className="mt-2 text-text-secondary">{t("confirm.purgeWarning")}</p>
                <label
                  htmlFor="copyright-purge-note"
                  className="mt-3 block font-semibold"
                >
                  {t("purge.noteLabel")}
                </label>
                <textarea
                  id="copyright-purge-note"
                  rows={2}
                  maxLength={1200}
                  value={purgeNote}
                  disabled={busy}
                  onChange={(event) => setPurgeNote(event.target.value)}
                  className={fieldClass}
                />
              </>,
              <>
                <button
                  type="button"
                  className={dangerClass}
                  disabled={busy}
                  onClick={confirmPurge}
                >
                  {busy ? t("working") : t("confirm.purgeConfirm")}
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => setConfirming(null)}
                >
                  {t("confirm.cancel")}
                </button>
              </>,
            )}
        </div>
      )}

      {removal && claim.status === "restored" && removal.restoredAt && (
        <p className="text-text-secondary">
          {t("closed.restored", { date: formatDate(removal.restoredAt) })}
        </p>
      )}
      {removal && claim.status === "purged" && removal.purgedAt && (
        <div className="text-text-secondary">
          <p>{t("closed.purged", { date: formatDate(removal.purgedAt) })}</p>
          {removal.purgeAssetsPending !== null && (
            <p className="mt-1">
              {removal.purgeAssetsPending > 0
                ? t("purge.assetsPending", { count: removal.purgeAssetsPending })
                : t("purge.assetsDone")}
            </p>
          )}
        </div>
      )}

      {feedback?.kind === "ok" && (
        <p role="status" className="text-sm">
          {feedback.message}
        </p>
      )}
      {feedback?.kind === "warn" && (
        <p role="alert" className="text-sm text-accent-live">
          {feedback.message}
        </p>
      )}
      {feedback?.kind === "error" && (
        <p role="alert" className="text-sm text-accent-live">
          {t(`errors.${feedback.key}`)}
        </p>
      )}
    </div>
  );
}
