import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import AdminAuthCard from "@/components/admin/AdminAuthCard";
import AdminAuthField from "@/components/admin/AdminAuthField";

// /admin/login (Bloque 3A). Solo establece IDENTIDAD/SESIÓN frontend vía Supabase Auth
// (signInWithPassword): autenticado !== autorizado. No consulta admin_roles, no decide
// ADMIN/MODERATOR desde el cliente, no usa el email como rol. La autorización real vive
// exclusivamente en el backend (ver src/lib/admin-auth.ts), fuera del alcance de este
// bloque.
//
// Errores del proveedor: nunca se muestra error.message de Supabase tal cual (podría
// filtrar detalles internos innecesarios). Se traduce a un mensaje genérico entendible
// en español; el único caso distinguido es "credenciales incorrectas" porque es
// información que el propio formulario ya expone (email/contraseña equivocados), no un
// detalle interno del proveedor.
function loginErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/invalid login credentials/i.test(message)) {
    return "Email o contraseña incorrectos.";
  }
  if (/email not confirmed/i.test(message)) {
    return "Confirma tu email antes de iniciar sesión.";
  }
  return "No se pudo iniciar sesión. Inténtalo de nuevo.";
}

export default function AdminLoginPage() {
  const { session, loading: sessionLoading, signOut } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!supabase) {
      setError("El acceso admin no está configurado todavía.");
      return;
    }

    setIsSubmitting(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signInError) {
        setError(loginErrorMessage(signInError));
        return;
      }
      // Éxito: la sesión llega vía onAuthStateChange (AuthProvider) y este componente
      // vuelve a renderizar en la rama "ya autenticado" de abajo. No se navega a un
      // dashboard: todavía no existe (Bloque 3B+).
      setPassword("");
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (sessionLoading) {
    return (
      <AdminAuthCard title="Acceso admin">
        <p className="text-sm text-text-secondary" role="status">
          Comprobando sesión…
        </p>
      </AdminAuthCard>
    );
  }

  if (session) {
    return (
      <AdminAuthCard title="Acceso admin">
        <p className="text-sm text-text-secondary">
          Sesión iniciada como{" "}
          <span className="font-medium text-text-primary">{session.user.email}</span>.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            to="/admin/mfa"
            className="inline-flex min-h-11 items-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface"
          >
            Continuar a verificación en dos pasos
          </Link>
          <button
            type="button"
            onClick={() => void signOut()}
            className="inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary"
          >
            Cerrar sesión
          </button>
        </div>
      </AdminAuthCard>
    );
  }

  return (
    <AdminAuthCard
      title="Acceso admin"
      footer={
        <>
          ¿No tienes cuenta?{" "}
          <Link
            to="/admin/signup"
            className="font-medium text-accent-primary hover:underline"
          >
            Crear cuenta
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <AdminAuthField
          label="Email"
          id="login-email"
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
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={isSubmitting}
          errorId={error ? "login-error" : undefined}
        />

        {error ? (
          <p id="login-error" role="alert" className="text-sm text-accent-live">
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
