import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { useLocaleCode } from "@/i18n/useFormat";
import {
  decideContentReview,
  fetchContentReviewPage,
  type ContentReviewDecision,
  type ContentReviewScope,
  type EditReviewItem,
  type HeldReviewItem,
  type ReviewItem,
  type ReviewMedia,
} from "@/lib/content-review-client";
import { ModerationClientError } from "@/lib/moderation-client";
import ModerationMedia from "./ModerationMedia";

// Apartado «Revisión de contenido» de /admin/moderation (Fase 3): publicaciones retenidas y ediciones pendientes. Solo refleja lo
// que el servidor autoriza: permisos (`moderation` + MFA reciente), versiones y estado los comprueba el servidor y la base de
// datos en cada decisión. Los archivos privados se muestran con la capability corta que emite el servidor; si no hay URL, se
// indica que no hay vista previa (nunca se publica un archivo para poder mostrarlo).

const buttonClass =
  "min-h-11 rounded-md border border-border-subtle px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary disabled:opacity-50";
const topButtonClass =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-4 py-2 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth enabled:hover:border-accent-primary/60 enabled:hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary disabled:opacity-50";
const badgeClass = "rounded bg-bg-elevated px-2 py-0.5 text-xs font-semibold text-text-secondary";

type ListState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; items: ReviewItem[]; nextCursor: string | null };
type ErrorKey =
  | "version_conflict"
  | "edit_not_pending"
  | "post_not_held"
  | "asset_not_ready"
  | "post_copyright_protected"
  | "post_not_editable"
  | "generic";
const KNOWN_ERRORS: readonly ErrorKey[] = [
  "version_conflict",
  "edit_not_pending",
  "post_not_held",
  "asset_not_ready",
  "post_copyright_protected",
  "post_not_editable",
];

