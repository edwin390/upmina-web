import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslations } from "use-intl";
import {
  CLAIM_RELATIONSHIPS,
  validateClaimForm,
  type ClaimField,
  type ClaimFieldError,
  type ClaimFormErrors,
} from "@/lib/copyright-claim";
import { submitCopyrightClaim } from "@/lib/copyright-client";
import UpminaLocaleProvider from "@/i18n/LocaleProvider";

// /copyright — formulario PÚBLICO de reclamaciones de copyright (COPY-1 fase 2A). Sin cuenta, sin sesión, sin archivos: texto y
// ENLACES. Enviar NO retira ni oculta nada: una persona de moderación revisa cada reclamación. La validación de aquí es UX; la
// autoridad es el servidor (copyright-claim-create) y la RPC. Un campo oculto (señuelo) frena a los bots sin molestar a nadie.

const INPUT =
  "w-full rounded-md border border-border-subtle bg-bg-base px-3 py-2 text-text-primary outline-none focus:border-accent-secondary focus-visible:ring-2 focus-visible:ring-accent-secondary";
const PRIMARY =
  "mt-2 inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50";
const FIELD_ORDER: ClaimField[] = [
  "claimantName",
  "claimantEmail",
  "organization",
  "relationship",
  "workDescription",
  "infringementDescription",
  "evidenceUrls",
  "postUrl",
  "signature",
  "statementsAccepted",
];
const FIELD_IDS: Record<ClaimField, string> = {
  claimantName: "copyright-name",
  claimantEmail: "copyright-email",
  organization: "copyright-organization",
  relationship: "copyright-relationship",
  workDescription: "copyright-work",
  infringementDescription: "copyright-infringement",
  evidenceUrls: "copyright-evidence",
  postUrl: "copyright-post-url",
  signature: "copyright-signature",
  statementsAccepted: "copyright-statements",
};

type Phase =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "received"; reference: string | null }
  | {
      kind: "failed";
      reason: "rateLimited" | "invalid" | "unavailable";
      minutes?: number;
    };

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

