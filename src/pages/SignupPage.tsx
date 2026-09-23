import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import AdminAuthCard from "@/components/admin/AdminAuthCard";
import AdminAuthField from "@/components/admin/AdminAuthField";

// /signup (Bloque 6D). Registro público con email + contraseña sobre el MISMO cliente de
// Supabase y el MISMO AuthProvider global (un solo listener). Crea exclusivamente una
// identidad Supabase normal: no envía metadata/roles en signUp(), no toca admin_roles, no
// llama a /api/admin/me y nunca concede ADMIN/MODERATOR (eso solo ocurre server-side vía
// invitaciones administrativas).
//
// "Confirm email" está habilitado: un signUp exitoso NO implica sesión. El éxito es un
// mensaje "revisa tu correo"; si algún día llegara una sesión, el AuthProvider global la
// refleja y esta página redirige a / sin más.
//
// Errores: nunca se muestra error.message del proveedor ni se revela si un email ya está
// registrado (sin enumeración de cuentas). Mensajes públicos controlados.
const MISMATCH_MESSAGE = "Las contraseñas no coinciden.";
const MISSING_FIELDS_MESSAGE = "Completa todos los campos.";
const WEAK_PASSWORD_MESSAGE = "La contraseña no cumple los requisitos de seguridad.";
const GENERIC_ERROR_MESSAGE = "No se pudo crear la cuenta. Inténtalo de nuevo.";

function signupErrorMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "weak_password" || /password/i.test(message)) {
    return WEAK_PASSWORD_MESSAGE;
  }
  return GENERIC_ERROR_MESSAGE;
}

const SECONDARY_LINK_CLASS = "font-medium text-accent-primary hover:underline";

export default function SignupPage() {
  const { session, loading: sessionLoading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  // Guard síncrono contra doble submit (el estado tarda un render en reflejarse).
  const submittingRef = useRef(false);
  // Si la página se desmontó mientras signUp estaba pendiente (p. ej. el AuthProvider ya
  // redirigió), la respuesta tardía no debe tocar estado. Se re-arma solo (StrictMode).
  const isMountedRef = useRef(true);
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

    if (!email.trim() || !password || !confirmPassword) {
      setError(MISSING_FIELDS_MESSAGE);
      return;
    }
    if (password !== confirmPassword) {
      setError(MISMATCH_MESSAGE);
      return;
    }
    if (!supabase) {
      setError(GENERIC_ERROR_MESSAGE);
      return;
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      // Deliberadamente sin `options.data`: ningún metadata de rol viaja en el signup.
      const { error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
      });
      if (!isMountedRef.current) return;
      if (signUpError) {
        setError(signupErrorMessage(signUpError));
        return;
      }
      setPassword("");
      setConfirmPassword("");
      setIsSubmitted(true);
    } catch (err) {
      if (isMountedRef.current) setError(signupErrorMessage(err));
    } finally {
      submittingRef.current = false;
      if (isMountedRef.current) setIsSubmitting(false);
    }
  }

  // Mientras se resuelve la sesión inicial no se muestra el formulario (evita el parpadeo
  // para una persona ya autenticada antes de la redirección).
  if (sessionLoading) {
    return (
      <AdminAuthCard title="Crear cuenta">
        <p className="text-sm text-text-secondary" role="status">
          Comprobando sesión…
        </p>
      </AdminAuthCard>
    );
  }

  if (session) {
    return <Navigate to="/" replace />;
  }

  if (isSubmitted) {
    return (
      <AdminAuthCard
        title="Revisa tu correo"
        footer={
          <Link to="/login" className={SECONDARY_LINK_CLASS}>
            Ya tengo una cuenta
          </Link>
        }
      >
        <p className="text-sm text-text-secondary" role="status">
          Revisa tu correo para confirmar tu cuenta.
        </p>
      </AdminAuthCard>
    );
  }

  return (
    <AdminAuthCard
      title="Crear cuenta"
      footer={
        <Link to="/login" className={SECONDARY_LINK_CLASS}>
          Ya tengo una cuenta
        </Link>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <AdminAuthField
          label="Email"
          id="public-signup-email"
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
          id="public-signup-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={isSubmitting}
        />
        <AdminAuthField
          label="Confirmar contraseña"
          id="public-signup-confirm-password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          disabled={isSubmitting}
          errorId={error ? "public-signup-error" : undefined}
        />

        {error ? (
          <p id="public-signup-error" role="alert" className="text-sm text-accent-live">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-2 inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50"
        >
          {isSubmitting ? "Creando cuenta…" : "Crear cuenta"}
        </button>
      </form>
    </AdminAuthCard>
  );
}
