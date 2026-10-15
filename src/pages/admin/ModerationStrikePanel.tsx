import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "use-intl";
import { useLocaleCode } from "@/i18n/useFormat";
import {
  applyModerationStrike,
  ModerationClientError,
  revokeModerationStrike,
} from "@/lib/moderation-client";
import type { ModerationCaseItem } from "@/lib/moderation-case-contract";
import {
  normalizeStrikeReason,
  STRIKE_REASON_MAX_CODE_POINTS,
  type StrikeLevel,
} from "@/lib/moderation-strike-contract";

// R5-E: sección "Sanción al autor" del detalle de un caso CERRADO (History). La autoridad es el
// servidor: el nivel previsto, la elegibilidad y canRevoke vienen del bloque `strike` del caso; el
// frontend NUNCA calcula escalada ni infiere roles. Aplicar y revocar usan diálogos nativos
// <dialog> en portal (mismo patrón que ModerationDecisionActions), de un solo vuelo, sin reintento
// automático y con el MISMO flujo MFA: si el backend pide MFA se conserva el borrador y, al volver,
// el usuario confirma de nuevo (la mutación NUNCA se repite sola).

export type StrikeDraft =
  | { kind: "apply"; reason: string; decisionId: string }
  | { kind: "revoke"; reason: string; strikeId: string };

interface Props {
  item: ModerationCaseItem;
  resume?: StrikeDraft;
  /** Rol del usuario actual (solo para EXPLICAR por qué no puede revocar; no concede nada). */
  role?: string | null;
  onPending: (pending: boolean) => void;
  /** Tras una mutación confirmada: la página recarga el detalle DESDE EL SERVIDOR. */
  onChanged: (message: string) => void;
  /** Estado de moderación cambiado (409…): la página refresca y lo explica con neutralidad. */
  onStale: () => void;
  onStepUp: (draft: StrikeDraft) => void;
  onAccessError: (error: ModerationClientError) => void;
}

const button =
  "inline-flex min-h-11 items-center justify-center rounded-md border px-4 py-2 text-sm font-semibold transition duration-200 ease-smooth enabled:hover:-translate-y-0.5 enabled:active:translate-y-0 enabled:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50 motion-reduce:enabled:hover:translate-y-0 motion-reduce:enabled:active:scale-100 motion-reduce:transition-none";
const secondaryButton = `${button} border-border-subtle text-text-secondary enabled:hover:border-accent-primary/60 enabled:hover:bg-bg-elevated enabled:hover:text-text-primary`;
const primaryButton = `${button} border-accent-primary/60 bg-accent-primary text-text-inverse shadow-glow-primary enabled:hover:border-accent-secondary enabled:hover:bg-accent-secondary`;

const STALE_CODES = new Set([
  "strike_already_issued",
  "level_changed",
  "decision_not_content_actioned",
  "case_not_closed",
  "author_unavailable",
  "self_strike_forbidden",
  "decision_not_found",
  "strike_already_revoked",
  "self_revoke_forbidden",
  "revoker_role_insufficient",
  "strike_not_found",
]);

function date(iso: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeStyle: "short",
  }).format(new Date(iso));
}
type StrikeT = ReturnType<typeof useTranslations<"moderation.strike">>;

const INELIGIBLE_KEYS = ["author_unavailable", "self_strike_forbidden"] as const;
function effect(level: StrikeLevel, t: StrikeT): string {
  return t(`effect.${level}`);
}

interface DialogProps {
  title: string;
  intro: ReactNode;
  label: string;
  hint: string;
  reason: string;
  onReason: (value: string) => void;
  pending: boolean;
  uncertain: boolean;
  error: string | null;
  resumed: boolean;
  submitLabel: string;
  pendingLabel: string;
  danger: boolean;
  onSubmit: () => void;
  onClose: () => void;
}

