import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import AdminAuthCard from "@/components/admin/AdminAuthCard";
import AdminAuthField from "@/components/admin/AdminAuthField";

// /admin/mfa (Bloque 3B). Enrolamiento y verificación TOTP mediante la API oficial de
// MFA de Supabase Auth (`supabase.auth.mfa`). Este contexto solo importa para UX y
// navegación: el AAL observado aquí NUNCA se convierte en autorización. No se consulta
// admin_roles desde el cliente, no se deriva ADMIN/MODERATOR de email/metadata/
// localStorage, y la autoridad real sigue siendo exclusivamente server-side (ver
// src/lib/admin-auth.ts, que exige aal2 verificado criptográficamente vía JWT antes de
// cualquier operación privilegiada).
//
// MFA es un segundo factor, no una prueba de identidad real ni una fuente de rol.

const INVALID_OR_EXPIRED_CODES = new Set([
  "mfa_verification_failed",
  "mfa_challenge_expired",
  "mfa_verification_rejected",
]);

/** Traduce un AuthError de Supabase MFA a un mensaje seguro y entendible. Usa
 *  `error.code` (campo estable de la API, ver @supabase/auth-js/lib/error-codes) en vez
 *  de inspeccionar `error.message`: nunca se propaga el texto interno del proveedor. */
function mfaErrorMessage(error: unknown, fallback: string): string {
  const code =
    error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && INVALID_OR_EXPIRED_CODES.has(code)) {
    return "Código incorrecto o expirado.";
  }
  return fallback;
}

const UNEXPECTED_ERROR = "Ocurrió un error inesperado. Inténtalo de nuevo.";

type MfaStep =
  | { kind: "checking" }
  | { kind: "no-session" }
  | { kind: "verified" }
  | { kind: "need-factor" }
  | { kind: "enrolling"; factorId: string; qrCode: string; secret: string }
  | { kind: "challenge"; factorId: string }
  | { kind: "fatal"; message: string };

