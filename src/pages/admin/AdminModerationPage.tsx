import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { showActionSuccess } from "@/lib/action-notice";
import { useAuth } from "@/lib/auth-context";
import { useAdminAccess } from "@/hooks/useAdminAccess";
import AdminAuthCard from "@/components/admin/AdminAuthCard";
import ModerationDecisionActions, {
  type DecisionDraft,
} from "./ModerationDecisionActions";
import CosplayLocaleProvider from "@/i18n/LocaleProvider";
import ModerationAuditList from "./ModerationAuditList";
import ModerationStrikePanel, { type StrikeDraft } from "./ModerationStrikePanel";
import ModerationStrikeUnavailable from "./ModerationStrikeUnavailable";
import { groupedDecisionInputFromCase } from "@/lib/moderation-decision-contract";
import {
  fetchModerationCase,
  fetchModerationCasePage,
  fetchModerationPendingCount,
  ModerationClientError,
  type ModerationCaseItem,
  type ModerationCasePage,
  hasQueueFilters,
  type ModerationQueueFilters as QueueFilters,
} from "@/lib/moderation-client";
import ModerationQueueFilters from "./ModerationQueueFilters";
import ModerationMedia from "./ModerationMedia";
import ModerationPendingCounter, { type PendingState } from "./ModerationPendingCounter";

const MFA_PATH = "/admin/mfa?returnTo=/admin/moderation";
const LOGIN_PATH = "/login?returnTo=/admin/moderation";
// Same-session step-up continuity only. Never persisted or used as DB authority.
let decisionReturn: {
  userId: string;
  cycleId: string;
  scope: "active" | "closed";
  cursor: string | null;
  filters?: QueueFilters;
  trail?: (string | null)[];
  draft?: DecisionDraft;
  strike?: StrikeDraft;
} | null = null;
/** R5-N: el bloque de strike se calcula por CASO (decisión «Procede» más reciente del caso). Un caso
 *  con varios ciclos (p. ej. ciclo 1 «No procede», ciclo 2 «Procede») no debe ofrecer acciones de strike
 *  en el ciclo que NO es el «Procede» (la acción afectaría a la decisión de otro ciclo). */
function strikeBelongsToCycle(item: ModerationCaseItem) {
  const strike = item.strike;
  if (!strike) return false;
  if (item.decision?.result !== "content_actioned") return false;
  return strike.decisionId === null || strike.decisionId === item.decision.decisionId;
}
function actionable(item: ModerationCaseItem) {
  if (
    item.caseStatus !== "pending" ||
    item.cycleStatus !== "pending" ||
    !item.isCurrentCycle ||
    item.currentCycleId !== item.cycleId ||
    item.currentCycleNumber !== item.cycleNumber ||
    item.decision ||
    item.closureKind !== null ||
    (item.post?.status === "hidden_pending_review" &&
      item.post.quarantineCycleId !== item.cycleId)
  )
    return false;
  try {
    groupedDecisionInputFromCase(item, "reports_not_valid");
    return true;
  } catch {
    return false;
  }
}
const REASONS: Record<string, string> = {
  spam: "Spam",
  harassment: "Acoso",
  hate_speech: "Discurso de odio",
  sexual_content: "Contenido sexual",
  other: "Otro",
};
const STATES: Record<string, string> = {
  open: "Abierto",
  reviewing: "En revisión",
  resolved: "Resuelto",
  dismissed: "Descartado",
  actioned: "Actuado",
};
const buttonClass =
  "min-h-11 rounded-md border border-border-subtle px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary disabled:opacity-50";
const topButtonClass =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-4 py-2 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth enabled:hover:border-accent-primary/60 enabled:hover:text-text-primary enabled:active:border-accent-primary/60 enabled:active:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none";
function date(iso: string | null) {
  return iso
    ? new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(iso),
      )
    : "—";
}
/** R4-E4: when the post was physically purged (system `post_purged` audit row), or null. */
function purgedAt(item: ModerationCaseItem): string | null {
  return item.audit.find((a) => a.action === "post_purged")?.createdAt ?? null;
}
/** R4-E4: removed post whose 72 h window ended but whose row still exists. The server already
 *  hides its text/media; this only selects the neutral wording (cosmetic, not a security gate). */