function StrikeDialog(p: DialogProps) {
  const t = useTranslations("moderation.strike");

  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const errorId = useId();
  const countId = useId();
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    node.showModal();
    node.querySelector<HTMLButtonElement>("[data-cancel]")?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      node.close();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const count = [...p.reason.trim()].length;
  const over = count > STRIKE_REASON_MAX_CODE_POINTS;
  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={p.error ? errorId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        p.onClose();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl border border-border-subtle bg-bg-surface p-4 text-text-primary backdrop:bg-black/70 sm:p-6"
    >
      <h2 id={titleId} className="text-xl font-semibold">
        {p.title}
      </h2>
      <div className="mt-3 space-y-2">{p.intro}</div>
      {p.resumed && (
        <p role="status" className="mt-3">
          {t("resumed")}
        </p>
      )}
      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          p.onSubmit();
        }}
      >
        <label className="block">
          {p.label}
          <textarea
            required
            rows={5}
            value={p.reason}
            disabled={p.pending}
            aria-invalid={Boolean(p.error) || over}
            aria-describedby={`${countId}${p.error ? ` ${errorId}` : ""}`}
            onChange={(event) => p.onReason(event.target.value)}
            className="mt-2 block w-full min-w-0 rounded border border-border-subtle bg-bg-base p-3"
          />
          <span id={countId} className="block text-sm">
            {t("count", { count, max: STRIKE_REASON_MAX_CODE_POINTS })}
            {over ? t("overMax") : ""}
          </span>
          <span className="block text-sm text-text-muted">{p.hint}</span>
        </label>
        {p.error && (
          <p id={errorId} role="alert">
            {p.error}
          </p>
        )}
        {p.pending && <p role="status">{p.pendingLabel}</p>}
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            data-cancel
            className={secondaryButton}
            disabled={p.pending}
            onClick={p.onClose}
          >
            {t("cancel")}
          </button>
          <button
            type="submit"
            className={p.danger ? secondaryButton : primaryButton}
            disabled={p.pending || p.uncertain}
          >
            {p.pending ? p.pendingLabel : p.submitLabel}
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}

