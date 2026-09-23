import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import AdminAuthCard from "@/components/admin/AdminAuthCard";
import AdminAuthField from "@/components/admin/AdminAuthField";

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

function signupErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/already registered|already exists/i.test(message)) {
    return "Ya existe una cuenta con ese email.";
  }
  if (/password/i.test(message)) {
    return "La contraseña no cumple los requisitos mínimos.";
  }
  return "No se pudo crear la cuenta. Inténtalo de nuevo.";
}

export default function AdminSignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Las contraseñas no coinciden.");
      return;
    }

    if (!supabase) {
      setError("El acceso admin no está configurado todavía.");
      return;
    }

    setIsSubmitting(true);
    try {
      // Deliberadamente sin `options.data`: ningún metadata de rol viaja en el signup.
      const { error: signUpError } = await supabase.auth.signUp({ email, password });
      if (signUpError) {
        setError(signupErrorMessage(signUpError));
        return;
      }
      setIsSubmitted(true);
    } catch (err) {
      setError(signupErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isSubmitted) {
    return (
      <AdminAuthCard title="Revisa tu email">
        <p className="text-sm text-text-secondary" role="status">
          Te enviamos un email de confirmación a{" "}
          <span className="font-medium text-text-primary">{email}</span>. Confírmalo para
          poder iniciar sesión.
        </p>
      </AdminAuthCard>
    );
  }

  return (
    <AdminAuthCard
      title="Crear cuenta"
      footer={
        <>
          ¿Ya tienes cuenta?{" "}
          <Link
            to="/admin/login"
            className="font-medium text-accent-primary hover:underline"
          >
            Iniciar sesión
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <AdminAuthField
          label="Email"
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
          label="Contraseña"
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
          label="Confirmar contraseña"
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

        {error ? (
          <p id="signup-error" role="alert" className="text-sm text-accent-live">
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
