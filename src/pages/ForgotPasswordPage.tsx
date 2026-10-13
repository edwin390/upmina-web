import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { useTranslations } from "use-intl";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { passwordResetRedirectUrl, recoveryMarkMatches } from "@/lib/password-recovery";
import {
  passwordRecoveryLookupEnabled,
  requestPasswordRecovery,
  type RecoveryOutcome,
} from "@/lib/password-recovery-client";
import AdminAuthCard from "@/components/admin/AdminAuthCard";
import AdminAuthField from "@/components/admin/AdminAuthField";
import EmailVerificationPending from "@/components/auth/EmailVerificationPending";
import UpminaLocaleProvider from "@/i18n/LocaleProvider";

// /forgot-password — pide a Supabase Auth el correo de restablecimiento (resetPasswordForEmail). Sin proveedor
// nuevo y sin tokens propios: Supabase envía el correo por su canal de siempre y valida el enlace.
//
// Sin enumeración de cuentas: la respuesta es SIEMPRE la misma («si existe una cuenta…»), tanto si el correo existe
// como si no, y también si Supabase devuelve un error (p. ej. su espera por usuario, que solo ocurre con cuentas
// reales y revelaría su existencia) o lanza. Solo un correo con forma inválida se rechaza en el cliente. El texto
// nunca repite el correo escrito. Contra el abuso, el botón se bloquea 60 s tras cada petición y los límites de
// envío de Supabase Auth siguen aplicando en el servidor.
//
// COMPROBACIÓN DEL CORREO (lote 3P-R; decisión de producto aceptada por el propietario, que SÍ revela si la cuenta
// existe). Integración CONTROLADA: solo con VITE_PASSWORD_RECOVERY_LOOKUP=1 (build) la pantalla usa el endpoint propio
// POST /api/profile?action=password-recovery, que comprueba en el servidor el correo (con límites por capas):
//   · registrado y confirmado → el NAVEGADOR envía la recuperación (resetPasswordForEmail); confirmación + aviso de Spam + cooldown;
//   · no registrado → «No encontramos una cuenta…» + «Crear cuenta con [correo]» (correo por ESTADO del router);
//   · registrado sin confirmar → se reutiliza la pantalla de «correo sin confirmar» de Login (reenvío oficial de Supabase);
//   · límite → aviso y cuenta atrás; fallo técnico → error, NUNCA «no encontramos una cuenta».
// Con el interruptor apagado (por defecto) se conserva EXACTAMENTE el flujo neutro de arriba.

const COOLDOWN_SECONDS = 60;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SECONDARY =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";

type Feedback =
  "sent" | "invalid" | "unavailable" | "unregistered" | "rateLimited" | null;

