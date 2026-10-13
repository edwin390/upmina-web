import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useLocale, useTranslations } from "use-intl";
import UpminaLocaleProvider from "@/i18n/LocaleProvider";
import { useAuth } from "@/lib/auth-context";
import {
  APPEAL_REASON_VALUES,
  validateAppealForm,
  type AppealField,
  type AppealFormErrors,
} from "@/lib/copyright-appeal";
import type { ClaimFieldError } from "@/lib/copyright-claim";
import {
  fetchAppealContext,
  submitAppeal,
  type AppealContext,
} from "@/lib/copyright-client";
import {
  APPEAL_LOGIN_PATH,
  capturePendingAppealToken,
  clearPendingAppealToken,
  parseAppealFragment,
  readPendingAppealToken,
} from "@/lib/pending-appeal-token";

// /copyright/appeal — apelación del AUTOR de una publicación retirada por copyright (COPY-1 fase 2B). Exige iniciar sesión con la
// cuenta autora original y el token del enlace del correo (que llega en el fragmento #t= y se guarda solo en memoria). Solo texto y
// enlaces: no se piden documentos de identidad ni hay subida de archivos. La validación de aquí es UX; la autoridad es el servidor
// (copyright-appeal-submit) y la RPC, que comprueban autoría, token, estado y plazo. Presentar una apelación NO restaura nada: la
// decide una persona de moderación.

const INPUT =
  "w-full rounded-md border border-border-subtle bg-bg-base px-3 py-2 text-text-primary outline-none focus:border-accent-secondary focus-visible:ring-2 focus-visible:ring-accent-secondary";
const PRIMARY =
  "mt-2 inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50";
const FIELD_ORDER: AppealField[] = [
  "contactName",
  "contactEmail",
  "reason",
  "explanation",
  "evidence",
  "evidenceText",
  "evidenceUrls",
  "statementAccepted",
];
const FIELD_IDS: Record<AppealField, string> = {
  contactName: "appeal-name",
  contactEmail: "appeal-email",
  reason: "appeal-reason",
  explanation: "appeal-explanation",
  evidence: "appeal-evidence-text",
  evidenceText: "appeal-evidence-text",
  evidenceUrls: "appeal-evidence-urls",
  statementAccepted: "appeal-statement",
};

type Failure =
  | "invalid"
  | "error"
  | "alreadySubmitted"
  | "windowClosed"
  | "notAvailable"
  | "unauthenticated";