function ClaimForm() {
  const t = useTranslations("moderation.copyright.form");
  const [values, setValues] = useState({
    claimantName: "",
    claimantEmail: "",
    organization: "",
    relationship: "",
    workDescription: "",
    infringementDescription: "",
    evidenceUrls: "",
    postUrl: "",
    signature: "",
    statementsAccepted: false,
  });
  const [honeypot, setHoneypot] = useState("");
  const [errors, setErrors] = useState<ClaimFormErrors>({});
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const sendingRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const sending = phase.kind === "sending";
  const set = (key: keyof typeof values) => (event: { target: { value: string } }) => {
    setValues((current) => ({ ...current, [key]: event.target.value }));
    if (errors[key as ClaimField])
      setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const message = (field: ClaimField, error: ClaimFieldError | undefined) => {
    if (!error) return undefined;
    if (field === "statementsAccepted") return t("errors.statementsRequired");
    if (field === "evidenceUrls") {
      if (error === "invalid") return t("errors.evidenceUrlsInvalid");
      if (error === "tooLong") return t("errors.evidenceUrlsTooMany");
    }
    return t(`errors.${error}`);
  };
  const describedBy = (field: ClaimField, hint: boolean) =>
    [
      hint ? `${FIELD_IDS[field]}-hint` : null,
      errors[field] ? `${FIELD_IDS[field]}-error` : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sendingRef.current) return;
    const checked = validateClaimForm(values);
    if (!checked.ok) {
      setErrors(checked.errors);
      const first = FIELD_ORDER.find((field) => checked.errors[field]);
      if (first) document.getElementById(FIELD_IDS[first])?.focus();
      return;
    }
    setErrors({});
    sendingRef.current = true;
    setPhase({ kind: "sending" });
    const outcome = await submitCopyrightClaim(checked.payload, honeypot);
    sendingRef.current = false;
    if (outcome.kind === "received") {
      setPhase({ kind: "received", reference: outcome.reference });
      setTimeout(() => headingRef.current?.focus(), 0);
    } else if (outcome.kind === "rate_limited") {
      setPhase({
        kind: "failed",
        reason: "rateLimited",
        minutes: Math.max(1, Math.ceil(outcome.retryAfterSeconds / 60)),
      });
    } else {
      setPhase({
        kind: "failed",
        reason: outcome.kind === "invalid" ? "invalid" : "unavailable",
      });
    }
  }

  if (phase.kind === "received") {
    return (
      <div role="status" className="flex flex-col gap-3">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-2xl text-text-primary outline-none"
        >
          {t("received.title")}
        </h2>
        <p className="text-sm text-text-secondary">{t("received.body")}</p>
        {phase.reference ? (
          <p className="text-sm text-text-secondary">
            {t("received.reference")}:{" "}
            <span className="font-mono font-semibold text-text-primary">
              {phase.reference}
            </span>
            <br />
            <span className="text-xs">{t("received.referenceHint")}</span>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-sm font-semibold uppercase tracking-wide text-text-primary">
          {t("legend.claimant")}
        </legend>
        <Field
          id={FIELD_IDS.claimantName}
          label={t("fields.claimantName")}
          error={message("claimantName", errors.claimantName)}
        >
          <input
            id={FIELD_IDS.claimantName}
            className={INPUT}
            autoComplete="name"
            maxLength={200}
            value={values.claimantName}
            onChange={set("claimantName")}
            aria-invalid={Boolean(errors.claimantName)}
            aria-describedby={describedBy("claimantName", false)}
          />
        </Field>
        <Field
          id={FIELD_IDS.claimantEmail}
          label={t("fields.claimantEmail")}
          error={message("claimantEmail", errors.claimantEmail)}
        >
          <input
            id={FIELD_IDS.claimantEmail}
            className={INPUT}
            type="email"
            autoComplete="email"
            maxLength={300}
            value={values.claimantEmail}
            onChange={set("claimantEmail")}
            aria-invalid={Boolean(errors.claimantEmail)}
            aria-describedby={describedBy("claimantEmail", false)}
          />
        </Field>
        <Field
          id={FIELD_IDS.organization}
          label={t("fields.organization")}
          error={message("organization", errors.organization)}
        >
          <input
            id={FIELD_IDS.organization}
            className={INPUT}
            autoComplete="organization"
            maxLength={200}
            value={values.organization}
            onChange={set("organization")}
            aria-invalid={Boolean(errors.organization)}
            aria-describedby={describedBy("organization", false)}
          />
        </Field>
        <Field
          id={FIELD_IDS.relationship}
          label={t("fields.relationship")}
          error={message("relationship", errors.relationship)}
        >
          <select
            id={FIELD_IDS.relationship}
            className={INPUT}
            value={values.relationship}
            onChange={set("relationship")}
            aria-invalid={Boolean(errors.relationship)}
            aria-describedby={describedBy("relationship", false)}
          >
            <option value="">{t("relationship.placeholder")}</option>
            {CLAIM_RELATIONSHIPS.map((value) => (
              <option key={value} value={value}>
                {t(`relationship.${value}`)}
              </option>
            ))}
          </select>
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-sm font-semibold uppercase tracking-wide text-text-primary">
          {t("legend.work")}
        </legend>
        <Field
          id={FIELD_IDS.workDescription}
          label={t("fields.workDescription")}
          hint={t("hints.workDescription")}
          error={message("workDescription", errors.workDescription)}
        >
          <textarea
            id={FIELD_IDS.workDescription}
            className={INPUT}
            rows={4}
            value={values.workDescription}
            onChange={set("workDescription")}
            aria-invalid={Boolean(errors.workDescription)}
            aria-describedby={describedBy("workDescription", true)}
          />
        </Field>
        <Field
          id={FIELD_IDS.postUrl}
          label={t("fields.postUrl")}
          hint={t("hints.postUrl")}
          error={message("postUrl", errors.postUrl)}
        >
          <input
            id={FIELD_IDS.postUrl}
            className={INPUT}
            inputMode="url"
            autoComplete="off"
            value={values.postUrl}
            onChange={set("postUrl")}
            aria-invalid={Boolean(errors.postUrl)}
            aria-describedby={describedBy("postUrl", true)}
          />
        </Field>
        <Field
          id={FIELD_IDS.infringementDescription}
          label={t("fields.infringementDescription")}
          hint={t("hints.infringementDescription")}
          error={message("infringementDescription", errors.infringementDescription)}
        >
          <textarea
            id={FIELD_IDS.infringementDescription}
            className={INPUT}
            rows={4}
            value={values.infringementDescription}
            onChange={set("infringementDescription")}
            aria-invalid={Boolean(errors.infringementDescription)}
            aria-describedby={describedBy("infringementDescription", true)}
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
            rows={4}
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
          {t("legend.statements")}
        </legend>
        <p className="text-sm text-text-secondary">{t("statements.intro")}</p>
        <ul className="list-disc pl-5 text-sm text-text-secondary">
          <li>{t("statements.rightsHolder")}</li>
          <li>{t("statements.goodFaith")}</li>
          <li>{t("statements.accurate")}</li>
        </ul>
        <label className="flex items-start gap-2 text-sm text-text-primary">
          <input
            id={FIELD_IDS.statementsAccepted}
            type="checkbox"
            className="mt-1 h-4 w-4 accent-accent-primary"
            checked={values.statementsAccepted}
            onChange={(event) => {
              setValues((current) => ({
                ...current,
                statementsAccepted: event.target.checked,
              }));
              if (errors.statementsAccepted)
                setErrors((current) => ({ ...current, statementsAccepted: undefined }));
            }}
            aria-invalid={Boolean(errors.statementsAccepted)}
            aria-describedby={describedBy("statementsAccepted", false)}
          />
          <span>{t("statements.accept")}</span>
        </label>
        {errors.statementsAccepted ? (
          <p
            id={`${FIELD_IDS.statementsAccepted}-error`}
            className="text-sm text-accent-live"
          >
            {message("statementsAccepted", errors.statementsAccepted)}
          </p>
        ) : null}
        <Field
          id={FIELD_IDS.signature}
          label={t("fields.signature")}
          hint={t("hints.signature")}
          error={message("signature", errors.signature)}
        >
          <input
            id={FIELD_IDS.signature}
            className={INPUT}
            autoComplete="off"
            maxLength={200}
            value={values.signature}
            onChange={set("signature")}
            aria-invalid={Boolean(errors.signature)}
            aria-describedby={describedBy("signature", true)}
          />
        </Field>
      </fieldset>

      {/* Señuelo anti-bots: invisible y fuera del orden de tabulación; una persona nunca lo rellena. */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "-10000px",
          width: 1,
          height: 1,
          overflow: "hidden",
        }}
      >
        <label htmlFor="copyright-website">Website</label>
        <input
          id="copyright-website"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(event) => setHoneypot(event.target.value)}
        />
      </div>

      {phase.kind === "failed" ? (
        <p role="alert" className="text-sm text-accent-live">
          {phase.reason === "rateLimited"
            ? t("failures.rateLimited", { minutes: phase.minutes ?? 1 })
            : t(`failures.${phase.reason}`)}
        </p>
      ) : null}
      <button type="submit" disabled={sending} className={PRIMARY}>
        {sending ? t("submitting") : t("submit")}
      </button>
    </form>
  );
}

function CopyrightClaim() {
  const t = useTranslations("moderation.copyright.form");
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
        <p className="mt-2 text-sm text-text-secondary">{t("manualReview")}</p>
        <div className="mt-6">
          <ClaimForm />
        </div>
      </div>
    </div>
  );
}

export default function CopyrightClaimPage() {
  return (
    <UpminaLocaleProvider>
      <CopyrightClaim />
    </UpminaLocaleProvider>
  );
}
