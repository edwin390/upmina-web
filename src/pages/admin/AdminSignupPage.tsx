import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import AdminAuthCard from "@/components/admin/AdminAuthCard";
import AdminAuthField from "@/components/admin/AdminAuthField";
import SignupLegalConsent from "@/components/auth/SignupLegalConsent";
import {
  NO_CHECKS,
  allAccepted,
  buildLegalAcceptance,
  isSignupLegalConsentEnabled,
  type LegalChecks,
} from "@/lib/legal-consent";
import { useTranslations } from "use-intl";

// /admin/signup (Bloque 3A). Crea una cuenta de Supabase Auth normal: SIEMPRE USER sin
// privilegios. No se envía ningún metadata de rol en signUp(), no hay lista de emails
// con privilegios y el registro nunca concede ADMIN/MODERATOR (eso solo ocurre server-
// side, vía la invitación bootstrap/estándar de los Bloques 2B/2C).
//
// "Confirm email" está habilitado en el proyecto: un signUp exitoso normalmente NO deja
// una sesión activa de inmediato (session === null hasta confirmar el email). Por eso
// el éxito aquí es un mensaje "revisa tu email", nunca un `session` para redirigir a
// ningún sitio.
const MIN_PASSWORD_LENGTH = 8;

type AdminSignupT = ReturnType<typeof useTranslations<"admin.signup">>;

function signupErrorMessage(error: unknown, t: AdminSignupT): string {
  const message = error instanceof Error ? error.message : "";
  if (/already registered|already exists/i.test(message)) {
    return t("alreadyExists");
  }
  if (/password/i.test(message)) {
    return t("weakPassword");
  }
  return t("genericError");
}

export default function AdminSignupPage() {
  const t = useTranslations("admin.signup");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  // Misma declaración de mayoría de edad y aceptación legal que /signup (el servidor la exige para TODA alta).
  const legalEnabled = isSignupLegalConsentEnabled();
  const [legal, setLegal] = useState<LegalChecks>(NO_CHECKS);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t("tooShort", { min: MIN_PASSWORD_LENGTH }));
      return;
    }
    if (password !== confirmPassword) {
      setError(t("mismatch"));
      return;
    }

    if (legalEnabled && !allAccepted(legal)) {
      setError(t("legalRequired"));
      return;
    }

    if (!supabase) {
      setError(t("notConfigured"));
      return;
    }

    setIsSubmitting(true);
    try {
      // Sin metadata de rol en el signup; con el consentimiento activo viaja SOLO `legal_acceptance` (versiones).
      const { error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        ...(legalEnabled
          ? { options: { data: { legal_acceptance: buildLegalAcceptance(legal) } } }
          : {}),
      });
      if (signUpError) {
        setError(signupErrorMessage(signUpError, t));
        return;
      }
      setIsSubmitted(true);
    } catch (err) {
      setError(signupErrorMessage(err, t));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isSubmitted) {
    return (
      <AdminAuthCard title={t("checkEmailTitle")}>
        <p className="text-sm text-text-secondary" role="status">
          {t.rich("checkEmailBody", {
            email,
            emailTag: (chunks) => (
              <span className="font-medium text-text-primary">{chunks}</span>
            ),
          })}
        </p>
      </AdminAuthCard>
    );
  }

  return (
    <AdminAuthCard
      title={t("title")}
      footer={
        <>
          {t("haveAccount")}{" "}
          <Link
            to="/admin/login"
            className="font-medium text-accent-primary hover:underline"
          >
            {t("signIn")}
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <AdminAuthField
          label={t("email")}
          id="signup-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={isSubmitting}
        />
        <AdminAuthField
          label={t("password")}
          id="signup-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={isSubmitting}
        />
        <AdminAuthField
          label={t("confirmPassword")}
          id="signup-confirm-password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          disabled={isSubmitting}
          errorId={error ? "signup-error" : undefined}
        />

        {legalEnabled ? (
          <SignupLegalConsent
            checks={legal}
            onChange={setLegal}
            disabled={isSubmitting}
          />
        ) : null}

        {error ? (
          <p id="signup-error" role="alert" className="text-sm text-accent-live">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={isSubmitting || (legalEnabled && !allAccepted(legal))}
          className="mt-2 inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50"
        >
          {isSubmitting ? t("submitting") : t("submit")}
        </button>
      </form>
    </AdminAuthCard>
  );
}