function contentExpired(item: ModerationCaseItem) {
  return (
    item.post?.status === "removed_pending_purge" &&
    !!item.post.purgeAfter &&
    Date.parse(item.post.purgeAfter) <= Date.now()
  );
}
function postState(item: ModerationCaseItem) {
  return !item.post
    ? purgedAt(item)
      ? "Publicación eliminada definitivamente"
      : "Publicación no disponible"
    : item.post.status === "removed_pending_purge"
      ? contentExpired(item)
        ? "Retirada por moderación · contenido expirado"
        : "Retirada por moderación"
      : item.post.status === "hidden_pending_review"
        ? "Oculta preventivamente"
        : item.post.status === "hidden"
          ? "Oculta por moderación anterior"
          : "Publicada";
}
/** Texto de la cola en el idioma activo (namespace moderation.queue). */
function QueueText({
  k,
}: {
  k: "invalidPage" | "updating" | "updateFailed" | "noMatches";
}) {
  return <>{useTranslations("moderation.queue")(k)}</>;
}
function returnedFromMfa(state: unknown) {
  return Boolean(
    state &&
    typeof state === "object" &&
    ((state as { fromMfa?: unknown }).fromMfa ||
      (state as { mfaCancelled?: unknown }).mfaCancelled),
  );
}
function Reasons({ item }: { item: ModerationCaseItem }) {
  return (
    <span className="flex flex-wrap gap-2">
      {item.reasons.map((r) => (
        <span
          key={r.reason}
          className="break-words rounded border border-border-subtle px-2 py-1 text-xs"
        >
          {REASONS[r.reason]} ×{r.count}
        </span>
      ))}
    </span>
  );
}
export default function AdminModerationPage() {
  const { user } = useAuth();
  // Idioma (es/en/de) para los textos nuevos de auditoría y de estado de strike; el proveedor es el
  // mismo de /cosplay (misma preferencia persistida) y aquí solo envuelve el panel.
  return (
    <CosplayLocaleProvider>
      <AdminModeration key={user?.id ?? "anonymous"} />
    </CosplayLocaleProvider>
  );
}
function AdminModeration() {
  const { user } = useAuth();
  const location = useLocation();
  const resume = useRef(
    returnedFromMfa(location.state) && decisionReturn?.userId === user?.id
      ? decisionReturn
      : null,
  );
  useEffect(() => {
    if (decisionReturn?.userId !== user?.id || !returnedFromMfa(location.state))
      decisionReturn = null;
  }, [user?.id, location.state]);
  const navigate = useNavigate();
  const { status, access, refetch, invalidate } = useAdminAccess({ fresh: true });
  const role = access?.role ?? null;
  const mfaRecent = access?.mfaRecent ?? false;
  const hasModerationCapability = access?.capabilities.includes("moderation") ?? false;
  const canLoadPanel = status === "ready" && hasModerationCapability && mfaRecent;
  const mfaReturnGuardRef = useRef(returnedFromMfa(location.state));
  const hadAccessRef = useRef(false);
  const [scope, setScope] = useState<"active" | "closed">(
    resume.current?.scope ?? "active",
  );
  const [cursor, setCursor] = useState<string | null>(resume.current?.cursor ?? null);
  // R5-G: filtros aplicados y rastro de cursores de las páginas anteriores («Página anterior»
  // retrocede por este rastro; la paginación sigue siendo por cursor, sin OFFSET).
  const [filters, setFilters] = useState<QueueFilters>(resume.current?.filters ?? {});
  const [trail, setTrail] = useState<(string | null)[]>(resume.current?.trail ?? []);
  const [decisionFeedback, setDecisionFeedback] = useState<string | null>(null);
  const restoredDecision = useRef(false);
  const [queue, setQueue] = useState<
    | { kind: "loading" }
    | { kind: "error"; invalidPage: boolean }
    | ({
        kind: "ready";
        scope: "active" | "closed";
        refreshing: boolean;
        failed: boolean;
      } & ModerationCasePage)
  >({ kind: "loading" });
  const requestSeq = useRef(0);
  const [pending, setPending] = useState<PendingState>({ kind: "loading", count: null });
  const pendingRequest = useRef<AbortController | null>(null);
  const shownKey = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const listRef = useRef<HTMLElement | null>(null);
  const [selectedId, setSelectedIdState] = useState<string | null>(null);
  const setSelectedId = useCallback((id: string | null) => {
    selectedRef.current = id;
    setSelectedIdState(id);
  }, []);
  const [detail, setDetail] = useState<
    { kind: "loading" | "error" } | { kind: "ready"; item: ModerationCaseItem } | null
  >(null);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const queueRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const opener = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueRequest.current?.abort();
      detailRequest.current?.abort();
      pendingRequest.current?.abort();
    };
  }, []);
  const handleAccessError = useCallback(
    (err: unknown) => {
      if (!(err instanceof ModerationClientError)) return;
      if (err.code === "step_up_required" || err.code === "mfa_required")
        navigate(MFA_PATH, { replace: true, state: { cancelTo: "/admin/moderation" } });
      else if (err.status === 401 || err.status === 403) void invalidate();
    },
    [invalidate, navigate],
  );
  const close = useCallback(() => {
    resume.current = null;
    detailRequest.current?.abort();
    setSelectedId(null);
    setDetail(null);
    opener.current?.focus();
  }, [setSelectedId]);
  const rangeInvalid = Boolean(filters.from && filters.to && filters.from > filters.to);
  const loadQueue = useCallback(async () => {
    if (rangeInvalid) return;
    queueRequest.current?.abort();
    const controller = new AbortController();
    queueRequest.current = controller;
    const seq = ++requestSeq.current;
    const key = JSON.stringify([scope, cursor, filters]);
    // Continuidad: con resultados ya visibles NO se sustituyen por «Cargando casos…».
    setQueue((q) =>
      q.kind === "ready"
        ? { ...q, refreshing: true, failed: false }
        : { kind: "loading" },
    );
    // Una respuesta antigua (filtros/página/vista ya cambiados) nunca se aplica.
    const stale = () =>
      seq !== requestSeq.current || controller.signal.aborted || !mounted.current;
    try {
      const page = await fetchModerationCasePage(
        scope,
        cursor,
        controller.signal,
        filters,
      );
      if (stale()) return;
      hadAccessRef.current = true;
      mfaReturnGuardRef.current = false;
      shownKey.current = key;
      setQueue({ kind: "ready", scope, refreshing: false, failed: false, ...page });
      // El caso abierto se conserva mientras siga presente; si ya no está, se cierra.
      if (
        selectedRef.current &&
        !page.cases.some((c) => c.cycleId === selectedRef.current)
      ) {
        detailRequest.current?.abort();
        setSelectedId(null);
        setDetail(null);
      }
    } catch (err) {
      if (stale()) return;
      handleAccessError(err);
      const invalidPage =
        cursor !== null && err instanceof ModerationClientError && err.status === 400;
      setQueue((q) =>
        q.kind === "ready" && shownKey.current === key && !invalidPage
          ? { ...q, refreshing: false, failed: true }
          : { kind: "error", invalidPage },
      );
    }
  }, [scope, cursor, filters, rangeInvalid, handleAccessError, setSelectedId]);
  // R5-H: total de casos únicos pendientes, calculado en el servidor (no depende de la página ni de
  // los filtros). Se pide al entrar, al actualizar y tras una decisión; sin polling.
  const loadPending = useCallback(async () => {
    pendingRequest.current?.abort();
    const controller = new AbortController();
    pendingRequest.current = controller;
    setPending((p) => ({ kind: "loading", count: p.kind === "error" ? null : p.count }));
    try {
      const count = await fetchModerationPendingCount(controller.signal);
      if (controller.signal.aborted || !mounted.current) return;
      setPending({ kind: "ready", count });
    } catch (err) {
      if (controller.signal.aborted || !mounted.current) return;
      handleAccessError(err);
      setPending({ kind: "error", count: null });
    }
  }, [handleAccessError]);
  const changeFilters = useCallback((next: QueueFilters) => {
    setFilters(next);
    setCursor(null);
    setTrail([]);
  }, []);
  const goFirst = () => {
    setCursor(null);
    setTrail([]);
    listRef.current?.scrollIntoView?.({ block: "start" });
  };
  useEffect(() => {
    if (canLoadPanel) void loadQueue();
    else {
      pendingRequest.current?.abort();
      setPending({ kind: "loading", count: null });
      queueRequest.current?.abort();
      detailRequest.current?.abort();
      requestSeq.current++;
      shownKey.current = null;
      setQueue({ kind: "loading" });
      setDetail(null);
      setSelectedId(null);
    }
  }, [canLoadPanel, loadQueue, setSelectedId]);
  useEffect(() => {
    if (canLoadPanel) void loadPending();
  }, [canLoadPanel, loadPending]);
  const openCase = useCallback(
    async (id: string, fresh = false) => {
      detailRequest.current?.abort();
      const controller = new AbortController();
      detailRequest.current = controller;
      setSelectedId(id);
      // R5-N: tras una mutación (strike aplicado/revocado, estado cambiado) NO se conserva el detalle
      // anterior mientras llega el nuevo: dejaría visible un botón (p. ej. «Aplicar Strike») ya obsoleto.
      setDetail((d) =>
        !fresh && d?.kind === "ready" && d.item.cycleId === id ? d : { kind: "loading" },
      );
      try {
        const item = await fetchModerationCase(id, controller.signal);
        if (!controller.signal.aborted && mounted.current)
          setDetail({ kind: "ready", item });
      } catch (err) {
        if (!controller.signal.aborted && mounted.current) {
          handleAccessError(err);
          setDetail({ kind: "error" });
        }
      }
    },
    [handleAccessError, setSelectedId],
  );
  useEffect(() => {
    if (
      !canLoadPanel ||
      queue.kind !== "ready" ||
      !resume.current ||
      restoredDecision.current
    )
      return;
    restoredDecision.current = true;
    decisionReturn = null;
    if (queue.cases.some((item) => item.cycleId === resume.current?.cycleId))
      void openCase(resume.current.cycleId);
    else
      setDecisionFeedback(
        "El caso ya no está disponible en esta cola. Revisa la información actualizada.",
      );
  }, [canLoadPanel, queue, openCase]);
  if (status === "loading") {
    return (
      <AdminAuthCard title="Moderación">
        <p className="text-sm text-text-secondary" role="status">
          Comprobando tu sesión…
        </p>
      </AdminAuthCard>
    );
  }

  if (status === "no-session") {
    return <Navigate to={LOGIN_PATH} replace state={location.state} />;
  }

  if (status === "unauthenticated" || status === "error" || !access) {
    return (
      <AdminAuthCard title="Moderación">
        <p role="alert" className="text-sm text-accent-live">
          No se pudo comprobar tu acceso. Inténtalo de nuevo.
        </p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="mt-6 inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors hover:border-accent-primary/60 hover:text-text-primary"
        >
          Reintentar
        </button>
      </AdminAuthCard>
    );
  }

  if (!hasModerationCapability) {
    // USER, o un rol privilegiado sin la capacidad moderation: acceso denegado SIN MFA (MFA no
    // concede capacidades). Nunca se distingue "nunca tuvo acceso" de "se lo quitaron" con más
    // detalle del necesario.
    return (
      <AdminAuthCard title="Moderación">
        <p role="alert" className="text-sm text-accent-live">
          {hadAccessRef.current
            ? "Tu acceso a moderación ya no está disponible."
            : "No tienes acceso al panel de moderación."}
        </p>
        <p className="mt-4 text-sm text-text-secondary">
          <Link to="/account" className="font-medium text-accent-primary hover:underline">
            Ir a mi cuenta
          </Link>
        </p>
      </AdminAuthCard>
    );
  }

  if (!mfaRecent) {
    if (mfaReturnGuardRef.current) {
      return (
        <AdminAuthCard title="Moderación">
          <p role="alert" className="text-sm text-accent-live">
            No pudimos confirmar tu verificación en dos pasos reciente.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void refetch()}
              className="inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors hover:border-accent-primary/60 hover:text-text-primary"
            >
              Reintentar
            </button>
            <Link
              to={MFA_PATH}
              state={location.state}
              className="inline-flex min-h-11 items-center rounded-md border border-accent-primary/60 px-5 py-2.5 text-sm font-semibold text-accent-primary hover:underline"
            >
              Verificar de nuevo
            </Link>
          </div>
        </AdminAuthCard>
      );
    }
    return <Navigate to={MFA_PATH} replace state={location.state} />;
  }

  const panel = selectedId ? (
    <section
      id="moderation-case-detail"
      aria-label="Detalle del caso"
      className="min-w-0 border-t border-border-subtle p-4"
    >
      <div className="flex justify-end">
        <button
          type="button"
          disabled={statusUpdating}
          aria-label="Cerrar detalle del caso"
          title="Cerrar detalle del caso"
          onClick={close}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {detail?.kind === "loading" && <p role="status">Cargando caso…</p>}
      {detail?.kind === "error" && (
        <div role="alert">
          No se pudo cargar este caso.{" "}
          <button className={buttonClass} onClick={() => void openCase(selectedId)}>
            Reintentar detalle
          </button>
        </div>
      )}
      {detail?.kind === "ready" && (
        <div className="min-w-0 space-y-4">
          <p className="break-all text-xs text-text-muted">
            Caso {detail.item.caseId} · Ciclo {detail.item.cycleNumber} · Versión actual
            del caso {detail.item.caseVersion} · Publicación {detail.item.postId}
          </p>
          <h2 className="text-lg font-semibold">Contexto de la publicación</h2>
          <p>{postState(detail.item)}</p>
          {detail.item.post ? (
            <>
              <p>
                {detail.item.post.authorUsername
                  ? `@${detail.item.post.authorUsername}`
                  : "Autor no disponible"}{" "}
                · Versión de publicación {detail.item.post.version}
              </p>
              {contentExpired(detail.item) ? (
                <p>
                  El contenido de esta publicación ya expiró y no está disponible. No se
                  conserva una captura de su texto o media.
                </p>
              ) : (
                <>
                  <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                    {detail.item.post.text ?? "Publicación sin texto"}
                  </p>
                  <p className="text-sm text-text-muted">
                    Se muestra el contenido actual, no una captura histórica del reporte.
                  </p>
                </>
              )}
              {detail.item.firstReportAt &&
                Date.parse(detail.item.post.updatedAt) >
                  Date.parse(detail.item.firstReportAt) && (
                  <p className="text-sm">
                    La publicación se actualizó después del primer reporte.
                  </p>
                )}
              <div className="flex min-w-0 flex-wrap gap-2">
                {detail.item.media.map((m, i, all) => (
                  <ModerationMedia
                    key={`${detail.item.cycleId}:${m.id}`}
                    item={m}
                    position={i + 1}
                    total={all.length}
                  />
                ))}
              </div>
            </>
          ) : (
            <p>
              {purgedAt(detail.item)
                ? `La publicación fue eliminada definitivamente el ${date(purgedAt(detail.item))}. `
                : "La publicación original ya no está disponible. "}
              No se conserva una captura de su texto o media.
            </p>
          )}
          <h2 className="font-semibold">Estado del ciclo</h2>
          <p>
            Caso {detail.item.caseStatus === "pending" ? "pendiente" : "cerrado"} · Ciclo
            actual {detail.item.currentCycleNumber}
          </p>
          <p>
            {detail.item.cycleStatus === "pending"
              ? "Pendiente de revisión humana"
              : detail.item.closureKind === "legacy"
                ? "Cierre histórico; sin decisión agrupada registrada"
                : "Ciclo cerrado por decisión registrada"}
          </p>
          {!detail.item.isCurrentCycle && (
            <p>
              Este es un ciclo anterior. La publicación mostrada corresponde al estado
              actual.
            </p>
          )}
          {detail.item.cycleStatus === "closed" && (
            <p>
              Los reportes de ciclos cerrados no aportan votos al ciclo actual. No se
              reconstruye un conteo histórico de cuentas.
            </p>
          )}
          <p>
            {detail.item.qualifyingReporters} cuentas calificantes ·{" "}
            {detail.item.totalReports} reportes del ciclo
          </p>
          {detail.item.post?.status === "hidden_pending_review" && (
            <p className="rounded border border-border-subtle p-3">
              Oculta preventivamente por el umbral de reportes. La revisión humana está
              pendiente: esto no confirma una infracción ni aplica un strike.
            </p>
          )}
          <Reasons item={detail.item} />
          {detail.item.decision && (
            <p className="rounded border border-border-subtle p-3">
              Decisión:{" "}
              {detail.item.decision.result === "reports_not_valid"
                ? "No procede"
                : "Procede"}
              {detail.item.decision.resolutionMessage && (
                <span className="block whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {detail.item.decision.resolutionMessage}
                </span>
              )}
            </p>
          )}
          {scope === "closed" && detail.item.strikeUnavailable && (
            <ModerationStrikeUnavailable
              disabled={statusUpdating}
              onRetry={() => void openCase(detail.item.cycleId, true)}
            />
          )}
          {scope === "closed" &&
            detail.item.strike &&
            strikeBelongsToCycle(detail.item) && (
              <ModerationStrikePanel
                role={role}
                key={`${detail.item.cycleId}:${detail.item.caseVersion}:${detail.item.strike.existing?.id ?? "none"}:${detail.item.strike.predictedLevel ?? "-"}`}
                item={detail.item}
                resume={
                  resume.current?.cycleId === detail.item.cycleId
                    ? resume.current.strike
                    : undefined
                }
                onPending={(pending) => {
                  if (mounted.current) setStatusUpdating(pending);
                }}
                onAccessError={handleAccessError}
                onStepUp={(strike) => {
                  if (user)
                    decisionReturn = {
                      userId: user.id,
                      cycleId: detail.item.cycleId,
                      scope,
                      cursor,
                      filters,
                      trail,
                      strike,
                    };
                  navigate(MFA_PATH, {
                    replace: true,
                    state: { cancelTo: "/admin/moderation" },
                  });
                }}
                onStale={() => {
                  // Never retried: reload the authoritative state and say so neutrally.
                  resume.current = null;
                  setDecisionFeedback(
                    "El estado de moderación de este caso cambió. Actualizamos la información para que la revises de nuevo.",
                  );
                  void openCase(detail.item.cycleId, true);
                }}
                onChanged={(message) => {
                  // The final state is read back from the server, never synthesized locally.
                  resume.current = null;
                  showActionSuccess(message);
                  void openCase(detail.item.cycleId, true);
                }}
              />
            )}
          {scope === "active" && actionable(detail.item) && (
            <ModerationDecisionActions
              key={`${detail.item.cycleId}:${detail.item.caseVersion}`}
              item={detail.item}
              resume={
                resume.current?.cycleId === detail.item.cycleId
                  ? resume.current.draft
                  : undefined
              }
              onPending={(pending) => {
                if (mounted.current) setStatusUpdating(pending);
              }}
              onAccessError={handleAccessError}
              onStepUp={(draft) => {
                if (user)
                  decisionReturn = {
                    userId: user.id,
                    cycleId: detail.item.cycleId,
                    scope,
                    cursor,
                    filters,
                    trail,
                    draft,
                  };
                navigate(MFA_PATH, {
                  replace: true,
                  state: { cancelTo: "/admin/moderation" },
                });
              }}
              onConflict={() => {
                resume.current = null;
                close();
                setDecisionFeedback(
                  "Este caso cambió mientras lo revisabas. Actualizamos la información para que puedas revisarlo nuevamente.",
                );
                void loadQueue();
                void loadPending();
              }}
              onSuccess={(message) => {
                resume.current = null;
                close();
                setDecisionFeedback(message);
                showActionSuccess(message);
                void loadQueue();
                void loadPending();
              }}
            />
          )}
          <h2 className="font-semibold">Reportes del ciclo</h2>
          <ul className="space-y-3">
            {detail.item.reports.map((r) => (
              <li
                key={r.reportId}
                className="min-w-0 rounded border border-border-subtle p-3"
              >
                <p>
                  {REASONS[r.reason]} · {STATES[r.status]} · {date(r.createdAt)}
                </p>
                {r.detail && (
                  <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                    {r.detail}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {detail.item.reportsTruncated && (
            <p>
              Se muestran los 50 reportes más recientes de {detail.item.totalReports}. Hay
              más reportes en este ciclo.
            </p>
          )}
          {detail.item.cycleStatus === "pending" && (
            <p className="text-sm text-text-muted">
              Este caso está pendiente de una decisión de moderación.
            </p>
          )}
          <ModerationAuditList audit={detail.item.audit} />
        </div>
      )}
    </section>
  ) : null;
  return (
    <div className="mx-auto min-w-0 max-w-4xl px-4 py-16">
      <div className="min-w-0 rounded-xl border border-accent-primary/40 bg-bg-surface p-4 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-3xl">Moderación</h1>
          <span className="text-xs uppercase">{role?.toUpperCase()}</span>
        </div>
        <div className="mt-3">
          <ModerationPendingCounter state={pending} onRetry={() => void loadPending()} />
        </div>
        <section ref={listRef} aria-label="Cola de casos" className="mt-6 min-w-0">
          {decisionFeedback && (
            <p role="status" className="mb-4">
              {decisionFeedback}
            </p>
          )}
          <div className="mb-4 flex flex-wrap gap-3">
            {(["active", "closed"] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={`${topButtonClass} ${scope === s ? "bg-bg-elevated" : ""}`}
                disabled={statusUpdating}
                aria-pressed={scope === s}
                onClick={() => {
                  if (s === scope) return;
                  close();
                  setCursor(null);
                  setTrail([]);
                  setScope(s);
                }}
              >
                {s === "active" ? "Activos" : "Historial"}
              </button>
            ))}
            <button
              className={topButtonClass}
              disabled={statusUpdating}
              onClick={() => {
                void loadQueue();
                void loadPending();
                if (selectedId) void openCase(selectedId);
              }}
            >
              Actualizar contexto
            </button>
          </div>
          <ModerationQueueFilters
            filters={filters}
            onChange={changeFilters}
            disabled={statusUpdating}
          />
          {(queue.kind === "loading" ||
            (queue.kind === "ready" && queue.scope !== scope)) && (
            <p role="status">Cargando casos…</p>
          )}
          {queue.kind === "error" && (
            <div role="alert">
              {queue.invalidPage ? (
                <QueueText k="invalidPage" />
              ) : (
                "No se pudieron cargar los casos."
              )}{" "}
              {queue.invalidPage ? (
                <button className={buttonClass} onClick={goFirst}>
                  Volver al inicio
                </button>
              ) : (
                <button className={buttonClass} onClick={() => void loadQueue()}>
                  Reintentar
                </button>
              )}
            </div>
          )}
          {queue.kind === "ready" && queue.scope === scope && (
            <div aria-busy={queue.refreshing} className="min-w-0">
              {queue.refreshing && (
                <p role="status" className="mb-2 text-xs text-text-muted">
                  <QueueText k="updating" />
                </p>
              )}
              {queue.failed && (
                <p role="alert" className="mb-2 text-sm">
                  <QueueText k="updateFailed" />{" "}
                  <button className={buttonClass} onClick={() => void loadQueue()}>
                    Reintentar
                  </button>
                </p>
              )}
              {queue.cases.length === 0 && (
                <p>
                  {hasQueueFilters(filters) ? (
                    <QueueText k="noMatches" />
                  ) : scope === "active" ? (
                    "No hay casos activos por ahora."
                  ) : (
                    "No hay ciclos cerrados por ahora."
                  )}
                </p>
              )}
              <ul
                className={`min-w-0 divide-y divide-border-subtle rounded-md border border-border-subtle ${queue.refreshing ? "opacity-70" : ""}`}
              >
                {queue.cases.map((item) => (
                  <li key={item.cycleId} className="min-w-0">
                    <button
                      type="button"
                      disabled={statusUpdating}
                      aria-expanded={selectedId === item.cycleId}
                      aria-controls={
                        selectedId === item.cycleId ? "moderation-case-detail" : undefined
                      }
                      onClick={(e) => {
                        opener.current = e.currentTarget;
                        void openCase(item.cycleId);
                      }}
                      className="flex w-full min-w-0 flex-col gap-2 px-4 py-3 text-left hover:bg-bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                    >
                      <span className="flex flex-wrap justify-between gap-2">
                        <span className="font-semibold">{postState(item)}</span>
                        <span className="text-xs">
                          Ciclo {item.cycleNumber} ·{" "}
                          {item.cycleStatus === "pending" ? "Pendiente" : "Cerrado"}
                        </span>
                      </span>
                      <span className="text-sm">
                        {item.qualifyingReporters} cuentas calificantes ·{" "}
                        {item.totalReports} reportes
                      </span>
                      <Reasons item={item} />
                      <span className="line-clamp-2 break-words [overflow-wrap:anywhere] text-sm">
                        {contentExpired(item)
                          ? "Contenido expirado"
                          : (item.post?.text ??
                            (item.post
                              ? "Publicación sin texto"
                              : purgedAt(item)
                                ? "Publicación eliminada definitivamente"
                                : "Publicación original no disponible"))}
                      </span>
                      <span className="text-xs text-text-muted">
                        {item.post?.authorUsername
                          ? `@${item.post.authorUsername} · `
                          : ""}
                        {date(item.activityAt)}
                      </span>
                      {item.closureKind === "legacy" && (
                        <span className="text-xs">
                          Cierre histórico sin decisión agrupada
                        </span>
                      )}
                    </button>
                    {selectedId === item.cycleId && panel}
                  </li>
                ))}
              </ul>
              {(trail.length > 0 || cursor || queue.nextCursor) && (
                <nav
                  aria-label="Paginación de la cola"
                  className="mt-4 flex flex-wrap gap-3"
                >
                  {trail.length > 0 && (
                    <button
                      className={buttonClass}
                      disabled={statusUpdating}
                      onClick={() => {
                        setCursor(trail[trail.length - 1] ?? null);
                        setTrail(trail.slice(0, -1));
                        listRef.current?.scrollIntoView?.({ block: "start" });
                      }}
                    >
                      Página anterior
                    </button>
                  )}
                  {cursor && (
                    <button
                      className={buttonClass}
                      disabled={statusUpdating}
                      onClick={goFirst}
                    >
                      Volver al inicio
                    </button>
                  )}
                  {queue.nextCursor && (
                    <button
                      className={buttonClass}
                      disabled={statusUpdating}
                      onClick={() => {
                        setTrail([...trail, cursor]);
                        setCursor(queue.nextCursor);
                        listRef.current?.scrollIntoView?.({ block: "start" });
                      }}
                    >
                      Siguiente página
                    </button>
                  )}
                </nav>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