function Content() {
  const t = useTranslations("auth.forgotPassword");
  const [email, setEmail] = useState("");
  const [feedback, setFeedback] = useState<Feedback>(null);
  // Correo comprobado (con el que se ofrece «Crear cuenta con…») y correo pendiente de confirmar.
  const [checkedEmail, setCheckedEmail] = useState<string | null>(null);
  const [unconfirmedEmail, setUnconfirmedEmail] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const sendingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Cuenta atrás acotada: solo mientras hay tiempo restante; el temporizador se retira al desmontar.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (sendingRef.current || cooldown > 0) return;
    const trimmed = email.trim();
    if (!EMAIL_SHAPE.test(trimmed)) {
      setFeedback("invalid");
      return;
    }
    if (passwordRecoveryLookupEnabled()) {
      await submitWithLookup(trimmed);
      return;
    }
    if (!supabase) {
      setFeedback("unavailable");
      return;
    }
    sendingRef.current = true;
    setIsSending(true);
    try {
      // El resultado (éxito o error) se ignora a propósito: ver el comentario de cabecera.
      await supabase.auth.resetPasswordForEmail(trimmed, {
        redirectTo: passwordResetRedirectUrl(),
      });
    } catch {
      /* misma respuesta neutra */
    } finally {
      sendingRef.current = false;
      if (mountedRef.current) {
        setIsSending(false);
        setFeedback("sent");
        setCooldown(COOLDOWN_SECONDS);
      }
    }
  }

  /** Envío de la recuperación DESDE EL NAVEGADOR (flujo oficial de Supabase Auth; la IP de cada persona cuenta en sus límites). */
  async function sendRecovery(
    address: string,
  ): Promise<"sent" | "rate_limited" | "error"> {
    if (!supabase) return "error";
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(address, {
        redirectTo: passwordResetRedirectUrl(),
      });
      if (!error) return "sent";
      const { code, status } = error as { code?: unknown; status?: unknown };
      return status === 429 ||
        code === "over_email_send_rate_limit" ||
        code === "over_request_rate_limit"
        ? "rate_limited"
        : "error";
    } catch {
      return "error";
    }
  }

  function applyOutcome(
    outcome: Exclude<RecoveryOutcome, { kind: "confirmed" }>,
    checked: string,
  ) {
    switch (outcome.kind) {
      case "unregistered":
        setCheckedEmail(checked);
        setFeedback("unregistered");
        break;
      case "unconfirmed":
        setFeedback(null);
        setUnconfirmedEmail(checked);
        break;
      case "rate_limited":
        setFeedback("rateLimited");
        setCooldown(outcome.retryAfterSeconds);
        break;
      default:
        // fallo técnico: jamás se presenta como «no encontramos una cuenta»
        setFeedback("unavailable");
    }
  }

  async function submitWithLookup(trimmed: string) {
    sendingRef.current = true;
    setIsSending(true);
    setFeedback(null);
    try {
      const outcome = await requestPasswordRecovery(trimmed);
      if (outcome.kind === "confirmed") {
        // Registrado y confirmado: el servidor ya comprobó y limitó; el envío lo hace el navegador.
        const result = await sendRecovery(trimmed);
        if (mountedRef.current) {
          if (result === "sent") {
            setFeedback("sent");
            setCooldown(COOLDOWN_SECONDS);
          } else if (result === "rate_limited") {
            setFeedback("rateLimited");
            setCooldown(COOLDOWN_SECONDS);
          } else {
            setFeedback("unavailable");
          }
        }
      } else if (mountedRef.current) {
        applyOutcome(outcome, trimmed);
      }
    } finally {
      sendingRef.current = false;
      if (mountedRef.current) setIsSending(false);
    }
  }

  // Correo registrado pero sin confirmar: misma pantalla que Login (reenvío por el flujo oficial de Supabase).
  if (unconfirmedEmail !== null) {
    return (
      <EmailVerificationPending
        email={unconfirmedEmail}
        source="login"
        onBack={() => setUnconfirmedEmail(null)}
      />
    );
  }

  const blocked = isSending || cooldown > 0;
  return (
    <AdminAuthCard
      title={t("title")}
      subtitle={t("intro")}
      footer={
        <Link to="/login" className="font-medium text-accent-primary hover:underline">
          {t("backToSignIn")}
        </Link>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        <AdminAuthField
          label={t("emailLabel")}
          id="forgot-password-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            // «Crear cuenta con…» pertenece al correo comprobado: al editarlo deja de ofrecerse.
            if (feedback === "unregistered") setFeedback(null);
          }}
          disabled={isSending}
          errorId={feedback ? "forgot-password-feedback" : undefined}
        />
        {feedback === "sent" ? (
          <div
            id="forgot-password-feedback"
            role="status"
            className="flex flex-col gap-2 text-sm text-text-secondary"
          >
            <p>{t(passwordRecoveryLookupEnabled() ? "sentConfirmed" : "sent")}</p>
            <p>{t("sentHint")}</p>
          </div>
        ) : null}
        {feedback === "unregistered" && checkedEmail !== null ? (
          <div id="forgot-password-feedback" role="alert" className="flex flex-col gap-3">
            <p className="text-sm font-semibold text-accent-live">{t("notFoundTitle")}</p>
            <p className="text-sm text-text-secondary">{t("notFoundBody")}</p>
            <Link
              to="/signup"
              state={{ email: checkedEmail }}
              className={`${SECONDARY} break-all`}
            >
              {t("createAccountWith", { email: checkedEmail })}
            </Link>
          </div>
        ) : null}
        {feedback === "invalid" ||
        feedback === "unavailable" ||
        feedback === "rateLimited" ? (
          <p
            id="forgot-password-feedback"
            role="alert"
            className="text-sm text-accent-live"
          >
            {feedback === "invalid"
              ? t("invalidEmail")
              : feedback === "rateLimited"
                ? t("tooManyRequests")
                : t("unavailable")}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={blocked}
          className="mt-2 inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50"
        >
          {isSending
            ? t("sending")
            : cooldown > 0
              ? t("resendIn", { seconds: cooldown })
              : t("submit")}
        </button>
      </form>
    </AdminAuthCard>
  );
}

export default function ForgotPasswordPage() {
  const { session } = useAuth();
  // Quien ya tiene sesión no necesita restablecer; la sesión de recuperación (llegada desde el enlace) sí puede
  // volver a pedir un enlace nuevo si el suyo falló.
  if (session && !recoveryMarkMatches(session)) return <Navigate to="/account" replace />;
  return (
    <UpminaLocaleProvider>
      <Content />
    </UpminaLocaleProvider>
  );
}