export default function ModerationStrikePanel({
  item,
  resume,
  role = null,
  onPending,
  onChanged,
  onStale,
  onStepUp,
  onAccessError,
}: Props) {
  const t = useTranslations("moderation.strike");
  const locale = useLocaleCode();
  const strike = item.strike;
  const existing = strike?.existing ?? null;
  // Resume only into a dialog that is still valid for the FRESH server state.
  const initialMode: "apply" | "revoke" | null =
    resume?.kind === "apply" &&
    strike?.eligible &&
    strike.decisionId === resume.decisionId
      ? "apply"
      : resume?.kind === "revoke" &&
          existing?.canRevoke &&
          !existing.revoked &&
          existing.id === resume.strikeId
        ? "revoke"
        : null;
  const [mode, setMode] = useState<"apply" | "revoke" | null>(initialMode);
  const [reason, setReason] = useState(initialMode && resume ? resume.reason : "");
  // Solo es cierto mientras el diálogo reabierto tras MFA sigue siendo ese mismo; al cerrarlo o abrir uno
  // nuevo deja de serlo (si no, un diálogo NUEVO diría «No se ha repetido la acción»).
  const [resumed, setResumed] = useState(initialMode !== null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const flight = useRef(false);
  const mounted = useRef(true);
  const opener = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Nothing to show for open cases / No procede / databases without strikes.
  if (!strike) return null;
  if (!existing && strike.ineligibleReason === "decision_not_content_actioned")
    return null;
  if (!existing && strike.ineligibleReason === "case_not_closed") return null;

  const closeDialog = () => {
    if (flight.current) return;
    const wasUncertain = uncertain;
    setMode(null);
    setResumed(false);
    setError(null);
    setUncertain(false);
    opener.current?.focus();
    if (wasUncertain) onStale();
  };

  async function run(kind: "apply" | "revoke") {
    if (flight.current || uncertain || !strike) return;
    const normalized = normalizeStrikeReason(reason);
    if (!normalized.ok) {
      setError(
        normalized.code === "reason_required"
          ? t("errors.reasonRequired")
          : t("errors.reasonTooLong", { max: STRIKE_REASON_MAX_CODE_POINTS }),
      );
      return;
    }
    if (kind === "apply" && (!strike.decisionId || strike.predictedLevel === null))
      return;
    if (kind === "revoke" && !existing) return;
    flight.current = true;
    setPending(true);
    onPending(true);
    setError(null);
    try {
      if (kind === "apply")
        await applyModerationStrike({
          decisionId: strike.decisionId!,
          reason: normalized.value,
          expectedLevel: strike.predictedLevel,
        });
      else
        await revokeModerationStrike({
          strikeId: existing!.id,
          reason: normalized.value,
        });
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ModerationClientError) {
        if (err.code === "step_up_required" || err.code === "mfa_required") {
          onStepUp(
            kind === "apply"
              ? { kind, reason, decisionId: strike.decisionId! }
              : { kind, reason, strikeId: existing!.id },
          );
          return;
        }
        if (err.code && STALE_CODES.has(err.code)) {
          setMode(null);
          setResumed(false);
          setUncertain(false);
          onStale();
          return;
        }
        if (err.status === 401 || err.status === 403) {
          onAccessError(err);
          setError(err.status === 401 ? t("errors.signIn") : t("errors.noAccess"));
          return;
        }
        if (err.code === "invalid_response") {
          setUncertain(true);
          setError(t("errors.uncertain"));
          return;
        }
        if (err.code === "reason_required" || err.code === "validation") {
          setError(t("errors.reviewReason"));
          return;
        }
      }
      setError(t("errors.generic"));
      return;
    } finally {
      flight.current = false;
      if (mounted.current) setPending(false);
      onPending(false);
    }
    if (mounted.current) {
      setMode(null);
      setResumed(false);
      setReason("");
      onChanged(kind === "apply" ? t("done.apply") : t("done.revoke"));
    }
  }

  const openDialog = (next: "apply" | "revoke", button: HTMLButtonElement) => {
    opener.current = button;
    setReason("");
    setResumed(false);
    setError(null);
    setUncertain(false);
    setMode(next);
  };

  return (
    <section
      aria-label={t("section")}
      className="min-w-0 space-y-3 rounded border border-border-subtle p-3"
    >
      <h2 className="font-semibold">{t("section")}</h2>

      {existing ? (
        <div className="min-w-0 space-y-2">
          <p className="font-semibold">{t("strikeN", { level: existing.level })}</p>
          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            <span className="font-semibold">{t("reasonLabel")}</span> {existing.reason}
          </p>
          {existing.revoked ? (
            <>
              <p>{t("revoked")}</p>
              {existing.revocationReason && (
                <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  <span className="font-semibold">{t("revocationReason")}</span>{" "}
                  {existing.revocationReason}
                </p>
              )}
            </>
          ) : existing.permanent ? (
            <p>{t("permanent")}</p>
          ) : existing.sanctionInEffect && existing.endsAt ? (
            <p>{t("activeUntil", { date: date(existing.endsAt, locale) })}</p>
          ) : (
            <p>{t("ended")}</p>
          )}
          {!existing.canRevoke && !existing.revoked && (
            <p className="text-sm text-text-muted" data-testid="revoke-unavailable">
              {role === "developer" || role === "admin"
                ? t("revokeOwn")
                : t("revokeRole")}
            </p>
          )}
          {existing.canRevoke && !existing.revoked && (
            <button
              type="button"
              className={secondaryButton}
              disabled={pending}
              onClick={(event) => openDialog("revoke", event.currentTarget)}
            >
              {t("revokeButton")}
            </button>
          )}
        </div>
      ) : strike.eligible && strike.predictedLevel !== null ? (
        <div className="min-w-0 space-y-2">
          <p className="font-semibold">{t("next", { level: strike.predictedLevel })}</p>
          <p>{effect(strike.predictedLevel, t)}</p>
          <p className="text-sm text-text-muted">{t("separate")}</p>
          <button
            type="button"
            className={primaryButton}
            disabled={pending}
            onClick={(event) => openDialog("apply", event.currentTarget)}
          >
            {t("apply", { level: strike.predictedLevel })}
          </button>
        </div>
      ) : (
        <p>
          {strike.ineligibleReason &&
          (INELIGIBLE_KEYS as readonly string[]).includes(strike.ineligibleReason)
            ? t(
                `ineligible.${strike.ineligibleReason as (typeof INELIGIBLE_KEYS)[number]}`,
              )
            : t("ineligibleGeneric")}
        </p>
      )}

      {mode === "apply" && strike.predictedLevel !== null && (
        <StrikeDialog
          title={t("applyTitle", { level: strike.predictedLevel })}
          intro={
            <>
              <p>{effect(strike.predictedLevel, t)}</p>
              <p>{t("applyIntro")}</p>
            </>
          }
          label={t("applyLabel")}
          hint={t("hint")}
          reason={reason}
          onReason={setReason}
          pending={pending}
          uncertain={uncertain}
          error={error}
          resumed={resumed}
          submitLabel={t("confirmStrike")}
          pendingLabel={t("applying")}
          danger={false}
          onSubmit={() => void run("apply")}
          onClose={closeDialog}
        />
      )}
      {mode === "revoke" && existing && (
        <StrikeDialog
          title={t("revokeTitle", { level: existing.level })}
          intro={
            <>
              <p>{t("revokeIntro1")}</p>
              <p>{t("revokeIntro2")}</p>
            </>
          }
          label={t("revokeLabel")}
          hint={t("hint")}
          reason={reason}
          onReason={setReason}
          pending={pending}
          uncertain={uncertain}
          error={error}
          resumed={resumed}
          submitLabel={t("confirmRevocation")}
          pendingLabel={t("revoking")}
          danger
          onSubmit={() => void run("revoke")}
          onClose={closeDialog}
        />
      )}
    </section>
  );
}