function MediaGrid({
  media,
  badge,
}: {
  media: ReviewMedia[];
  badge: (m: ReviewMedia) => string | null;
}) {
  const t = useTranslations("moderation.contentReview");
  if (media.length === 0) return <p className="text-sm text-text-muted">{t("noMedia")}</p>;
  return (
    <ul className="grid min-w-0 gap-3">
      {media.map((m, index) => {
        const label = badge(m);
        return (
          <li key={m.assetId} className="min-w-0 space-y-1">
            {label && <span className={badgeClass}>{label}</span>}
            {m.url && m.kind ? (
              <ModerationMedia
                item={{
                  id: m.assetId,
                  position: m.position,
                  kind: m.kind,
                  url: m.url,
                  width: m.width ?? 0,
                  height: m.height ?? 0,
                  durationSeconds: m.durationSeconds,
                }}
                position={index + 1}
                total={media.length}
              />
            ) : (
              <p className="rounded border border-border-subtle bg-bg-elevated p-3 text-sm text-text-muted">
                {t("media.unavailable")}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default function ContentReviewPanel({
  onAccessError,
}: {
  onAccessError: (err: unknown) => void;
}) {
  const t = useTranslations("moderation.contentReview");
  const locale = useLocaleCode();
  const [tab, setTab] = useState<ContentReviewScope>("held");
  const [counts, setCounts] = useState<{ held: number; edits: number } | null>(null);
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [confirming, setConfirming] = useState<{ id: string; decision: ContentReviewDecision } | null>(null);
  const [busy, setBusy] = useState(false);
  // Se guarda la CLAVE (no el texto): `t` cambia de identidad entre renderizados y no debe entrar en las dependencias de `load`.
  const [feedback, setFeedback] = useState<{ ok: boolean; key: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

  const load = useCallback(
    async (scope: ContentReviewScope, cursor: string | null) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      if (cursor === null) setList({ kind: "loading" });
      try {
        const page = await fetchContentReviewPage(scope, cursor, controller.signal);
        if (controller.signal.aborted || !mounted.current) return;
        setCounts(page.counts);
        setList((prev) =>
          cursor !== null && prev.kind === "ready"
            ? { kind: "ready", items: [...prev.items, ...page.items], nextCursor: page.nextCursor }
            : { kind: "ready", items: page.items, nextCursor: page.nextCursor },
        );
      } catch (err) {
        if (controller.signal.aborted || !mounted.current) return;
        onAccessError(err);
        if (cursor === null) setList({ kind: "error" });
        else setFeedback({ ok: false, key: "errors.generic" });
      } finally {
        if (mounted.current) setLoadingMore(false);
      }
    },
    [onAccessError],
  );

  useEffect(() => {
    void load(tab, null);
  }, [tab, load]);

  async function decide(item: ReviewItem, decision: ContentReviewDecision) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      await decideContentReview({
        kind: item.kind,
        id: item.id,
        decision,
        expectedVersion: item.kind === "pending_edit" && decision === "reject" ? null : item.version,
      });
      if (!mounted.current) return;
      setConfirming(null);
      setFeedback({ ok: true, key: `feedback.${item.kind}.${decision}` });
      await load(tab, null);
    } catch (err) {
      if (!mounted.current) return;
      onAccessError(err);
      const code = err instanceof ModerationClientError ? err.code : undefined;
      const key = KNOWN_ERRORS.find((k) => k === code) ?? "generic";
      setConfirming(null);
      setFeedback({ ok: false, key: `errors.${key}` });
      // Un conflicto indica que la cola cambió: se recarga para mostrar el estado real.
      if (key !== "generic") await load(tab, null);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function actions(item: ReviewItem) {
    const stale = item.kind === "pending_edit" && item.stale;
    if (confirming?.id === item.id)
      return (
        <div role="group" aria-label={t("actions.group")} className="space-y-2">
          <p className="text-sm font-semibold">{t(`confirm.${item.kind}.${confirming.decision}`)}</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void decide(item, confirming.decision)}>
              {busy ? t("actions.working") : t("actions.confirm")}
            </button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirming(null)}>
              {t("actions.cancel")}
            </button>
          </div>
        </div>
      );
    return (
      <div className="space-y-2">
        {stale && <p className="text-sm text-text-muted">{t("edit.staleApproveBlocked")}</p>}
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className={buttonClass}
            disabled={busy || stale}
            onClick={() => setConfirming({ id: item.id, decision: "approve" })}
          >
            {t("actions.approve")}
          </button>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirming({ id: item.id, decision: "reject" })}>
            {t("actions.reject")}
          </button>
        </div>
      </div>
    );
  }

  const authorLabel = (item: ReviewItem) =>
    item.author.username ? `@${item.author.username}` : (item.author.displayName ?? t("unknownAuthor"));

  function heldCard(item: HeldReviewItem) {
    return (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <span className={badgeClass}>{t("status.held")}</span>
          <span className="text-sm">{t("by", { author: authorLabel(item) })}</span>
          <span className="text-xs text-text-muted">{t("createdAt", { date: formatDate(item.createdAt) })}</span>
        </div>
        <p className="text-xs text-text-muted">{t("reasonUnavailable")}</p>
        <p className="whitespace-pre-wrap break-words text-sm">{item.text ?? <span className="text-text-muted">{t("noText")}</span>}</p>
        <MediaGrid media={item.media} badge={() => null} />
      </>
    );
  }

  function editCard(item: EditReviewItem) {
    const proposedIds = new Set(item.proposed.media.map((m) => m.assetId));
    const added = item.proposed.media.filter((m) => m.isNew).length;
    const removed = item.published.media.filter((m) => !proposedIds.has(m.assetId)).length;
    const textChanged = (item.published.text ?? "") !== (item.proposed.text ?? "");
    return (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <span className={badgeClass}>{t("status.pending")}</span>
          {item.stale && <span className={`${badgeClass} text-accent-warning`}>{t("edit.stale")}</span>}
          <span className="text-sm">{t("by", { author: authorLabel(item) })}</span>
          <span className="text-xs text-text-muted">{t("requestedAt", { date: formatDate(item.requestedAt) })}</span>
        </div>
        <p className="text-xs text-text-muted">
          {t("edit.versions", { published: item.version, base: item.baseVersion })}
        </p>
        <p className="text-sm font-semibold" data-testid="edit-diff-summary">
          {textChanged ? t("edit.textChanged") : t("edit.textUnchanged")} · {t("edit.mediaSummary", { added, removed })}
        </p>
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          <section aria-label={t("edit.published")} className="min-w-0 space-y-2 rounded border border-border-subtle p-3">
            <h3 className="text-sm font-semibold">{t("edit.published")}</h3>
            <p className="whitespace-pre-wrap break-words text-sm">{item.published.text ?? <span className="text-text-muted">{t("noText")}</span>}</p>
            <MediaGrid media={item.published.media} badge={(m) => (proposedIds.has(m.assetId) ? null : t("media.removed"))} />
          </section>
          <section aria-label={t("edit.proposed")} className="min-w-0 space-y-2 rounded border border-accent-primary/40 p-3">
            <h3 className="text-sm font-semibold">{t("edit.proposed")}</h3>
            <p className="whitespace-pre-wrap break-words text-sm">{item.proposed.text ?? <span className="text-text-muted">{t("noText")}</span>}</p>
            <MediaGrid media={item.proposed.media} badge={(m) => (m.isNew ? t("media.new") : null)} />
          </section>
        </div>
      </>
    );
  }

  return (
    <section aria-labelledby="content-review-title" className="mt-6 min-w-0 space-y-4">
      <h2 id="content-review-title" className="font-display text-2xl">{t("title")}</h2>
      <p className="text-sm text-text-muted">{t("safeNote")}</p>
      <nav aria-label={t("tabs.label")} className="flex flex-wrap gap-3">
        {(["held", "edits"] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={`${topButtonClass} ${tab === s ? "bg-bg-elevated" : ""}`}
            aria-pressed={tab === s}
            onClick={() => {
              setConfirming(null);
              setFeedback(null);
              setTab(s);
            }}
          >
            {t(`tabs.${s}`)}
            {counts && <span className="ml-2 rounded-full bg-bg-elevated px-2 text-xs" aria-label={t("pendingCount", { count: counts[s] })}>{counts[s]}</span>}
          </button>
        ))}
      </nav>
      {feedback && (
        <p role={feedback.ok ? "status" : "alert"} className={`rounded border p-3 text-sm ${feedback.ok ? "border-accent-success/50" : "border-accent-live/50"}`}>
          {t(feedback.key as never)}
        </p>
      )}
      {list.kind === "loading" && <p role="status">{t("loading")}</p>}
      {list.kind === "error" && (
        <div role="alert" className="space-y-2">
          <p>{t("errors.load")}</p>
          <button type="button" className={buttonClass} onClick={() => void load(tab, null)}>{t("retry")}</button>
        </div>
      )}
      {list.kind === "ready" && list.items.length === 0 && <p className="text-text-muted">{t(`empty.${tab}`)}</p>}
      {list.kind === "ready" && list.items.length > 0 && (
        <ul className="space-y-4">
          {list.items.map((item) => (
            <li key={item.id} className="min-w-0">
              <article className="min-w-0 space-y-3 rounded-lg border border-border-subtle bg-bg-base p-4">
                {item.kind === "held_post" ? heldCard(item) : editCard(item)}
                {actions(item)}
              </article>
            </li>
          ))}
        </ul>
      )}
      {list.kind === "ready" && list.nextCursor && (
        <button
          type="button"
          className={buttonClass}
          disabled={loadingMore || busy}
          onClick={() => {
            setLoadingMore(true);
            void load(tab, list.nextCursor);
          }}
        >
          {loadingMore ? t("loading") : t("loadMore")}
        </button>
      )}
    </section>
  );
}