type Screen =
  | { kind: "incomplete" }
  | { kind: "loading" }
  | { kind: "signIn" }
  | { kind: "notAvailable" }
  | { kind: "error" }
  | { kind: "context"; appeal: AppealContext }
  | { kind: "submitted"; reference: string };

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm text-text-secondary">
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-text-secondary">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-sm text-accent-live">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function AppealForm({
  token,
  onSubmitted,
  onSignIn,
}: {
  token: string;
  onSubmitted: (reference: string) => void;
  onSignIn: () => void;
}) {
  const t = useTranslations("moderation.copyright.appeal");
  const [values, setValues] = useState({
    contactName: "",
    contactEmail: "",
    reason: "",
    explanation: "",
    evidenceText: "",
    evidenceUrls: "",
    statementAccepted: false,
  });
  const [errors, setErrors] = useState<AppealFormErrors>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) => {
    setValues((current) => ({ ...current, [key]: event.target.value }));
    const field = key as AppealField;
    if (errors[field] || errors.evidence)
      setErrors((current) => ({ ...current, [field]: undefined, evidence: undefined }));
  };
  const message = (field: AppealField, error: ClaimFieldError | undefined) => {
    if (!error) return undefined;
    if (field === "statementAccepted") return t("errors.statementRequired");
    if (field === "evidence") return t("errors.evidenceRequired");
    if (field === "evidenceUrls") {
      if (error === "invalid") return t("errors.evidenceUrlsInvalid");
      if (error === "tooLong") return t("errors.evidenceUrlsTooMany");
    }
    return t(`errors.${error}`);
  };
  const describedBy = (field: AppealField, hint: boolean) =>
    [
      hint ? `${FIELD_IDS[field]}-hint` : null,
      errors[field] ? `${FIELD_IDS[field]}-error` : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sendingRef.current) return;
    const checked = validateAppealForm(values);
    if (checked.ok === false) {
      setErrors(checked.errors);
      const first = FIELD_ORDER.find((field) => checked.errors[field]);
      if (first) document.getElementById(FIELD_IDS[first])?.focus();
      return;
    }
    setErrors({});
    setFailure(null);
    sendingRef.current = true;
    setSending(true);
    const outcome = await submitAppeal(token, checked.payload);
    sendingRef.current = false;
    setSending(false);
    if (outcome.kind === "submitted") {
      clearPendingAppealToken();
      onSubmitted(outcome.reference);
    } else if (outcome.kind === "unauthenticated") {
      setFailure("unauthenticated");
      onSignIn();
    } else if (outcome.kind === "already_submitted") setFailure("alreadySubmitted");
    else if (outcome.kind === "window_closed") setFailure("windowClosed");
    else if (outcome.kind === "not_available") setFailure("notAvailable");
    else if (outcome.kind === "invalid") setFailure("invalid");
    else setFailure("error");
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
      <p className="text-sm text-text-secondary">{t("noUploads")}</p>
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-sm font-semibold uppercase tracking-wide text-text-primary">
          {t("legend.contact")}
        </legend>
        <Field
          id={FIELD_IDS.contactName}
          label={t("fields.contactName")}
          error={message("contactName", errors.contactName)}
        >
          <input
            id={FIELD_IDS.contactName}
            className={INPUT}
            autoComplete="name"
            maxLength={200}
            value={values.contactName}
            onChange={set("contactName")}
            aria-invalid={Boolean(errors.contactName)}
            aria-describedby={describedBy("contactName", false)}
          />
        </Field>
        <Field
          id={FIELD_IDS.contactEmail}
          label={t("fields.contactEmail")}
          error={message("contactEmail", errors.contactEmail)}
        >
          <input
            id={FIELD_IDS.contactEmail}
            className={INPUT}
            type="email"
            autoComplete="email"
            maxLength={300}
            value={values.contactEmail}
            onChange={set("contactEmail")}
            aria-invalid={Boolean(errors.contactEmail)}
            aria-describedby={describedBy("contactEmail", false)}
          />
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-sm font-semibold uppercase tracking-wide text-text-primary">
          {t("legend.appeal")}
        </legend>
        <Field
          id={FIELD_IDS.reason}
          label={t("fields.reason")}
          error={message("reason", errors.reason)}
        >
          <select
            id={FIELD_IDS.reason}
            className={INPUT}
            value={values.reason}
            onChange={set("reason")}
            aria-invalid={Boolean(errors.reason)}
            aria-describedby={describedBy("reason", false)}
          >
            <option value="">{t("reasons.placeholder")}</option>
            {APPEAL_REASON_VALUES.map((value) => (
              <option key={value} value={value}>
                {t(`reasons.${value}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id={FIELD_IDS.explanation}
          label={t("fields.explanation")}
          hint={t("hints.explanation")}
          error={message("explanation", errors.explanation)}
        >
          <textarea
            id={FIELD_IDS.explanation}
            className={INPUT}
            rows={5}
            value={values.explanation}
            onChange={set("explanation")}
            aria-invalid={Boolean(errors.explanation)}
            aria-describedby={describedBy("explanation", true)}
          />
        </Field>
        <Field
          id={FIELD_IDS.evidenceText}
          label={t("fields.evidenceText")}
          hint={t("hints.evidence")}
          error={
            message("evidenceText", errors.evidenceText) ??
            message("evidence", errors.evidence)
          }
        >
          <textarea
            id={FIELD_IDS.evidenceText}
            className={INPUT}
            rows={4}
            value={values.evidenceText}
            onChange={set("evidenceText")}
            aria-invalid={Boolean(errors.evidenceText || errors.evidence)}
            aria-describedby={
              [
                `${FIELD_IDS.evidenceText}-hint`,
                errors.evidenceText || errors.evidence
                  ? `${FIELD_IDS.evidenceText}-error`
                  : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
          />
        </Field>
        <Field
          id={FIELD_IDS.evidenceUrls}
          label={t("fields.evidenceUrls")}
          hint={t("hints.evidenceUrls")}
          error={message("evidenceUrls", errors.evidenceUrls)}
        >
          <textarea
            id={FIELD_IDS.evidenceUrls}
            className={INPUT}
            rows={3}
            inputMode="url"
            autoComplete="off"
            value={values.evidenceUrls}
            onChange={set("evidenceUrls")}
            aria-invalid={Boolean(errors.evidenceUrls)}
            aria-describedby={describedBy("evidenceUrls", true)}
          />
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold uppercase tracking-wide text-text-primary">
          {t("legend.statement")}
        </legend>
        <label className="flex items-start gap-2 text-sm text-text-primary">
          <input
            id={FIELD_IDS.statementAccepted}
            type="checkbox"
            className="mt-1 h-4 w-4 accent-accent-primary"
            checked={values.statementAccepted}
            onChange={(event) => {
              setValues((current) => ({
                ...current,
                statementAccepted: event.target.checked,
              }));
              if (errors.statementAccepted)
                setErrors((current) => ({ ...current, statementAccepted: undefined }));
            }}
            aria-invalid={Boolean(errors.statementAccepted)}
            aria-describedby={describedBy("statementAccepted", false)}
          />
          <span>{t("statement")}</span>
        </label>
        {errors.statementAccepted ? (
          <p
            id={`${FIELD_IDS.statementAccepted}-error`}
            className="text-sm text-accent-live"
          >
            {message("statementAccepted", errors.statementAccepted)}
          </p>
        ) : null}
      </fieldset>

      {failure ? (
        <p role="alert" className="text-sm text-accent-live">
          {t(`failures.${failure}`)}
        </p>
      ) : null}
      <button type="submit" disabled={sending} className={PRIMARY}>
        {sending ? t("submitting") : t("submit")}
      </button>
    </form>
  );
}

function CopyrightAppeal() {
  const t = useTranslations("moderation.copyright.appeal");
  const locale = useLocale();
  const location = useLocation();
  const { session, loading } = useAuth();
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const headingRef = useRef<HTMLHeadingElement>(null);

  // El token del enlace sale de la URL de inmediato (el fragmento nunca queda visible) y se guarda solo en memoria. Este efecto va
  // ANTES del que lee el token, de modo que ya está capturado cuando se consulta.
  useEffect(() => {
    const fragment = parseAppealFragment(window.location.hash);
    if (!fragment.present) return;
    if (fragment.token) capturePendingAppealToken(fragment.token);
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}${fragment.remainder}`,
    );
  }, []);

  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (loading) return;
    const token = readPendingAppealToken();
    if (!token) {
      setScreen({ kind: "incomplete" });
      return;
    }
    if (!userId) {
      setScreen({ kind: "signIn" });
      return;
    }
    const controller = new AbortController();
    setScreen({ kind: "loading" });
    void fetchAppealContext(token, controller.signal).then((outcome) => {
      if (controller.signal.aborted) return;
      if (outcome.kind === "ok") setScreen({ kind: "context", appeal: outcome.appeal });
      else if (outcome.kind === "unauthenticated") setScreen({ kind: "signIn" });
      else if (outcome.kind === "not_available") setScreen({ kind: "notAvailable" });
      else setScreen({ kind: "error" });
    });
    return () => controller.abort();
  }, [loading, userId, location.key]);

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );

  let body: ReactNode;
  if (screen.kind === "loading") body = <p role="status">{t("loading")}</p>;
  else if (screen.kind === "incomplete")
    body = (
      <div role="alert">
        <h2 ref={headingRef} className="font-display text-xl">
          {t("incomplete.title")}
        </h2>
        <p className="mt-2 text-sm text-text-secondary">{t("incomplete.body")}</p>
      </div>
    );
  else if (screen.kind === "signIn")
    body = (
      <div>
        <h2 className="font-display text-xl">{t("signIn.title")}</h2>
        <p className="mt-2 text-sm text-text-secondary">{t("signIn.body")}</p>
        <Link to={APPEAL_LOGIN_PATH} className={`${PRIMARY} no-underline`}>
          {t("signIn.button")}
        </Link>
      </div>
    );
  else if (screen.kind === "notAvailable")
    body = (
      <div role="alert">
        <h2 className="font-display text-xl">{t("notAvailable.title")}</h2>
        <p className="mt-2 text-sm text-text-secondary">{t("notAvailable.body")}</p>
      </div>
    );
  else if (screen.kind === "error")
    body = (
      <p role="alert" className="text-sm text-accent-live">
        {t("failures.error")}
      </p>
    );
  else if (screen.kind === "submitted")
    body = (
      <div role="status" className="flex flex-col gap-3">
        <h2 ref={headingRef} tabIndex={-1} className="font-display text-2xl outline-none">
          {t("submitted.title")}
        </h2>
        <p className="text-sm text-text-secondary">{t("submitted.body")}</p>
        <p className="text-sm text-text-secondary">
          {t("reference")}:{" "}
          <span className="font-mono font-semibold text-text-primary">
            {screen.reference}
          </span>
        </p>
      </div>
    );
  else {
    const { appeal } = screen;
    const summary = (
      <dl className="mb-6 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="font-semibold">{t("reference")}</dt>
        <dd className="font-mono">{appeal.reference}</dd>
        <dt className="font-semibold">{t("removalReason")}</dt>
        <dd className="whitespace-pre-wrap break-words">{appeal.reason}</dd>
        {appeal.appealDeadline ? (
          <>
            <dt className="font-semibold">{t("deadline")}</dt>
            <dd>{formatDate(appeal.appealDeadline)}</dd>
          </>
        ) : null}
      </dl>
    );
    if (appeal.state === "open")
      body = (
        <>
          {summary}
          <AppealForm
            token={readPendingAppealToken() ?? ""}
            onSubmitted={(reference) => {
              setScreen({ kind: "submitted", reference });
              setTimeout(() => headingRef.current?.focus(), 0);
            }}
            onSignIn={() => setScreen({ kind: "signIn" })}
          />
        </>
      );
    else
      body = (
        <>
          {summary}
          <div role="status">
            <h2 className="font-display text-xl">{t(`state.${appeal.state}.title`)}</h2>
            <p className="mt-2 text-sm text-text-secondary">
              {t(`state.${appeal.state}.body`)}
            </p>
            {appeal.state === "submitted" && appeal.appealStatus ? (
              <p className="mt-2 text-sm text-text-secondary">
                {t(`appealStatus.${appeal.appealStatus}`)}
              </p>
            ) : null}
          </div>
        </>
      );
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
        <p className="mt-4 text-sm text-text-secondary">{t("intro")}</p>
        <div className="mt-6">{body}</div>
      </div>
    </div>
  );
}

export default function CopyrightAppealPage() {
  return (
    <UpminaLocaleProvider>
      <CopyrightAppeal />
    </UpminaLocaleProvider>
  );
}
