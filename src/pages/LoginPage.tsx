import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import AdminAuthCard from "@/components/admin/AdminAuthCard";
import AdminAuthField from "@/components/admin/AdminAuthField";
import EmailVerificationPending from "@/components/auth/EmailVerificationPending";
import AuthLinkErrorNotice from "@/components/auth/AuthLinkErrorNotice";
import { isAuthLinkSuccess, parseAuthLinkError } from "@/lib/auth-link-error";
import { parseSafeReturnTo } from "@/lib/safe-return-to";

// /login (Bloque 6C). Login público con email + contraseña sobre el MISMO cliente de
// Supabase y el MISMO AuthProvider global (un solo listener): solo establece
// identidad/sesión. No consulta roles, no llama a /api/admin/me, no eleva AAL/MFA y no
// redirige a /admin: autenticado !== autorizado, y cualquier acceso administrativo sigue
// protegido server-side por sus propios controles.
//
// Errores: nunca se muestra error.message del proveedor. Solo dos mensajes genéricos, y
// ninguno distingue si el email existe (sin enumeración de cuentas).
//
// returnTo (Fase 9G-3): tras autenticarse se navega al `returnTo` SOLO si parseSafeReturnTo lo
// acepta (destino interno de la allowlist); cualquier otro valor —externo, protocol-relative,
// malformado, ausente— cae en "/". Se navega con React Router, nunca con window.location, y el
// destino no concede nada: cada superficie privilegiada decide por su cuenta (rol + MFA reciente).
const INVALID_CREDENTIALS_MESSAGE = "Email o contraseña incorrectos.";
const GENERIC_ERROR_MESSAGE = "No se pudo iniciar sesión. Inténtalo de nuevo.";

/** AUTH-1: Supabase responde `email_not_confirmed` solo con credenciales correctas. */
function isEmailNotConfirmed(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "email_not_confirmed") return true;
  const message = error instanceof Error ? error.message : "";
  return /email not confirmed/i.test(message);
}

function loginErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /invalid login credentials/i.test(message)
    ? INVALID_CREDENTIALS_MESSAGE
    : GENERIC_ERROR_MESSAGE;
}

export default function LoginPage() {
  const { session, loading: sessionLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const rawReturnTo = searchParams.get("returnTo");
  const destination =
    rawReturnTo === null ? "/" : (parseSafeReturnTo(rawReturnTo)?.path ?? "/");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // AUTH-1: email pendiente de confirmación (no nulo = estado "Check your inbox").
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  // AUTH-1: resultado del enlace de confirmación del correo (fragmento #...), leído una sola vez.
  // Fallo (caducado/ya usado/inválido) = aviso controlado; éxito = continuar en /account (onboarding).
  const [linkError] = useState(() => parseAuthLinkError(location.hash));
  const [arrivedFromLink] = useState(() => isAuthLinkSuccess(location.hash));
  // Guard síncrono contra doble submit (el estado tarda un render en reflejarse).
  const submittingRef = useRef(false);
  // El AuthProvider puede redirigir a / (sesión ya llegada por onAuthStateChange) antes de
  // que resuelva signInWithPassword: si /login ya se desmontó, la respuesta tardía no debe
  // volver a navegar ni tocar estado. El efecto se re-arma solo (React StrictMode).
  const isMountedRef = useRef(true);
  // Un fallo del enlace deja de estar en la URL (sin bucles ni avisos al recargar).
  useEffect(() => {
    if (linkError === null) return;
    navigate(
      { pathname: location.pathname, search: location.search },
      { replace: true, state: location.state },
    );
    // Solo al montar: linkError es estable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submittingRef.current) return;
    setError(null);

    if (!supabase) {
      setError(GENERIC_ERROR_MESSAGE);
      return;
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (!isMountedRef.current) return;
      if (signInError) {
        if (isEmailNotConfirmed(signInError)) {
          // La contraseña no se conserva en ningún estado una vez detectado el caso.
          setPassword("");
          setPendingEmail(email.trim());
          return;
        }
        setError(loginErrorMessage(signInError));
        return;
      }
      // La sesión llega al Header y al resto vía onAuthStateChange (AuthProvider).
      navigate(destination, { replace: true, state: location.state });
    } catch (err) {
      if (isMountedRef.current) setError(loginErrorMessage(err));
    } finally {
      submittingRef.current = false;
      if (isMountedRef.current) setIsSubmitting(false);
    }
  }

  // Mientras se resuelve la sesión inicial no se muestra el formulario (evita que un
  // usuario ya autenticado lo vea parpadear antes de la redirección).
  if (sessionLoading) {
    return (
      <AdminAuthCard title="Iniciar sesión">
        <p className="text-sm text-text-secondary" role="status">
          Comprobando sesión…
        </p>
      </AdminAuthCard>
    );
  }

  if (session) {
    // Si esta pestaña esperaba la confirmación y no hay returnTo, continúa en /account
    // (onboarding de username existente); con returnTo seguro se respeta el destino.
    const target =
      (pendingEmail !== null || arrivedFromLink) && rawReturnTo === null
        ? "/account"
        : destination;
    return <Navigate to={target} replace state={location.state} />;
  }

  if (pendingEmail !== null) {
    return (
      <EmailVerificationPending
        email={pendingEmail}
        source="login"
        onBack={() => setPendingEmail(null)}
      />
    );
  }

  return (
    <AdminAuthCard
      title="Iniciar sesión"
      footer={
        <Link to="/signup" className="font-medium text-accent-primary hover:underline">
          Crear cuenta
        </Link>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {linkError ? <AuthLinkErrorNotice kind={linkError} /> : null}
        <AdminAuthField
          label="Email"
          id="public-login-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={isSubmitting}
        />
        <AdminAuthField
          label="Contraseña"
          id="public-login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={isSubmitting}
          errorId={error ? "public-login-error" : undefined}
        />

        {error ? (
          <p id="public-login-error" role="alert" className="text-sm text-accent-live">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-2 inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50"
        >
          {isSubmitting ? "Iniciando sesión…" : "Iniciar sesión"}
        </button>
      </form>
    </AdminAuthCard>
  );
}