export default function AdminMfaPage() {
  const { session, loading: sessionLoading, signOut } = useAuth();
  const hasSession = Boolean(session);

  const [step, setStep] = useState<MfaStep>({ kind: "checking" });
  const [code, setCode] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSecretVisible, setIsSecretVisible] = useState(false);

  // Consulta el AAL actual y, si hace falta, los factores TOTP existentes. Es la única
  // fuente de verdad de "qué pantalla mostrar": nunca se infiere el estado a partir de
  // valores guardados localmente. Se llama al montar (si ya hay sesión) y explícitamente
  // otra vez tras un verify() exitoso, para confirmar que la sesión alcanzó aal2.
  const loadStatus = useCallback(async () => {
    if (!supabase) {
      setStep({ kind: "fatal", message: "El acceso admin no está configurado todavía." });
      return;
    }

    const { data: aalData, error: aalError } =
      await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalError) {
      setStep({
        kind: "fatal",
        message: "No se pudo comprobar tu estado de verificación en dos pasos.",
      });
      return;
    }

    if (aalData.currentLevel === "aal2") {
      setStep({ kind: "verified" });
      return;
    }

    const { data: factorsData, error: factorsError } =
      await supabase.auth.mfa.listFactors();
    if (factorsError) {
      setStep({
        kind: "fatal",
        message: "No se pudieron cargar tus factores de verificación.",
      });
      return;
    }

    // Solo importan factores TOTP ya verificados: uno sin verificar es un enrolamiento
    // abandonado en un intento anterior, no un factor utilizable para challenge/verify.
    const verifiedTotp = factorsData.totp.find((factor) => factor.status === "verified");
    if (verifiedTotp) {
      setStep({ kind: "challenge", factorId: verifiedTotp.id });
    } else {
      setStep({ kind: "need-factor" });
    }
  }, []);

  useEffect(() => {
    if (sessionLoading) {
      setStep({ kind: "checking" });
      return;
    }
    if (!hasSession) {
      setStep({ kind: "no-session" });
      return;
    }
    void loadStatus();
  }, [sessionLoading, hasSession, loadStatus]);

  async function startEnrollment() {
    if (!supabase) return;
    setFormError(null);
    setIsSubmitting(true);
    try {
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
      if (error) {
        setFormError("No se pudo iniciar el enrolamiento. Inténtalo de nuevo.");
        return;
      }
      // Solo en memoria: qr_code/secret/uri nunca se guardan en localStorage,
      // sessionStorage, cookies propias, query params ni el hash de la URL.
      setStep({
        kind: "enrolling",
        factorId: data.id,
        qrCode: data.totp.qr_code,
        secret: data.totp.secret,
      });
      setIsSecretVisible(false);
    } catch {
      setFormError(UNEXPECTED_ERROR);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function cancelEnrollment(factorId: string) {
    setIsSubmitting(true);
    try {
      if (supabase) {
        // Best-effort: el factor todavía no está verificado (nadie depende de él), así
        // que un fallo aquí no debe bloquear la cancelación ni mostrarse como error.
        // NUNCA se elimina un factor ya verificado por esta vía.
        await supabase.auth.mfa.unenroll({ factorId });
      }
    } catch {
      // Limpieza best-effort: se ignora deliberadamente.
    } finally {
      setCode("");
      setFormError(null);
      setIsSubmitting(false);
      setStep({ kind: "need-factor" });
    }
  }

  async function submitCode(event: FormEvent, factorId: string) {
    event.preventDefault();
    if (!supabase) return;
    setFormError(null);
    setIsSubmitting(true);
    try {
      // Un challenge nuevo por intento: nunca se reutiliza un challengeId de un envío
      // anterior, y siempre pertenece al factor que se está verificando.
      const { data: challengeData, error: challengeError } =
        await supabase.auth.mfa.challenge({ factorId });
      if (challengeError) {
        setFormError("No se pudo iniciar la verificación. Inténtalo de nuevo.");
        return;
      }

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challengeData.id,
        code,
      });
      if (verifyError) {
        setFormError(
          mfaErrorMessage(
            verifyError,
            "No se pudo verificar el código. Inténtalo de nuevo.",
          ),
        );
        return;
      }

      setCode("");
      // Confirma explícitamente que la sesión alcanzó aal2 (verify() ya actualiza la
      // sesión internamente vía onAuthStateChange, pero esto refleja el estado exacto
      // de assurance sin asumirlo).
      await loadStatus();
    } catch {
      setFormError(UNEXPECTED_ERROR);
    } finally {
      setIsSubmitting(false);
    }
  }

  if (step.kind === "checking") {
    return (
      <AdminAuthCard title="Verificación en dos pasos">
        <p className="text-sm text-text-secondary" role="status">
          Comprobando tu sesión…
        </p>
      </AdminAuthCard>
    );
  }

  if (step.kind === "no-session") {
    return (
      <AdminAuthCard
        title="Verificación en dos pasos"
        footer={
          <Link
            to="/admin/login"
            className="font-medium text-accent-primary hover:underline"
          >
            Iniciar sesión
          </Link>
        }
      >
        <p className="text-sm text-text-secondary">
          Inicia sesión para configurar o completar la verificación en dos pasos.
        </p>
      </AdminAuthCard>
    );
  }

  if (step.kind === "fatal") {
    return (
      <AdminAuthCard title="Verificación en dos pasos">
        <p role="alert" className="text-sm text-accent-live">
          {step.message}
        </p>
      </AdminAuthCard>
    );
  }

  if (step.kind === "verified") {
    return (
      <AdminAuthCard title="Verificación en dos pasos">
        <p className="text-sm text-text-secondary">
          Tu sesión ya tiene la verificación en dos pasos activa.
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-6 inline-flex min-h-11 items-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface"
        >
          Cerrar sesión
        </button>
      </AdminAuthCard>
    );
  }

  if (step.kind === "need-factor") {
    return (
      <AdminAuthCard title="Verificación en dos pasos">
        <p className="text-sm text-text-secondary">
          Todavía no configuraste una app autenticadora para tu cuenta.
        </p>
        {formError ? (
          <p role="alert" className="mt-4 text-sm text-accent-live">
            {formError}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => void startEnrollment()}
          disabled={isSubmitting}
          className="mt-6 inline-flex min-h-11 items-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50"
        >
          {isSubmitting ? "Iniciando…" : "Configurar autenticador"}
        </button>
      </AdminAuthCard>
    );
  }

  if (step.kind === "enrolling") {
    const { factorId, qrCode, secret } = step;
    return (
      <AdminAuthCard
        title="Configurar autenticador"
        subtitle="Escanea el código con tu app autenticadora (Google Authenticator, 1Password, Authy…) o introduce la clave manual."
      >
        <img
          src={`data:image/svg+xml;utf-8,${encodeURIComponent(qrCode)}`}
          alt="Código QR para configurar tu app autenticadora"
          className="mx-auto h-40 w-40 rounded-md border border-border-subtle bg-bg-base p-2"
        />

        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="mfa-secret" className="block text-sm text-text-secondary">
              Clave manual
            </label>
            <button
              type="button"
              onClick={() => setIsSecretVisible((visible) => !visible)}
              className="text-xs font-medium text-accent-primary hover:underline"
            >
              {isSecretVisible ? "Ocultar" : "Mostrar"}
            </button>
          </div>
          <input
            id="mfa-secret"
            readOnly
            type={isSecretVisible ? "text" : "password"}
            value={secret}
            className="w-full rounded-md border border-border-subtle bg-bg-base px-3 py-2 font-mono text-sm text-text-primary outline-none"
          />
        </div>

        <form
          onSubmit={(event) => void submitCode(event, factorId)}
          className="mt-6 flex flex-col gap-4"
        >
          <AdminAuthField
            label="Código de verificación"
            id="mfa-enroll-code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={isSubmitting}
            errorId={formError ? "mfa-enroll-error" : undefined}
          />

          {formError ? (
            <p id="mfa-enroll-error" role="alert" className="text-sm text-accent-live">
              {formError}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50"
            >
              {isSubmitting ? "Verificando…" : "Verificar y activar"}
            </button>
            <button
              type="button"
              onClick={() => void cancelEnrollment(factorId)}
              disabled={isSubmitting}
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary disabled:pointer-events-none disabled:opacity-50"
            >
              Cancelar
            </button>
          </div>
        </form>
      </AdminAuthCard>
    );
  }

  // step.kind === "challenge"
  return (
    <AdminAuthCard title="Verificación en dos pasos">
      <p className="text-sm text-text-secondary">
        Introduce el código de tu app autenticadora.
      </p>
      <form
        onSubmit={(event) => void submitCode(event, step.factorId)}
        className="mt-6 flex flex-col gap-4"
      >
        <AdminAuthField
          label="Código de verificación"
          id="mfa-code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={isSubmitting}
          errorId={formError ? "mfa-error" : undefined}
        />

        {formError ? (
          <p id="mfa-error" role="alert" className="text-sm text-accent-live">
            {formError}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-2 inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50"
        >
          {isSubmitting ? "Verificando…" : "Verificar"}
        </button>
      </form>
    </AdminAuthCard>
  );
}
