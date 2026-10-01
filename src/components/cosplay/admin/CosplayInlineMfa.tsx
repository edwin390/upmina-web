import { useEffect, useRef } from "react";
import { useTranslations } from "use-intl";
import { useMfaVerification } from "@/hooks/useMfaVerification";
import { buildTotpQrImageSrc } from "@/lib/mfa-qr";

interface Props {
  isCurrent: () => Promise<boolean>;
  onVerified: () => void;
  onCancel: () => void;
}

export default function CosplayInlineMfa({ isCurrent, onVerified, onCancel }: Props) {
  const t = useTranslations("cosplay.admin.mfa");
  const mfa = useMfaVerification({ explicit: true, isCurrent });
  const notified = useRef(false);
  const section = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.focus();
    else section.current?.focus();
  }, [mfa.step.kind]);
  useEffect(() => {
    if (mfa.step.kind !== "verified" || notified.current) return;
    notified.current = true;
    onVerified();
  }, [mfa.step.kind, onVerified]);
  const factorId =
    mfa.step.kind === "challenge" || mfa.step.kind === "enrolling"
      ? mfa.step.factorId
      : null;
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-label={t("heading")}
      className="flex flex-col gap-4"
    >
      <h3 className="font-semibold">{t("heading")}</h3>
      <p>{t("body")}</p>
      {mfa.step.kind === "checking" && <p role="status">{t("checking")}</p>}
      {(mfa.step.kind === "fatal" ||
        mfa.step.kind === "no-session" ||
        mfa.step.kind === "session-invalid") && <p role="alert">{t("accessFailed")}</p>}
      {mfa.step.kind === "need-factor" && (
        <button
          type="button"
          disabled={mfa.isSubmitting}
          onClick={() => {
            if (mfa.step.kind === "need-factor")
              void mfa.startEnrollment(mfa.step.abandonedFactorId);
          }}
        >
          {t("enroll")}
        </button>
      )}
      {mfa.step.kind === "enrolling" && (
        <img
          src={buildTotpQrImageSrc(mfa.step.qrCode) ?? undefined}
          alt={t("qr")}
          className="h-48 w-48"
        />
      )}
      {factorId && (
        <form
          onSubmit={(event) => void mfa.submitCode(event, factorId)}
          className="flex flex-col gap-3"
        >
          <label>
            {t("code")}
            <input
              ref={input}
              value={mfa.code}
              onChange={(event) =>
                mfa.setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
              }
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              required
              maxLength={6}
              className="mt-1 block w-full rounded-md border border-border-subtle bg-bg-base px-3 py-2"
            />
          </label>
          <button
            type="submit"
            disabled={mfa.isSubmitting || mfa.code.length !== 6}
            className="min-h-11 rounded-md bg-accent-primary px-4 py-2 font-semibold text-text-inverse"
          >
            {mfa.isSubmitting ? t("verifying") : t("verify")}
          </button>
        </form>
      )}
      {mfa.formError && (
        <p role="alert">{t(mfa.invalidCode ? "invalidCode" : "verificationFailed")}</p>
      )}
      <button
        type="button"
        onClick={onCancel}
        className="min-h-11 rounded-md border border-border-subtle px-4 py-2"
      >
        {t("cancel")}
      </button>
    </section>
  );
}
