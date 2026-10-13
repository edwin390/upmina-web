import { useCallback, useEffect, useRef } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth-context";
import { useAdminAccess } from "@/hooks/useAdminAccess";
import { PrivilegedFailureContext } from "@/hooks/privileged-failure";
import type { PrivilegedFailure } from "@/lib/privileged-response";
import AdminAuthCard from "@/components/admin/AdminAuthCard";
import DeveloperCleanupsSection from "@/components/developer/DeveloperCleanupsSection";
import DeveloperRecoveriesSection from "@/components/developer/DeveloperRecoveriesSection";

// /admin/developer (Developer Panel V1). Máquina de estados sobre lo que el SERVIDOR dice, con
// navegación y protección INDEPENDIENTES del panel de Admin:
//
//   sin sesión                          → /login?returnTo=/admin/developer
//   sesión + GET /api/admin/access:
//     rol distinto de developer o sin
//       la capacidad developer_panel    → acceso denegado + enlace a /account. NUNCA MFA: MFA no
//                                         concede permisos (un ADMIN tampoco entra aquí).
//     developer + mfa.recent=false      → /admin/mfa?returnTo=/admin/developer (step-up)
//     developer + mfa.recent=true       → panel
//
// El frontend jamás decide por sí mismo: no usa aal2 como sustituto de MFA reciente ni el correo,
// metadata o localStorage. Cada sección vuelve a ser validada por su endpoint (rol developer + MFA
// reciente; aprobar/rechazar exigen además un TOTP de ≤ 5 min). Este componente solo PRESENTA.
// Anti-bucle: si se vuelve de /admin/mfa (state.fromMfa) y el servidor aún dice recent=false, no se
// redirige otra vez: se muestra un error con reintento manual.

const MFA_PATH = "/admin/mfa?returnTo=/admin/developer";
const LOGIN_PATH = "/login?returnTo=/admin/developer";

const BUTTON =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary";

function returnedFromMfa(state: unknown): boolean {
  return Boolean(
    state &&
    typeof state === "object" &&
    ((state as { fromMfa?: unknown }).fromMfa ||
      (state as { mfaCancelled?: unknown }).mfaCancelled),
  );
}

// El estado de UI pertenece a UNA persona: se remonta al cambiar de usuario para que B nunca herede
// el panel de A.
export default function DeveloperPage() {
  const { user } = useAuth();
  return <DeveloperPanel key={user?.id ?? "anonymous"} />;
}

function DeveloperPanel() {
  const { signOut } = useAuth();
  const location = useLocation();
  const { status, access, refetch, invalidate } = useAdminAccess({ fresh: true });
  const mfaReturnGuardRef = useRef(returnedFromMfa(location.state));
  const hadPanelRef = useRef(false);

  const allowed =
    status === "ready" &&
    access?.role === "developer" &&
    access.capabilities.includes("developer_panel");
  const panelVisible = allowed && access?.mfaRecent === true;
  useEffect(() => {
    if (!panelVisible) return;
    // El servidor ya reconoce el MFA reciente: la guarda anti-bucle cumplió su función.
    hadPanelRef.current = true;
    mfaReturnGuardRef.current = false;
  }, [panelVisible]);

  const handleFailure = useCallback(
    (_failure: PrivilegedFailure) => {
      void invalidate();
    },
    [invalidate],
  );

  if (status === "loading") {
    return (
      <AdminAuthCard title="Panel Developer">
        <p className="text-sm text-text-secondary" role="status">
          Comprobando tu sesión…
        </p>
      </AdminAuthCard>
    );
  }

  if (status === "no-session") {
    return <Navigate to={LOGIN_PATH} replace state={location.state} />;
  }

  if (status === "unauthenticated") {
    return (
      <AdminAuthCard title="Panel Developer">
        <p role="alert" className="text-sm text-accent-live">
          Tu sesión ya no es válida. Cierra sesión e inicia sesión de nuevo.
        </p>
        <button type="button" onClick={() => void signOut()} className={`mt-6 ${BUTTON}`}>
          Cerrar sesión
        </button>
      </AdminAuthCard>
    );
  }

  if (status === "error" || !access) {
    return (
      <AdminAuthCard title="Panel Developer">
        <p role="alert" className="text-sm text-accent-live">
          No se pudo comprobar tu acceso. Inténtalo de nuevo.
        </p>
        <button type="button" onClick={() => void refetch()} className={`mt-6 ${BUTTON}`}>
          Reintentar
        </button>
      </AdminAuthCard>
    );
  }

  if (!allowed) {
    // USER, MODERATOR o ADMIN (o un Developer cuyo rol se revocó con el panel abierto): acceso
    // denegado SIN MFA. Developer y Admin son roles independientes.
    return (
      <AdminAuthCard title="Panel Developer">
        <p role="alert" className="text-sm text-accent-live">
          {hadPanelRef.current
            ? "Tu acceso Developer ya no está disponible."
            : "No tienes acceso al panel Developer."}
        </p>
        <p className="mt-4 text-sm text-text-secondary">
          <Link to="/account" className="font-medium text-accent-primary hover:underline">
            Ir a mi cuenta
          </Link>
        </p>
      </AdminAuthCard>
    );
  }

  if (!access.mfaRecent) {
    if (mfaReturnGuardRef.current) {
      return (
        <AdminAuthCard title="Panel Developer">
          <p role="alert" className="text-sm text-accent-live">
            No pudimos confirmar tu verificación en dos pasos reciente.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button type="button" onClick={() => void refetch()} className={BUTTON}>
              Reintentar
            </button>
            <Link to={MFA_PATH} state={location.state} className={BUTTON}>
              Verificar de nuevo
            </Link>
          </div>
        </AdminAuthCard>
      );
    }
    return (
      <Navigate
        to={MFA_PATH}
        replace
        state={hadPanelRef.current ? { cancelTo: "/admin/developer" } : location.state}
      />
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-16">
      <PrivilegedFailureContext.Provider value={handleFailure}>
        <div className="rounded-xl border border-accent-primary/40 bg-bg-surface p-6 sm:p-8">
          <h1 className="font-display text-3xl tracking-wide text-text-primary">
            Panel Developer
          </h1>
          <div
            className="mt-2 h-0.5 w-12 rounded-full bg-gradient-accent"
            aria-hidden="true"
          />
          <p className="mt-4 text-sm text-text-secondary">
            Herramientas técnicas de Developer: supervisión de limpiezas de MFA y
            aprobación excepcional de recuperaciones. No concede permisos de Admin.
          </p>
          <DeveloperCleanupsSection />
          <DeveloperRecoveriesSection />
        </div>
      </PrivilegedFailureContext.Provider>
    </div>
  );
}
