import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslations } from "use-intl";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { parseAuthLinkError } from "@/lib/auth-link-error";
import {
  clearRecoveryMark,
  recoveryMarkMatches,
  sessionIdFromAccessToken,
} from "@/lib/password-recovery";
import { reverifyTotp, type ReverifyResult } from "@/lib/totp-reverify";
import AdminAuthCard from "@/components/admin/AdminAuthCard";
import AdminAuthField from "@/components/admin/AdminAuthField";
import UpminaLocaleProvider from "@/i18n/LocaleProvider";

// /reset-password — destino del enlace de «Olvidé mi contraseña». Supabase Auth valida el enlace y crea la sesión
// de recuperación; esta página solo PRESENTA el formulario y llama a supabase.auth.updateUser({ password }).
//
// Seguridad:
//   * Solo se muestra el formulario si la sesión actual ES la sesión de recuperación marcada por el evento real
//     PASSWORD_RECOVERY (mismo usuario y mismo session_id, menos de 15 min; ver password-recovery.ts). Una sesión
//     ordinaria, de otra cuenta, una marca caducada u obsoleta: «enlace no válido», se limpia la marca y no se llama a nada.
//   * Cuenta con verificación en dos pasos (nextLevel aal2 > currentLevel): ANTES de pedir la contraseña nueva se
//     exige el código TOTP (mfa.challenge + mfa.verify). No se asume que updateUser funcione con una sesión aal1:
//     si Supabase responde `insufficient_aal` se vuelve al paso del código. Quien perdió su autenticador NO puede
//     restablecer desde aquí (para eso existe la recuperación de MFA con aprobación). Recuperar la contraseña nunca
//     concede acceso privilegiado: toda operación privilegiada exige además aal2 y un TOTP reciente verificados
//     por el servidor, y esta página no llama a ninguna API propia ni navega a /admin.
//   * Los tokens nunca se leen, muestran ni registran (supabase-js ya limpió el fragmento). Un fragmento de error del
//     proveedor (otp_expired…) solo se clasifica y se borra de la URL.
//   * Al terminar bien: se cierran TODAS las sesiones (scope global; también la de recuperación) y se vuelve a /login:
//     hay que iniciar sesión (y pasar el MFA, si lo hay) con la contraseña nueva. La contraseña no se conserva.

type Step = "checking" | "invalid" | "totp" | "password";
type FormError =
  | null
  | "mfaInvalidFormat"
  | "mfaNoFactor"
  | "mfaInvalidCode"
  | "mfaFailed"
  | "missing"
  | "mismatch"
  | "weak"
  | "same"
  | "aalRequired"
  | "failed";

const MFA_ERROR: Record<Exclude<ReverifyResult, "ok">, FormError> = {
  invalid_format: "mfaInvalidFormat",
  no_factor: "mfaNoFactor",
  invalid_code: "mfaInvalidCode",
  failed: "mfaFailed",
};

const PRIMARY =
  "mt-2 inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50";
const SECONDARY =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50";

