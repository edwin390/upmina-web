import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import {
  fetchCopyrightClaim,
  fetchCopyrightClaimPage,
  reviewCopyrightClaim,
} from "@/lib/copyright-client";
import {
  ACTIONS_BY_STATUS,
  NOTE_REQUIRED_ACTIONS,
  type CopyrightClaimDetail,
  type CopyrightClaimScope,
  type CopyrightClaimSummary,
  type CopyrightReviewAction,
} from "@/lib/copyright-contract";
import { ModerationClientError } from "@/lib/moderation-client";
import { validateReviewNote } from "@/lib/copyright-claim";
import CopyrightRemovalSection from "./CopyrightRemovalSection";
import CopyrightStrikeSection from "./CopyrightStrikeSection";

// Pestaña «Copyright» de /admin/moderation (COPY-1 fase 2A). Cola y detalle SEPARADOS de los reportes ordinarios. Revisar solo
// cambia el estado de la RECLAMACIÓN y deja constancia en el historial general de moderación: no oculta ni retira publicaciones
// (eso pertenece a la fase 2B). El acceso (capacidad `moderation` + MFA reciente) lo comprueba el servidor en cada llamada.

const buttonClass =
  "min-h-11 rounded-md border border-border-subtle px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary disabled:opacity-50";
const topButtonClass =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-4 py-2 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth enabled:hover:border-accent-primary/60 enabled:hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none";

type ReviewErrorKey =
  | "note_required"
  | "invalid_note"
  | "version_conflict"
  | "invalid_transition"
  | "generic";
type ListState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; claims: CopyrightClaimSummary[]; nextCursor: string | null };
type DetailState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; claim: CopyrightClaimDetail };

