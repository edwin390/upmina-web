import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslations } from "use-intl";
import UpminaLocaleProvider from "@/i18n/LocaleProvider";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";
import { fetchAdminAccess } from "@/lib/admin-access";
import {
  confirmAccountDeletion,
  previewAccountDeletion,
  requestAccountDeletion,
  type DeletionPreviewOutcome,
} from "@/lib/account-deletion-client";
import {
  DELETION_LOGIN_PATH,
  capturePendingDeletionToken,
  clearPendingDeletionToken,
  parseDeletionFragment,
  readPendingDeletionToken,
} from "@/lib/pending-deletion-token";

// /account/delete (DEL-3) — eliminación IRREVERSIBLE de la propia cuenta. Esta pantalla solo PRESENTA; la autoridad es el servidor
// (account-deletion-request / -preview / -confirm de DEL-2, que verifican sesión, cuenta no privilegiada, token, caducidad y uso único).
//
// Seguridad del token (enlace del correo: /account/delete#t=<token>):
//   * se lee del fragmento y se RETIRA de la URL de inmediato (history.replaceState), conservando ruta y parámetros no sensibles;
//   * vive solo en memoria (pending-deletion-token.ts): nunca en localStorage/sessionStorage/cookies/URL/analítica/logs ni en el DOM;
//   * abrir la página NO consume ni confirma nada: la vista previa es de solo lectura y la eliminación exige la acción final explícita
//     (casilla + botón específico) y se bloquea el doble envío;
//   * un resultado ambiguo (red, timeout, 5xx) NUNCA se presenta como «no ocurrió» ni como «eliminada»: se ofrece comprobar el estado.
// Tras una confirmación aceptada se limpia la sesión LOCAL y la pantalla final se renderiza desde estado propio, sin consultas
// autenticadas (el backend ya rechaza esa sesión) y sin redirecciones: no hay bucle posible.

const PRIMARY =
  "mt-2 inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50";
const DANGER =
  "mt-2 inline-flex min-h-11 items-center justify-center rounded-md border border-accent-live bg-accent-live px-5 py-2.5 text-sm font-bold uppercase tracking-[0.12em] text-text-inverse transition duration-200 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50";
const SECONDARY =
  "mt-2 inline-flex min-h-11 items-center justify-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";

const WARNING_KEYS = [
  "irreversible",
  "access",
  "deleted",
  "username",
  "retained",
  "cleanup",
  "limits",
] as const;

type Screen =
  | { kind: "loading" }
  | { kind: "signIn" }
  | { kind: "privileged" }
  | { kind: "initial" }
  | { kind: "sent" }
  | { kind: "validating" }
  | { kind: "valid" }
  | { kind: "expired" }
  | { kind: "invalid" }
  | { kind: "previewError" }
  | { kind: "ambiguous" }
  | { kind: "deleting" };

type RequestError =
  "rateLimited" | "mailFailed" | "unavailable" | "alreadyDeleting" | "generic";