function Content() {
  const t = useTranslations("auth.resetPassword");
  const navigate = useNavigate();
  const location = useLocation();
  const { session, loading } = useAuth();
  const hasSession = Boolean(session);
  // Identidad de la sesión (usuario + session_id) para volver a evaluar la marca si cambia de sesión.
  const sessionKey = session
    ? `${session.user.id}:${sessionIdFromAccessToken(session.access_token) ?? ""}`
    : null;
  // Fallo del enlace según el proveedor (caducado/ya usado): solo se clasifica; nunca se muestra su texto.
  const [linkError] = useState(() => parseAuthLinkError(location.hash));
  const [step, setStep] = useState<Step>("checking");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<FormError>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Un fallo del enlace deja de estar en la URL (sin avisos al recargar).
  useEffect(() => {
    if (linkError === null) return;
    navigate(
      { pathname: location.pathname, search: location.search },
      { replace: true, state: location.state },
    );
    // Solo al montar: linkError es estable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Decide el paso inicial una vez resuelta la sesión.
  useEffect(() => {
    if (loading) return;
    if (linkError !== null) {
      clearRecoveryMark(); // un enlace inválido también invalida cualquier marca previa
      setStep("invalid");
      return;
    }
    if (!session || !recoveryMarkMatches(session) || !supabase) {
      setStep("invalid");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { data, error: aalError } =
          await supabase!.auth.mfa.getAuthenticatorAssuranceLevel();
        if (cancelled) return;
        if (aalError || !data) {
          setStep("invalid");
          return;
        }
        setStep(
          data.nextLevel === "aal2" && data.currentLevel !== "aal2" ? "totp" : "password",
        );
      } catch {
        if (!cancelled) setStep("invalid");
      }
    })();
    return () => {
      cancelled = true;
    };
    // `session` se lee en el momento; la identidad de la sesión (sessionKey) es lo que provoca reevaluar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, hasSession, sessionKey, linkError]);

  async function handleVerify(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await reverifyTotp(code);
      if (!mounted.current) return;
      if (result !== "ok") {
        setError(MFA_ERROR[result]);
        return;
      }
      setCode("");
      setStep("password");
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !supabase) return;
    if (!password || !confirm) {
      setError("missing");
      return;
    }
    if (password !== confirm) {
      setError("mismatch");
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (!mounted.current) return;
      if (updateError) {
        const code = (updateError as { code?: unknown }).code;
        const status = (updateError as { status?: unknown }).status;
        if (code === "insufficient_aal") {
          // Supabase exige aal2 para cambiar la contraseña de esta cuenta: se vuelve a pedir el código.
          setPassword("");
          setConfirm("");
          setStep("totp");
          setError("aalRequired");
        } else if (code === "same_password") setError("same");
        else if (code === "weak_password") setError("weak");
        else if (
          code === "session_not_found" ||
          code === "session_expired" ||
          code === "bad_jwt" ||
          status === 401
        ) {
          setStep("invalid");
        } else setError("failed");
        return;
      }
      // Hecho: la contraseña no se conserva y se cierran todas las sesiones (incluida la de recuperación).
      setPassword("");
      setConfirm("");
      clearRecoveryMark();
      try {
        await supabase.auth.signOut({ scope: "global" });
      } catch {
        /* la contraseña ya cambió; el cierre local lo reintenta el AuthProvider */
      }
      navigate("/login", { replace: true, state: { passwordUpdated: true } });
    } catch {
      if (mounted.current) setError("failed");
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function handleCancel() {
    clearRecoveryMark();
    try {
      // Solo ESTA sesión: cancelar no debe cerrar las demás sesiones de la persona (el cambio completado sí lo hace).
      await supabase?.auth.signOut({ scope: "local" });
    } catch {
      /* nada más que hacer */
    }
    navigate("/login", { replace: true });
  }

  const errorText = error ? t(error) : null;
  const errorBlock = errorText ? (
    <p id="reset-password-error" role="alert" className="text-sm text-accent-live">
      {errorText}
    </p>
  ) : null;

  if (step === "checking") {
    return (
      <AdminAuthCard title={t("title")}>
        <p className="text-sm text-text-secondary" role="status">
          {t("checking")}
        </p>
      </AdminAuthCard>
    );
  }

  if (step === "invalid") {
    return (
      <AdminAuthCard title={t("invalidTitle")}>
        <p role="alert" className="text-sm text-text-secondary">
          {t("invalidBody")}
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link to="/forgot-password" className={SECONDARY}>
            {t("requestNew")}
          </Link>
        </div>
      </AdminAuthCard>
    );
  }

  if (step === "totp") {
    return (
      <AdminAuthCard title={t("mfaTitle")} subtitle={t("mfaBody")}>
        <form onSubmit={handleVerify} className="flex flex-col gap-4" noValidate>
          <AdminAuthField
            label={t("codeLabel")}
            id="reset-password-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            disabled={busy}
            errorId={error ? "reset-password-error" : undefined}
          />
          {errorBlock}
          <button type="submit" disabled={busy || code.length !== 6} className={PRIMARY}>
            {busy ? t("verifying") : t("verify")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleCancel()}
            className={SECONDARY}
          >
            {t("cancel")}
          </button>
        </form>
      </AdminAuthCard>
    );
  }

  return (
    <AdminAuthCard title={t("title")}>
      <form onSubmit={handleSave} className="flex flex-col gap-4" noValidate>
        <AdminAuthField
          label={t("newPassword")}
          id="reset-password-new"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          errorId={error ? "reset-password-error" : undefined}
        />
        <AdminAuthField
          label={t("confirmPassword")}
          id="reset-password-confirm"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          disabled={busy}
        />
        {errorBlock}
        <button type="submit" disabled={busy} className={PRIMARY}>
          {busy ? t("saving") : t("submit")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleCancel()}
          className={SECONDARY}
        >
          {t("cancel")}
        </button>
      </form>
    </AdminAuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <UpminaLocaleProvider>
      <Content />
    </UpminaLocaleProvider>
  );
}
