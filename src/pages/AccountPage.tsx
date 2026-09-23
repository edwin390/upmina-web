import { useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import AdminAuthCard from "@/components/admin/AdminAuthCard";
import ProfileSection from "@/components/account/ProfileSection";

// /account (Bloque 6E). Punto de entrada privado mínimo: solo requiere una sesión
// autenticada normal, la misma que expone el AuthProvider global (un solo listener). No
// exige ADMIN/MODERATOR/MFA, no llama a /api/admin/me, no consulta roles ni muestra si la
// cuenta es administrativa: la autoridad de /admin sigue siendo server-side y separada.
//
// Solo se muestra el email de la sesión ya existente. Nunca user_id, tokens, claims ni
// metadata. Debajo, ProfileSection (Bloque 7C.2) gestiona el perfil público: lectura de
// public.profiles y onboarding de username; queda visualmente separado de la sesión.
//
// Logout: supabase.auth.signOut() del cliente existente. Si sale bien, el AuthProvider
// refleja la desaparición de la sesión y esta misma página redirige a /login (no hay
// navegación imperativa que pueda llegar tarde). Si falla, la sesión se mantiene y se
// muestra un mensaje público genérico (nunca error.message del proveedor).
const SIGN_OUT_ERROR_MESSAGE = "No se pudo cerrar la sesión. Inténtalo de nuevo.";

export default function AccountPage() {
  const { session, loading: sessionLoading } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  // Guard síncrono contra doble click (el estado tarda un render en reflejarse).
  const signingOutRef = useRef(false);
  // Si la página se desmontó mientras signOut estaba pendiente (p. ej. la sesión ya
  // desapareció y se redirigió), la respuesta tardía no debe tocar estado. Se re-arma sola
  // (React StrictMode).
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  async function handleSignOut() {
    if (signingOutRef.current) return;
    setError(null);

    if (!supabase) {
      setError(SIGN_OUT_ERROR_MESSAGE);
      return;
    }

    signingOutRef.current = true;
    setIsSigningOut(true);
    try {
      const { error: signOutError } = await supabase.auth.signOut();
      if (!isMountedRef.current) return;
      if (signOutError) setError(SIGN_OUT_ERROR_MESSAGE);
    } catch {
      if (isMountedRef.current) setError(SIGN_OUT_ERROR_MESSAGE);
    } finally {
      signingOutRef.current = false;
      if (isMountedRef.current) setIsSigningOut(false);
    }
  }

  // Mientras se resuelve la sesión inicial no se muestra nada privado ni se redirige.
  if (sessionLoading) {
    return (
      <AdminAuthCard title="Cuenta">
        <p className="text-sm text-text-secondary" role="status">
          Comprobando sesión…
        </p>
      </AdminAuthCard>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  const email = session.user.email;

  return (
    <AdminAuthCard title="Cuenta">
      <p className="text-sm text-text-secondary" role="status">
        Sesión activa
        {email ? (
          <>
            {" "}
            como <span className="font-medium text-text-primary">{email}</span>
          </>
        ) : null}
        .
      </p>

      {/* key por cuenta: un cambio A → B desmonta por completo la instancia de A (borradores,
          modo edición, errores, locks) y crea una limpia para B. */}
      <ProfileSection key={session.user.id} />

      {error ? (
        <p role="alert" className="mt-4 text-sm text-accent-live">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void handleSignOut()}
        disabled={isSigningOut}
        className="mt-6 inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary disabled:pointer-events-none disabled:opacity-50"
      >
        {isSigningOut ? "Cerrando sesión…" : "Cerrar sesión"}
      </button>
    </AdminAuthCard>
  );
}
