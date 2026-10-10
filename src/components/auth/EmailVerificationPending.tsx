import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslations } from "use-intl";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { confirmationRedirectUrl } from "@/lib/auth-link-error";
import AdminAuthCard from "@/components/admin/AdminAuthCard";
import UpminaLocaleProvider from "@/i18n/LocaleProvider";

// AUTH-1: estado "esperando confirmación de correo", compartido por /signup (tras un signUp
// con session:null) y /login (signInWithPassword → email_not_confirmed). Supabase sigue siendo
// la única autoridad de verificación (Confirm email activado): aquí no hay ninguna bandera
// propia ni se crea sesión; solo se informa, se permite reenviar y se detecta la sesión que
// aparezca al confirmar en otra pestaña.
//
// Sincronización entre pestañas: supabase-js ya difunde SIGNED_IN entre pestañas
// (BroadcastChannel) y recupera la sesión al volver a ser visible; AuthProvider lo recibe por
// onAuthStateChange y la página que nos monta redirige. Como respaldo ACOTADO (solo mientras
// este componente está montado) se relee la sesión al recuperar foco o visibilidad. Sin
// polling ni temporizadores permanentes; todos los listeners se retiran al desmontar.

const RESEND_COOLDOWN_SECONDS = 60;

type Feedback = "resent" | "rateLimited" | "failed" | null;

function isRateLimit(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  return (
    status === 429 ||
    (typeof code === "string" &&
      (code === "over_email_send_rate_limit" || code === "over_request_rate_limit"))
  );
}

interface EmailVerificationPendingProps {
  /** Email que la propia persona acaba de escribir. */
  email: string;
  /** "signup": el correo acaba de enviarse (arranca el cooldown). "login": no se acaba de enviar. */
  source: "signup" | "login";
  /** Si se pasa, el pie es un botón que vuelve al formulario; si no, un enlace a /login. */
  onBack?: () => void;
}

function PendingContent({ email, source, onBack }: EmailVerificationPendingProps) {
  const t = useTranslations("auth.verification");
  const { refreshSession } = useAuth();
  const [cooldown, setCooldown] = useState(
    source === "signup" ? RESEND_COOLDOWN_SECONDS : 0,
  );
  const [isSending, setIsSending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // Guard síncrono contra doble clic (el estado tarda un render en reflejarse).
  const sendingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Cuenta atrás: un único timeout a la vez, encadenado solo mientras queda tiempo.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  // Respaldo de sincronización: SOLO mientras el estado pendiente está en pantalla.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "hidden") return;
      void refreshSession?.();
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [refreshSession]);

  const handleResend = useCallback(async () => {
    if (sendingRef.current || cooldown > 0) return;
    sendingRef.current = true;
    setIsSending(true);
    setFeedback(null);
    try {
      if (!supabase) {
        setFeedback("failed");
        return;
      }
      const { error } = await supabase.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: confirmationRedirectUrl() },
      });
      if (!mountedRef.current) return;
      if (!error) {
        setFeedback("resent");
        setCooldown(RESEND_COOLDOWN_SECONDS);
      } else if (isRateLimit(error)) {
        setFeedback("rateLimited");
        setCooldown(RESEND_COOLDOWN_SECONDS);
      } else {
        setFeedback("failed");
      }
    } catch {
      if (mountedRef.current) setFeedback("failed");
    } finally {
      sendingRef.current = false;
      if (mountedRef.current) setIsSending(false);
    }
  }, [cooldown, email]);

  const footer: ReactNode = onBack ? (
    <button
      type="button"
      onClick={onBack}
      className="font-medium text-accent-primary hover:underline"
    >
      {t("useAnotherAccount")}
    </button>
  ) : (
    <Link to="/login" className="font-medium text-accent-primary hover:underline">
      {t("backToSignIn")}
    </Link>
  );

  const disabled = isSending || cooldown > 0;
  const label = isSending
    ? t("resending")
    : cooldown > 0
      ? t("resendIn", { seconds: cooldown })
      : t("resend");

  return (
    <AdminAuthCard title={t("title")} footer={footer}>
      <div className="flex flex-col gap-4">
        <p className="break-words text-sm text-text-secondary">
          {source === "signup" ? t("sentTo", { email }) : t("notConfirmedYet", { email })}{" "}
          {t("openIt")}
        </p>
        <div className="rounded-lg border border-accent-primary/30 bg-accent-primary/5 p-4 text-sm leading-relaxed text-text-secondary">
          <strong className="text-text-primary">{t("cantFindTitle")}</strong>{" "}
          {t("checkSpam")}
        </div>
        <button
          type="button"
          onClick={() => void handleResend()}
          disabled={disabled}
          aria-busy={isSending}
          className="inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50"
        >
          {label}
        </button>
        <div aria-live="polite">
          {feedback === "resent" ? (
            <p role="status" className="text-sm text-accent-success">
              {t("resent")}
            </p>
          ) : null}
          {feedback === "rateLimited" ? (
            <p role="alert" className="text-sm text-accent-warning">
              {t("rateLimited")}
            </p>
          ) : null}
          {feedback === "failed" ? (
            <p role="alert" className="text-sm text-accent-live">
              {t("resendFailed")}
            </p>
          ) : null}
        </div>
      </div>
    </AdminAuthCard>
  );
}

export default function EmailVerificationPending(props: EmailVerificationPendingProps) {
  // El proveedor de idioma existente (use-intl + messages ES/EN/DE) solo cubre /cosplay hoy; se
  // monta aquí, perezosamente con esta pantalla, hasta que I18N-1 lo suba a main.tsx.
  return (
    <UpminaLocaleProvider>
      <PendingContent {...props} />
    </UpminaLocaleProvider>
  );
}
