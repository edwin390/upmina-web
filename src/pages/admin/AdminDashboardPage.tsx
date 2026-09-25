import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useAdminAccess } from "@/hooks/useAdminAccess";
import { PrivilegedFailureContext } from "@/hooks/privileged-failure";
import {
  classifyPrivilegedFailure,
  type PrivilegedFailure,
} from "@/lib/privileged-response";
import AdminAuthCard from "@/components/admin/AdminAuthCard";
import SocialConnectionsSection from "@/components/admin/SocialConnectionsSection";
import TeamInvitationsSection from "@/components/admin/TeamInvitationsSection";
import TeamMembersSection from "@/components/admin/TeamMembersSection";

// /admin (Bloque 5C, reescrito en la Fase 9G-3). Máquina de estados sobre lo que el SERVIDOR dice:
//
//   sin sesión                        → /login?returnTo=/admin
//   sesión + GET /api/admin/access:
//     role != admin (USER, MODERATOR,
//       DEVELOPER)                    → acceso denegado + enlace a /account. NUNCA MFA: MFA no
//                                       concede permisos y quien no es ADMIN no tiene nada que
//                                       "desbloquear".
//     role admin + mfa.recent=false   → /admin/mfa?returnTo=/admin (step-up)
//     role admin + mfa.recent=true    → GET /api/admin/me (guard estricto) → panel
//
// El frontend jamás decide por sí mismo: no usa aal2 como sustituto de MFA reciente, ni el email,
// metadata, localStorage o la mera existencia de sesión. Cada sección privilegiada vuelve a ser
// validada por su endpoint; este componente solo PRESENTA.
//
// Anti-bucle:
//   - un rechazo 403 genérico (rol insuficiente o revocado) invalida el acceso y NO lleva a MFA;
//   - si la persona vuelve de /admin/mfa (state.fromMfa) y el servidor aún dice recent=false, NO
//     se redirige otra vez: se muestra un error con reintento manual;
//   - un `step_up_required` de una sección (MFA vencido con el panel abierto) invalida el acceso;
//     el servidor responderá recent=false y se inicia el step-up. Nunca se reproduce ni se
//     serializa la petición pendiente: tras el MFA la persona vuelve y debe repetir/confirmar.

const ME_ENDPOINT = "/api/admin/me";
const MFA_PATH = "/admin/mfa?returnTo=/admin";
const LOGIN_PATH = "/login?returnTo=/admin";

type PanelState =
  { kind: "loading" } | { kind: "ready"; capabilities: string[] } | { kind: "error" };

/** Estado del router al volver del step-up (ver AdminMfaPage). Solo UX anti-bucle. */
function returnedFromMfa(state: unknown): boolean {
  return Boolean(
    state && typeof state === "object" && (state as { fromMfa?: unknown }).fromMfa,
  );
}

// Estado de UI (panel cargado, guarda fromMfa, "hubo panel") pertenece a UNA persona: se remonta al
// cambiar de usuario para que B nunca herede el panel ni el mensaje de revocación de A.
export default function AdminDashboardPage() {
  const { user } = useAuth();
  return <AdminDashboard key={user?.id ?? "anonymous"} />;
}

