import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { decideModerationCase, ModerationClientError } from "@/lib/moderation-client";
import {
  groupedDecisionInputFromCase,
  type GroupedDecision,
} from "@/lib/moderation-decision-contract";
import type { ModerationCaseItem } from "@/lib/moderation-case-contract";

export interface DecisionDraft {
  decision: GroupedDecision;
  message: string;
}
interface Props {
  item: ModerationCaseItem;
  resume?: DecisionDraft;
  onPending: (pending: boolean) => void;
  onSuccess: (message: string) => void;
  onConflict: () => void;
  onStepUp: (draft: DecisionDraft) => void;
  onAccessError: (error: ModerationClientError) => void;
}
const button =
  "inline-flex min-h-11 items-center justify-center rounded-md border px-4 py-2 text-sm font-semibold transition duration-200 ease-smooth enabled:hover:-translate-y-0.5 enabled:active:translate-y-0 enabled:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50 motion-reduce:enabled:hover:translate-y-0 motion-reduce:enabled:active:scale-100 motion-reduce:transition-none";
const secondaryButton = `${button} border-border-subtle text-text-secondary enabled:hover:border-accent-primary/60 enabled:hover:bg-bg-elevated enabled:hover:text-text-primary`;
const primaryButton = `${button} border-accent-primary/60 bg-accent-primary text-text-inverse shadow-glow-primary enabled:hover:border-accent-secondary enabled:hover:bg-accent-secondary`;

export default function ModerationDecisionActions({
  item,
  resume,
  onPending,
  onSuccess,
  onConflict,
  onStepUp,
  onAccessError,
}: Props) {
  const client = useQueryClient();
  let canProceed = false;
  try {
    groupedDecisionInputFromCase(item, "content_actioned", "Resolución");
    canProceed = true;
  } catch {
    /* A deleted/non-incrementable snapshot cannot support Procede. */
  }
  const [decision, setDecision] = useState<GroupedDecision | null>(
    resume?.decision === "content_actioned" && !canProceed
      ? null
      : (resume?.decision ?? null),
  );
  const [message, setMessage] = useState(resume?.message ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const flight = useRef(false);
  const mounted = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const errorId = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!decision || !dialog.current) return;
    const node = dialog.current;
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
  }, [decision]);
  const close = () => {
    if (flight.current) return;
    setDecision(null);
    setError(null);
  };
  const submit = async () => {
    if (!decision || flight.current || uncertain) return;
    let input;
    try {
      input = groupedDecisionInputFromCase(
        item,
        decision,
        decision === "content_actioned" ? message : null,
      );
    } catch {
      setError(
        decision === "content_actioned"
          ? "Escribe un mensaje de resolución de hasta 1000 caracteres."
          : "No se pudo preparar la decisión. Actualiza el contexto.",
      );
      return;
    }
    flight.current = true;
    setPending(true);
    onPending(true);
    setError(null);
    try {
      await decideModerationCase(client, input);
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ModerationClientError) {
        if (err.code === "step_up_required" || err.code === "mfa_required") {
          onStepUp({ decision, message });
          return;
        }
        if (
          err.status === 409 ||
          err.code === "post_not_found" ||
          err.code === "case_not_found"
        ) {
          onConflict();
          return;
        }
        if (err.status === 401 || err.status === 403) {
          onAccessError(err);
          setError(
            err.status === 401
              ? "Inicia sesión de nuevo para continuar."
              : "Tu acceso a moderación ya no está disponible.",
          );
          return;
        }
        if (err.code === "invalid_response") {
          setUncertain(true);
          setError(
            "No pudimos confirmar el resultado. Cierra este diálogo y actualiza el contexto antes de actuar de nuevo.",
          );
          return;
        }
        if (
          err.code === "resolution_message_required" ||
          err.code === "invalid_argument"
        ) {
          setError("Revisa el mensaje y actualiza el contexto antes de confirmar.");
          return;
        }
      }
      setError(
        "No se pudo completar la decisión. Revisa tu conexión y actualiza el contexto antes de volver a intentarlo.",
      );
      return;
    } finally {
      flight.current = false;
      if (mounted.current) setPending(false);
      onPending(false);
    }
    if (mounted.current) {
      setDecision(null);
      setMessage("");
      onSuccess(
        decision === "reports_not_valid"
          ? "El caso se cerró como No procede."
          : "Se retiró la publicación y se cerró el caso.",
      );
    }
  };
  return (
    <section aria-label="Decisión del caso" className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className={secondaryButton}
          disabled={pending || uncertain}
          onClick={() => {
            setError(null);
            setDecision("reports_not_valid");
          }}
        >
          No procede
        </button>
        {canProceed && (
          <button
            type="button"
            className={primaryButton}
            disabled={pending || uncertain}
            onClick={() => {
              setError(null);
              setDecision("content_actioned");
            }}
          >
            Procede
          </button>
        )}
      </div>
      {decision &&
        createPortal(
          <dialog
            ref={dialog}
            aria-labelledby={titleId}
            aria-describedby={error ? errorId : undefined}
            onCancel={(event) => {
              event.preventDefault();
              close();
            }}
            className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl border border-border-subtle bg-bg-surface p-4 text-text-primary backdrop:bg-black/70 sm:p-6"
          >
            <h2 id={titleId} className="text-xl font-semibold">
              {decision === "content_actioned"
                ? "Confirmar Procede"
                : "Confirmar No procede"}
            </h2>
            <p className="mt-3">
              {decision === "content_actioned"
                ? "Se cerrará el caso y se retirará la publicación. Su contenido se conservará durante 72 horas. Esta decisión no aplica un strike."
                : "Se cerrará el caso y se descartarán sus reportes pendientes. Si la publicación está oculta preventivamente por este caso, se restaurará según las reglas de moderación."}
            </p>
            {resume && (
              <p role="status" className="mt-3">
                Revisa el contexto y confirma nuevamente. No se ha repetido la decisión.
              </p>
            )}
            <form
              className="mt-4 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              {decision === "content_actioned" && (
                <label className="block">
                  Mensaje de resolución para el autor
                  <textarea
                    required
                    rows={5}
                    value={message}
                    disabled={pending}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? errorId : undefined}
                    onChange={(event) => setMessage(event.target.value)}
                    className="mt-2 block w-full min-w-0 rounded border border-border-subtle bg-bg-base p-3"
                  />
                  <span className="text-sm">
                    {[...message.trim()].length}/1000 caracteres
                  </span>
                </label>
              )}
              {error && (
                <p id={errorId} role="alert">
                  {error}
                </p>
              )}
              {pending && <p role="status">Guardando decisión…</p>}
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  data-cancel
                  className={secondaryButton}
                  disabled={pending}
                  onClick={close}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className={
                    decision === "content_actioned" ? primaryButton : secondaryButton
                  }
                  disabled={pending || uncertain}
                >
                  Confirmar decisión
                </button>
              </div>
            </form>
          </dialog>,
          document.body,
        )}
    </section>
  );
}