function AccountDeletion() {
  const t = useTranslations("auth.accountDeletion");
  const location = useLocation();
  const { session, loading, signOut } = useAuth();
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [requestError, setRequestError] = useState<RequestError | null>(null);
  const [confirmError, setConfirmError] = useState<
    "invalid" | "expired" | "generic" | null
  >(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [ackMissing, setAckMissing] = useState(false);
  const [busy, setBusy] = useState<"request" | "confirm" | "recheck" | null>(null);
  const busyRef = useRef(false);
  const doneRef = useRef(false);
  const badLinkRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // El token sale de la URL de inmediato (el fragmento nunca queda visible) y se guarda SOLO en memoria. Este efecto va ANTES del que
  // lo lee. Un fragmento con `t` mal formado se trata como enlace inválido (nunca se guarda ni se envía).
  useEffect(() => {
    const fragment = parseDeletionFragment(window.location.hash);
    if (!fragment.present) return;
    if (fragment.token) capturePendingDeletionToken(fragment.token);
    else badLinkRef.current = true;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}${fragment.remainder}`,
    );
  }, []);

  const userId = session?.user.id ?? null;

  /** Estado final estable: se renderiza solo desde estado propio y limpia la sesión local sin red. */
  const finish = () => {
    doneRef.current = true;
    clearPendingDeletionToken();
    setScreen({ kind: "deleting" });
    setTimeout(() => headingRef.current?.focus(), 0);
    try {
      void supabase?.auth.signOut({ scope: "local" }).catch(() => undefined);
    } catch {
      /* el estado final no depende de esto */
    }
  };

  const applyPreview = (outcome: DeletionPreviewOutcome) => {
    if (outcome.kind === "unauthenticated") setScreen({ kind: "signIn" });
    else if (outcome.kind === "error") setScreen({ kind: "previewError" });
    else if (outcome.state === "valid") setScreen({ kind: "valid" });
    else if (outcome.state === "expired") setScreen({ kind: "expired" });
    else if (outcome.state === "already_deleting") finish();
    else setScreen({ kind: "invalid" });
  };

  useEffect(() => {
    if (doneRef.current) return;
    if (loading) return;
    if (!userId) {
      setScreen({ kind: "signIn" });
      return;
    }
    const controller = new AbortController();
    setScreen({ kind: "loading" });
    void (async () => {
      // Aviso temprano para cuentas con rol de equipo. NO es una frontera de seguridad: el servidor rechaza igualmente la solicitud y
      // la confirmación (privileged_account). Si no se puede comprobar, se continúa y decide el servidor.
      try {
        const access = await fetchAdminAccess(controller.signal, userId);
        if (controller.signal.aborted) return;
        if (access.role) {
          setScreen({ kind: "privileged" });
          return;
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      if (badLinkRef.current && !readPendingDeletionToken()) {
        setScreen({ kind: "invalid" });
        return;
      }
      const token = readPendingDeletionToken();
      if (!token) {
        setScreen({ kind: "initial" });
        return;
      }
      setScreen({ kind: "validating" });
      const outcome = await previewAccountDeletion(token, controller.signal);
      if (controller.signal.aborted || doneRef.current) return;
      applyPreview(outcome);
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, userId, location.key]);

  async function onRequest() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy("request");
    setRequestError(null);
    const outcome = await requestAccountDeletion();
    busyRef.current = false;
    setBusy(null);
    if (outcome.kind === "sent") setScreen({ kind: "sent" });
    else if (outcome.kind === "privileged") setScreen({ kind: "privileged" });
    else if (outcome.kind === "unauthenticated") setScreen({ kind: "signIn" });
    else if (outcome.kind === "already_deleting") setRequestError("alreadyDeleting");
    else if (outcome.kind === "rate_limited") setRequestError("rateLimited");
    else if (outcome.kind === "mail_failed") setRequestError("mailFailed");
    else if (outcome.kind === "unavailable") setRequestError("unavailable");
    else setRequestError("generic");
  }

  async function onConfirm() {
    if (busyRef.current) return; // doble envío
    if (!acknowledged) {
      setAckMissing(true);
      return;
    }
    const token = readPendingDeletionToken();
    if (!token) {
      setScreen({ kind: "expired" });
      return;
    }
    busyRef.current = true;
    setBusy("confirm");
    setConfirmError(null);
    const outcome = await confirmAccountDeletion(token);
    busyRef.current = false;
    setBusy(null);
    switch (outcome.kind) {
      case "accepted":
      case "already_deleting":
        finish();
        break;
      case "invalid_token":
        setScreen({ kind: "invalid" });
        break;
      case "expired":
        setScreen({ kind: "expired" });
        break;
      case "privileged":
        setScreen({ kind: "privileged" });
        break;
      case "unauthenticated":
      case "ambiguous":
        // Sin respuesta utilizable (o sesión rechazada): el resultado es DESCONOCIDO. No se afirma nada.
        setScreen({ kind: "ambiguous" });
        break;
      default:
        setConfirmError("generic");
    }
  }

  async function onRecheck() {
    if (busyRef.current) return;
    const token = readPendingDeletionToken();
    busyRef.current = true;
    setBusy("recheck");
    const outcome = token
      ? await previewAccountDeletion(token)
      : ({ kind: "error" } as DeletionPreviewOutcome);
    busyRef.current = false;
    setBusy(null);
    if (outcome.kind === "ok") applyPreview(outcome);
    // Sigue sin poder comprobarse: se mantiene la pantalla de resultado desconocido.
  }

  const warnings = (
    <section aria-labelledby="del-warnings" className="mt-6">
      <h2 id="del-warnings" className="font-display text-lg">
        {t("warningsTitle")}
      </h2>
      <ul className="mt-2 list-disc space-y-2 pl-5 text-sm text-text-secondary">
        {WARNING_KEYS.map((key) => (
          <li key={key}>{t(`warnings.${key}`)}</li>
        ))}
      </ul>
      <p className="mt-3 text-sm">
        <Link to="/privacy" className="font-medium text-accent-primary hover:underline">
          {t("privacyLink")}
        </Link>
      </p>
    </section>
  );

  let body: ReactNode;
  switch (screen.kind) {
    case "loading":
      body = <p role="status">{t("checking")}</p>;
      break;
    case "validating":
      body = <p role="status">{t("validating")}</p>;
      break;
    case "signIn":
      body = (
        <div>
          <h2 className="font-display text-xl">{t("signIn.title")}</h2>
          <p className="mt-2 text-sm text-text-secondary">{t("signIn.body")}</p>
          <Link to={DELETION_LOGIN_PATH} className={`${PRIMARY} no-underline`}>
            {t("signIn.button")}
          </Link>
        </div>
      );
      break;
    case "privileged":
      body = (
        <div role="alert">
          <h2 className="font-display text-xl">{t("privileged.title")}</h2>
          <p className="mt-2 text-sm text-text-secondary">{t("privileged.body")}</p>
        </div>
      );
      break;
    case "initial":
      body = (
        <div>
          {warnings}
          <section className="mt-6" aria-labelledby="del-request">
            <p id="del-request" className="text-sm text-text-secondary">
              {t("request.intro")}
            </p>
            {requestError ? (
              <p role="alert" className="mt-3 text-sm text-accent-live">
                {t(`requestErrors.${requestError}`)}
              </p>
            ) : null}
            <button
              type="button"
              className={PRIMARY}
              disabled={busy === "request"}
              onClick={() => void onRequest()}
            >
              {busy === "request" ? t("request.sending") : t("request.button")}
            </button>
          </section>
        </div>
      );
      break;
    case "sent":
      body = (
        <div role="status">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="font-display text-xl outline-none"
          >
            {t("sent.title")}
          </h2>
          <p className="mt-2 text-sm text-text-secondary">{t("sent.body")}</p>
        </div>
      );
      break;
    case "valid":
      body = (
        <div>
          <h2 className="font-display text-xl">{t("valid.title")}</h2>
          <p className="mt-2 text-sm text-text-secondary">{t("valid.body")}</p>
          {warnings}
          <div className="mt-6 rounded-md border border-accent-live/60 p-4">
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 h-5 w-5"
                checked={acknowledged}
                disabled={busy === "confirm"}
                onChange={(event) => {
                  setAcknowledged(event.target.checked);
                  if (event.target.checked) setAckMissing(false);
                }}
                aria-describedby={ackMissing ? "del-ack-error" : undefined}
                aria-invalid={ackMissing}
              />
              <span>{t("valid.ack")}</span>
            </label>
            {ackMissing ? (
              <p
                id="del-ack-error"
                role="alert"
                className="mt-2 text-sm text-accent-live"
              >
                {t("valid.ackRequired")}
              </p>
            ) : null}
            {confirmError ? (
              <p role="alert" className="mt-3 text-sm text-accent-live">
                {t(`confirmErrors.${confirmError}`)}
              </p>
            ) : null}
            <button
              type="button"
              className={DANGER}
              disabled={busy === "confirm"}
              onClick={() => void onConfirm()}
            >
              {busy === "confirm" ? t("valid.confirming") : t("valid.confirm")}
            </button>
          </div>
        </div>
      );
      break;
    case "expired":
      body = (
        <div role="alert">
          <h2 className="font-display text-xl">{t("expired.title")}</h2>
          <p className="mt-2 text-sm text-text-secondary">{t("expired.body")}</p>
          <button
            type="button"
            className={PRIMARY}
            onClick={() => {
              clearPendingDeletionToken();
              setScreen({ kind: "initial" });
            }}
          >
            {t("expired.again")}
          </button>
        </div>
      );
      break;
    case "invalid":
      body = (
        <div role="alert">
          <h2 className="font-display text-xl">{t("invalid.title")}</h2>
          <p className="mt-2 text-sm text-text-secondary">{t("invalid.body")}</p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className={PRIMARY}
              onClick={() => {
                clearPendingDeletionToken();
                badLinkRef.current = false;
                setScreen({ kind: "initial" });
              }}
            >
              {t("invalid.again")}
            </button>
            <button
              type="button"
              className={SECONDARY}
              onClick={() => {
                clearPendingDeletionToken();
                void signOut();
              }}
            >
              {t("invalid.signOut")}
            </button>
          </div>
        </div>
      );
      break;
    case "previewError":
      body = (
        <div role="alert">
          <p className="text-sm text-accent-live">{t("requestErrors.unavailable")}</p>
          <button
            type="button"
            className={SECONDARY}
            disabled={busy === "recheck"}
            onClick={() => void onRecheck()}
          >
            {busy === "recheck" ? t("ambiguous.rechecking") : t("ambiguous.recheck")}
          </button>
        </div>
      );
      break;
    case "ambiguous":
      body = (
        <div role="alert">
          <h2 className="font-display text-xl">{t("ambiguous.title")}</h2>
          <p className="mt-2 text-sm text-text-secondary">{t("ambiguous.body")}</p>
          <button
            type="button"
            className={SECONDARY}
            disabled={busy === "recheck"}
            onClick={() => void onRecheck()}
          >
            {busy === "recheck" ? t("ambiguous.rechecking") : t("ambiguous.recheck")}
          </button>
        </div>
      );
      break;
    case "deleting":
      body = (
        <div role="status" className="flex flex-col gap-3">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="font-display text-2xl outline-none"
          >
            {t("deleting.title")}
          </h2>
          <p className="text-sm text-text-secondary">{t("deleting.body")}</p>
          <p className="text-sm text-text-secondary">{t("deleting.retained")}</p>
          <Link to="/" className={`${SECONDARY} no-underline`}>
            {t("deleting.home")}
          </Link>
        </div>
      );
      break;
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <div className="rounded-xl border border-accent-primary/40 bg-bg-surface p-6 sm:p-8">
        <h1 className="font-display text-3xl tracking-wide text-text-primary">
          {t("title")}
        </h1>
        <div
          className="mt-2 h-0.5 w-12 rounded-full bg-gradient-accent"
          aria-hidden="true"
        />
        {screen.kind === "deleting" ? null : (
          <p className="mt-4 text-sm text-text-secondary">{t("intro")}</p>
        )}
        <div className="mt-6">{body}</div>
      </div>
    </div>
  );
}

export default function AccountDeletionPage() {
  return (
    <UpminaLocaleProvider>
      <AccountDeletion />
    </UpminaLocaleProvider>
  );
}