export default function CopyrightClaimsPanel({
  onAccessError,
}: {
  onAccessError: (err: unknown) => void;
}) {
  const t = useTranslations("moderation.copyright.panel");
  const locale = useLocale();
  const [scope, setScope] = useState<CopyrightClaimScope>("open");
  const [cursor, setCursor] = useState<string | null>(null);
  const [trail, setTrail] = useState<(string | null)[]>([]);
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<
    { kind: "ok" } | { kind: "error"; key: ReviewErrorKey } | null
  >(null);
  const listRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      listRequest.current?.abort();
      detailRequest.current?.abort();
    };
  }, []);

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );

  const loadList = useCallback(async () => {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    setList({ kind: "loading" });
    try {
      const page = await fetchCopyrightClaimPage(scope, cursor, controller.signal);
      if (controller.signal.aborted || !mounted.current) return;
      setList({ kind: "ready", claims: page.claims, nextCursor: page.nextCursor });
    } catch (err) {
      if (controller.signal.aborted || !mounted.current) return;
      onAccessError(err);
      setList({ kind: "error" });
    }
  }, [scope, cursor, onAccessError]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openClaim = useCallback(
    async (id: string) => {
      detailRequest.current?.abort();
      const controller = new AbortController();
      detailRequest.current = controller;
      setSelectedId(id);
      setDetail({ kind: "loading" });
      try {
        const claim = await fetchCopyrightClaim(id, controller.signal);
        if (controller.signal.aborted || !mounted.current) return;
        setDetail({ kind: "ready", claim });
      } catch (err) {
        if (controller.signal.aborted || !mounted.current) return;
        onAccessError(err);
        setDetail({ kind: "error" });
      }
    },
    [onAccessError],
  );

  /** Recarga el detalle SIN pasar por «cargando»: la sección de retirada conserva su estado y su mensaje. */
  const refreshClaim = useCallback(
    async (id: string) => {
      try {
        const claim = await fetchCopyrightClaim(id);
        if (mounted.current) setDetail({ kind: "ready", claim });
      } catch (err) {
        if (mounted.current) onAccessError(err);
      }
    },
    [onAccessError],
  );

  const closeDetail = () => {
    detailRequest.current?.abort();
    setSelectedId(null);
    setDetail(null);
    setNote("");
    setFeedback(null);
    opener.current?.focus();
  };

  async function runAction(claim: CopyrightClaimDetail, action: CopyrightReviewAction) {
    if (saving) return;
    setFeedback(null);
    let cleanNote: string | undefined;
    if (note.trim() !== "") {
      const checked = validateReviewNote(note);
      if (!checked.ok) return setFeedback({ kind: "error", key: "invalid_note" });
      cleanNote = checked.note;
    } else if (NOTE_REQUIRED_ACTIONS.includes(action)) {
      return setFeedback({ kind: "error", key: "note_required" });
    }
    setSaving(true);
    try {
      await reviewCopyrightClaim({
        id: claim.id,
        action,
        expectedVersion: claim.version,
        note: cleanNote,
      });
      if (!mounted.current) return;
      setNote("");
      setFeedback({ kind: "ok" });
      await Promise.all([openClaim(claim.id), loadList()]);
    } catch (err) {
      if (!mounted.current) return;
      onAccessError(err);
      const code = err instanceof ModerationClientError ? err.code : undefined;
      if (code === "version_conflict") await openClaim(claim.id);
      setFeedback({
        kind: "error",
        key:
          code === "note_required" ||
          code === "version_conflict" ||
          code === "invalid_transition" ||
          code === "invalid_note"
            ? code
            : "generic",
      });
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  const changeScope = (next: CopyrightClaimScope) => {
    if (next === scope) return;
    closeDetail();
    setCursor(null);
    setTrail([]);
    setScope(next);
  };

  const claim = detail?.kind === "ready" ? detail.claim : null;
  const allowed = claim ? ACTIONS_BY_STATUS[claim.status] : [];

  // El detalle se pinta DENTRO del <li> de la reclamación abierta (justo debajo de ella). Solo si esa reclamación ya no está en la
  // página actual (p. ej. tras paginar) se conserva como panel independiente al final, sin duplicarlo.
  const selectedInList =
    list.kind === "ready" && list.claims.some((item) => item.id === selectedId);
  const detailSection = detail ? (
    <section
      id="copyright-claim-detail"
      aria-label={t("detail.title")}
      className="mt-4 rounded-md border border-border-subtle p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-xl">{t("detail.title")}</h3>
        <button type="button" className={buttonClass} onClick={closeDetail}>
          {t("detail.close")}
        </button>
      </div>
      {detail.kind === "loading" && <p role="status">{t("detail.loading")}</p>}
      {detail.kind === "error" && <p role="alert">{t("detail.loadError")}</p>}
      {claim && (
        <div className="mt-3 flex min-w-0 flex-col gap-3 text-sm">
          <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr]">
            <dt className="font-semibold">{t("detail.fields.claimant")}</dt>
            <dd>
              {claim.claimantName} · {t(`status.${claim.status}`)} ·{" "}
              <span className="font-mono">{claim.reference}</span>
            </dd>
            <dt className="font-semibold">{t("detail.fields.email")}</dt>
            <dd className="break-all">{claim.claimantEmail}</dd>
            {claim.organization && (
              <>
                <dt className="font-semibold">{t("detail.fields.organization")}</dt>
                <dd>{claim.organization}</dd>
              </>
            )}
            <dt className="font-semibold">{t("detail.fields.relationship")}</dt>
            <dd>{t(`relationship.${claim.relationship}`)}</dd>
            <dt className="font-semibold">{t("detail.fields.received")}</dt>
            <dd>{formatDate(claim.createdAt)}</dd>
            <dt className="font-semibold">{t("detail.fields.work")}</dt>
            <dd className="whitespace-pre-wrap break-words">{claim.workDescription}</dd>
            <dt className="font-semibold">{t("detail.fields.infringement")}</dt>
            <dd className="whitespace-pre-wrap break-words">
              {claim.infringementDescription}
            </dd>
            <dt className="font-semibold">{t("detail.fields.evidence")}</dt>
            <dd>
              <ul className="flex flex-col gap-1">
                {claim.evidenceUrls.map((url) => (
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
            <dt className="font-semibold">{t("detail.fields.claimedPost")}</dt>
            <dd className="break-all">{claim.claimedPostUrl}</dd>
            <dt className="font-semibold">{t("detail.fields.currentStatus")}</dt>
            <dd>
              {claim.postFound
                ? (claim.currentPostStatus ?? t("detail.fields.postGone"))
                : t("postFound.no")}
            </dd>
            <dt className="font-semibold">{t("detail.fields.snapshot")}</dt>
            <dd className="whitespace-pre-wrap break-words">
              {claim.postTextSnapshot || t("detail.fields.snapshotEmpty")}
            </dd>
            {claim.postMediaCount !== null && (
              <>
                <dt className="font-semibold">{t("detail.fields.mediaCount")}</dt>
                <dd>{claim.postMediaCount}</dd>
              </>
            )}
            <dt className="font-semibold">{t("detail.fields.signature")}</dt>
            <dd>{claim.signature}</dd>
            <dt className="font-semibold">{t("detail.fields.statements")}</dt>
            <dd>{claim.statementVersion}</dd>
          </dl>

          <div>
            <h4 className="font-semibold">{t("detail.eventsTitle")}</h4>
            <ol className="mt-2 flex flex-col gap-2">
              {claim.events.map((event, index) => (
                <li key={index} className="border-l-2 border-border-subtle pl-3">
                  <p>
                    {t(`events.${event.kind}`)}{" "}
                    <span className="text-xs text-text-secondary">
                      · {t(`detail.actor.${event.actorKind}`)} ·{" "}
                      {formatDate(event.createdAt)}
                    </span>
                  </p>
                  {event.note && (
                    <p className="whitespace-pre-wrap break-words text-text-secondary">
                      {event.note}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </div>

          {(claim.status === "in_review" || claim.removal) && (
            <CopyrightRemovalSection
              claim={claim}
              onAccessError={onAccessError}
              onChanged={async () => {
                await Promise.all([refreshClaim(claim.id), loadList()]);
              }}
            />
          )}

          {claim.status === "purged" && (
            <CopyrightStrikeSection
              claim={claim}
              onAccessError={onAccessError}
              onChanged={async () => {
                await refreshClaim(claim.id);
              }}
            />
          )}

          <div>
            <h4 className="font-semibold">{t("actions.title")}</h4>
            {allowed.length === 0 ? (
              <p className="mt-2 text-text-secondary">{t("actions.closed")}</p>
            ) : (
              <>
                <label htmlFor="copyright-review-note" className="mt-2 block">
                  {t("actions.noteLabel")}
                </label>
                <textarea
                  id="copyright-review-note"
                  rows={3}
                  maxLength={1200}
                  value={note}
                  disabled={saving}
                  onChange={(event) => setNote(event.target.value)}
                  aria-describedby="copyright-review-note-help"
                  className="mt-1 w-full rounded-md border border-border-subtle bg-bg-base px-3 py-2 text-text-primary outline-none focus:border-accent-secondary focus-visible:ring-2 focus-visible:ring-accent-secondary"
                />
                <p
                  id="copyright-review-note-help"
                  className="mt-1 text-xs text-text-secondary"
                >
                  {t("actions.noteHelp")}
                </p>
                <div className="mt-3 flex flex-wrap gap-3">
                  {allowed.map((action) => (
                    <button
                      key={action}
                      type="button"
                      className={buttonClass}
                      disabled={saving}
                      onClick={() => void runAction(claim, action)}
                    >
                      {saving ? t("actions.submitting") : t(`actions.${action}`)}
                    </button>
                  ))}
                </div>
              </>
            )}
            {feedback?.kind === "ok" && (
              <p role="status" className="mt-3">
                {t("actions.done")}
              </p>
            )}
            {feedback?.kind === "error" && (
              <p role="alert" className="mt-3 text-accent-live">
                {t(`actions.errors.${feedback.key}`)}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  ) : null;

  return (
    <section aria-label={t("title")} className="mt-6 min-w-0">
      <h2 className="font-display text-2xl">{t("title")}</h2>
      <p className="mt-2 text-sm text-text-secondary">{t("safeNote")}</p>
      <div className="my-4 flex flex-wrap gap-3">
        {(["open", "closed"] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={`${topButtonClass} ${scope === s ? "bg-bg-elevated" : ""}`}
            aria-pressed={scope === s}
            onClick={() => changeScope(s)}
          >
            {t(`scope.${s}`)}
          </button>
        ))}
        <button type="button" className={topButtonClass} onClick={() => void loadList()}>
          {t("refresh")}
        </button>
      </div>

      {list.kind === "loading" && <p role="status">{t("loading")}</p>}
      {list.kind === "error" && (
        <div role="alert">
          {t("loadError")}{" "}
          <button type="button" className={buttonClass} onClick={() => void loadList()}>
            {t("retry")}
          </button>
        </div>
      )}
      {list.kind === "ready" && list.claims.length === 0 && (
        <p className="text-sm text-text-secondary">{t(`empty.${scope}`)}</p>
      )}
      {list.kind === "ready" && list.claims.length > 0 && (
        <ul className="flex flex-col gap-3">
          {list.claims.map((item) => (
            <li
              key={item.id}
              className={`rounded-md border p-3 ${
                selectedId === item.id ? "border-accent-primary" : "border-border-subtle"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-sm font-semibold">{item.reference}</span>
                <span className="text-xs uppercase">{t(`status.${item.status}`)}</span>
              </div>
              <p className="mt-1 text-sm">
                {item.claimantName} · {t(`relationship.${item.relationship}`)}
              </p>
              <p className="text-xs text-text-secondary">
                {formatDate(item.createdAt)} ·{" "}
                {item.postFound ? t("postFound.yes") : t("postFound.no")}
              </p>
              <button
                type="button"
                className={`${buttonClass} mt-2`}
                aria-label={`${t("open")} ${item.reference}`}
                aria-expanded={selectedId === item.id}
                aria-controls="copyright-claim-detail"
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  setNote("");
                  setFeedback(null);
                  void openClaim(item.id);
                }}
              >
                {t("open")}
              </button>
              {selectedId === item.id && detailSection}
            </li>
          ))}
        </ul>
      )}
      {list.kind === "ready" && (trail.length > 0 || list.nextCursor) && (
        <nav className="mt-3 flex gap-3" aria-label={t("title")}>
          {trail.length > 0 && (
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                const previous = trail[trail.length - 1] ?? null;
                setTrail((current) => current.slice(0, -1));
                setCursor(previous);
                closeDetail();
              }}
            >
              ←
            </button>
          )}
          {list.nextCursor && (
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setTrail((current) => [...current, cursor]);
                setCursor(list.nextCursor);
                closeDetail();
              }}
            >
              {t("next")}
            </button>
          )}
        </nav>
      )}

      {detail && !selectedInList && detailSection}
    </section>
  );
}