function AdminDashboard() {
  const { signOut } = useAuth();
  const location = useLocation();
  const { status, access, refetch, invalidate } = useAdminAccess({ fresh: true });

  // true mientras esta visita venga de un MFA y aún no se haya visto recent=true.
  const mfaReturnGuardRef = useRef(returnedFromMfa(location.state));
  // ¿Se llegó a mostrar el panel? Distingue "nunca tuvo acceso" de "acceso revocado".
  const hadPanelRef = useRef(false);

  const [panel, setPanel] = useState<PanelState>({ kind: "loading" });

  const role = access?.role ?? null;
  const mfaRecent = access?.mfaRecent ?? false;
  const canLoadPanel = status === "ready" && role === "admin" && mfaRecent;

  // Rechazos de las secciones (403 genérico / step_up_required / 401): se invalida el acceso y la
  // respuesta del servidor decide la pantalla. Un 403 genérico jamás inicia MFA.
  const handleFailure = useCallback(
    (_failure: PrivilegedFailure) => {
      void invalidate();
    },
    [invalidate],
  );

  // GET /api/admin/me: guard estricto. Solo se lanza con role admin + MFA reciente informados por
  // /access; un efecto invalidado nunca lanza la request de un estado viejo.
  useEffect(() => {
    if (!canLoadPanel) {
      // Sin rol admin + MFA reciente no hay panel: al volver a cumplirse, nunca se reutiliza el
      // estado "ready" anterior (evita un destello de contenido antes de revalidar con /me).
      setPanel({ kind: "loading" });
      return;
    }
    // El servidor ya reconoce el MFA reciente: la guarda anti-bucle cumplió su función y no debe
    // quedar pegada (un step_up_required posterior tiene que poder iniciar otro MFA).
    mfaReturnGuardRef.current = false;
    let cancelled = false;
    setPanel({ kind: "loading" });

    async function loadPanel() {
      let accessToken: string | undefined;
      try {
        const { data } = supabase ? await supabase.auth.getSession() : { data: null };
        accessToken = data?.session?.access_token;
      } catch {
        if (!cancelled) setPanel({ kind: "error" });
        return;
      }
      if (cancelled) return;
      if (!accessToken) {
        setPanel({ kind: "error" });
        return;
      }

      let response: Response;
      try {
        response = await fetch(ME_ENDPOINT, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      } catch {
        if (!cancelled) setPanel({ kind: "error" });
        return;
      }
      if (cancelled) return;

      if (response.status === 401 || response.status === 403) {
        // El servidor manda: se revalida el acceso (rol revocado o MFA vencido) y esa respuesta
        // decide. Nunca se navega a MFA desde aquí.
        const failure = await classifyPrivilegedFailure(response);
        if (cancelled) return;
        if (failure) handleFailure(failure);
        setPanel({ kind: "error" });
        return;
      }
      if (!response.ok) {
        setPanel({ kind: "error" });
        return;
      }

      const body: unknown = await response.json().catch(() => null);
      if (cancelled) return;
      const meRole =
        body && typeof body === "object" ? (body as { role?: unknown }).role : undefined;
      if (meRole !== "admin") {
        setPanel({ kind: "error" });
        return;
      }
      // Las capacidades de /me sirven SOLO para decidir qué secciones PRESENTAR; cada endpoint
      // vuelve a exigir la suya en el servidor.
      const raw =
        body && typeof body === "object"
          ? (body as { capabilities?: unknown }).capabilities
          : undefined;
      const capabilities = Array.isArray(raw)
        ? raw.filter((c): c is string => typeof c === "string")
        : [];
      hadPanelRef.current = true;
      mfaReturnGuardRef.current = false;
      setPanel({ kind: "ready", capabilities });
    }

    void loadPanel();
    return () => {
      cancelled = true;
    };
  }, [canLoadPanel, handleFailure]);

  if (status === "loading") {
    return (
      <AdminAuthCard title="Panel de administración">
        <p className="text-sm text-text-secondary" role="status">
          Comprobando tu sesión…
        </p>
      </AdminAuthCard>
    );
  }

  if (status === "no-session") {
    return <Navigate to={LOGIN_PATH} replace />;
  }

  if (status === "unauthenticated") {
    // Hay sesión local pero el servidor la rechazó: NO se envía a /login (con sesión local,
    // /login redirigiría de vuelta aquí y se formaría un bucle). Se ofrece cerrarla.
    return (
      <AdminAuthCard title="Panel de administración">
        <p role="alert" className="text-sm text-accent-live">
          Tu sesión ya no es válida. Cierra sesión e inicia sesión de nuevo.
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-6 inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary"
        >
          Cerrar sesión
        </button>
      </AdminAuthCard>
    );
  }

  if (status === "error" || !access) {
    return (
      <AdminAuthCard title="Panel de administración">
        <p role="alert" className="text-sm text-accent-live">
          No se pudo comprobar tu acceso. Inténtalo de nuevo.
        </p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="mt-6 inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary"
        >
          Reintentar
        </button>
      </AdminAuthCard>
    );
  }

  if (role !== "admin") {
    // USER, MODERATOR o DEVELOPER (o un ADMIN cuyo rol se revocó con el panel abierto): acceso
    // denegado SIN MFA. Solo navegación normal.
    return (
      <AdminAuthCard title="Panel de administración">
        <p role="alert" className="text-sm text-accent-live">
          {hadPanelRef.current
            ? "Tu acceso administrativo ya no está disponible."
            : "No tienes acceso al panel de administración."}
        </p>
        <p className="mt-4 text-sm text-text-secondary">
          <Link to="/account" className="font-medium text-accent-primary hover:underline">
            Ir a mi cuenta
          </Link>
        </p>
      </AdminAuthCard>
    );
  }

  if (!mfaRecent) {
    if (mfaReturnGuardRef.current) {
      // Volvió de un MFA y el servidor todavía no lo reconoce: no se redirige otra vez.
      return (
        <AdminAuthCard title="Panel de administración">
          <p role="alert" className="text-sm text-accent-live">
            No pudimos confirmar tu verificación en dos pasos reciente.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void refetch()}
              className="inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary"
            >
              Reintentar
            </button>
            <Link
              to={MFA_PATH}
              className="inline-flex min-h-11 items-center rounded-md border border-accent-primary/60 px-5 py-2.5 text-sm font-semibold text-accent-primary hover:underline"
            >
              Verificar de nuevo
            </Link>
          </div>
        </AdminAuthCard>
      );
    }
    return <Navigate to={MFA_PATH} replace />;
  }

  // role admin + MFA reciente: la decisión final la toma GET /api/admin/me.
  if (panel.kind === "loading") {
    return (
      <AdminAuthCard title="Panel de administración">
        <p className="text-sm text-text-secondary" role="status">
          Comprobando tu sesión…
        </p>
      </AdminAuthCard>
    );
  }

  if (panel.kind === "error") {
    return (
      <AdminAuthCard title="Panel de administración">
        <p role="alert" className="text-sm text-accent-live">
          No se pudo autorizar esta sesión para acceder al panel.
        </p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="mt-6 inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary"
        >
          Reintentar
        </button>
      </AdminAuthCard>
    );
  }

  // panel.kind === "ready": único estado que renderiza contenido administrativo.
  return (
    <div className="mx-auto max-w-4xl px-4 py-16">
      <PrivilegedFailureContext.Provider value={handleFailure}>
        <div className="rounded-xl border border-accent-primary/40 bg-bg-surface p-6 sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="font-display text-3xl tracking-wide text-text-primary">
                Panel de administración
              </h1>
              <div
                className="mt-2 h-0.5 w-12 rounded-full bg-gradient-accent"
                aria-hidden="true"
              />
            </div>
            <span className="inline-flex items-center rounded-full border border-accent-primary/60 bg-accent-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-accent-primary">
              ADMIN
            </span>
          </div>

          <p className="mt-6 text-sm text-text-secondary" role="status">
            Sesión administrativa verificada.
          </p>

          <SocialConnectionsSection />

          {panel.capabilities.includes("team_admin") ? <TeamInvitationsSection /> : null}
          {panel.capabilities.includes("team_admin") ? <TeamMembersSection /> : null}

          <nav className="mt-8 grid gap-3" aria-label="Herramientas administrativas">
            <span className="rounded-md border border-border-subtle px-4 py-3 text-sm text-text-secondary">
              Próximamente: moderación y usuarios
            </span>
          </nav>

          <button
            type="button"
            onClick={() => void signOut()}
            className="mt-8 inline-flex min-h-11 items-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface"
          >
            Cerrar sesión
          </button>
        </div>
      </PrivilegedFailureContext.Provider>
    </div>
  );
}
