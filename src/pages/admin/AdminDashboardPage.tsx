import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import AdminAuthCard from "@/components/admin/AdminAuthCard";
import SocialConnectionsSection from "@/components/admin/SocialConnectionsSection";

// /admin (Bloque 5C). Primer shell administrativo, protegido exclusivamente mediante
// GET /api/admin/me (ver src/lib/admin-handlers.ts): el frontend nunca decide por sí
// mismo que una sesión es ADMIN. La única autoridad es la respuesta del backend
// (requirePrivileged: JWT verificado → aal2 → rol de admin_roles; /me ya no es ADMIN-only:
// también responde a moderator/developer). Este shell solo PRESENTA el panel cuando el rol
// devuelto es "admin"; la autorización real de cada acción sigue en el servidor. Solo interpreta status/body de esa respuesta para elegir qué UI mostrar,
// nunca consulta admin_roles directamente, no decodifica el JWT manualmente y no deriva
// ningún rol de email/metadata/localStorage/la mera existencia de una sesión.
//
// El único uso de la API oficial de MFA de Supabase aquí (getAuthenticatorAssuranceLevel)
// es para decidir si mostrar un CTA hacia /admin/mfa cuando el backend responde 403 — una
// pista de UX, nunca una fuente de autorización: el 403 en sí ya viene del backend, y
// completar MFA no concede acceso por sí solo (el shell solo se muestra tras un 200 real
// de /api/admin/me).

const ME_ENDPOINT = "/api/admin/me";

type DashboardStep =
  | { kind: "checking" }
  | { kind: "no-session" }
  | { kind: "denied"; canGoToMfa: boolean }
  | { kind: "verified" };

export default function AdminDashboardPage() {
  const { session, loading: sessionLoading, signOut } = useAuth();
  const hasSession = Boolean(session);

  const [step, setStep] = useState<DashboardStep>({ kind: "checking" });

  // Única fuente de verdad de "qué pantalla mostrar": se reevalúa cuando cambia la
  // presencia de sesión (login/logout) o mientras se resuelve la sesión inicial. Nunca se
  // asume el resultado a partir de un estado guardado localmente ni de un chequeo previo.
  useEffect(() => {
    let cancelled = false;

    async function resolveAccess() {
      if (sessionLoading) {
        setStep({ kind: "checking" });
        return;
      }
      // Sin sesión: nunca se llama a /api/admin/me sin un access token que enviar.
      if (!hasSession || !supabase) {
        setStep({ kind: "no-session" });
        return;
      }

      setStep({ kind: "checking" });

      let accessToken: string | undefined;
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        accessToken = sessionData.session?.access_token;
      } catch {
        // getSession() falló: fail closed con el mensaje genérico, sin detalles internos.
        if (!cancelled) setStep({ kind: "denied", canGoToMfa: false });
        return;
      }
      // Efecto invalidado (logout/cambio de sesión/unmount) mientras se leía la sesión:
      // nunca se lanza la request privilegiada de un efecto viejo.
      if (cancelled) return;
      if (!accessToken) {
        setStep({ kind: "no-session" });
        return;
      }

      let response: Response;
      try {
        response = await fetch(ME_ENDPOINT, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      } catch {
        // Fallo de red: fail closed, nunca se muestra el shell.
        if (!cancelled) setStep({ kind: "denied", canGoToMfa: false });
        return;
      }
      if (cancelled) return;

      if (response.status === 401) {
        // Identidad ausente/inválida: se trata igual que "sin sesión", nunca como un
        // rechazo distinto que pudiera insinuar que la cuenta existe/es privilegiada.
        setStep({ kind: "no-session" });
        return;
      }

      if (response.status === 403) {
        // El backend deliberadamente no distingue "falta AAL2" de "no tiene rol admin"
        // (ver handleAdminMe): el único uso legítimo de la API oficial de MFA aquí es
        // ofrecer un CTA de UX hacia /admin/mfa cuando la sesión observable todavía no
        // alcanzó aal2. Nunca se trata este chequeo como autorización: si falla o no es
        // concluyente, se cae al mensaje genérico sin CTA de MFA.
        let canGoToMfa = false;
        try {
          const { data: aalData, error: aalError } =
            await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
          canGoToMfa = !aalError && aalData.currentLevel !== "aal2";
        } catch {
          canGoToMfa = false;
        }
        if (!cancelled) setStep({ kind: "denied", canGoToMfa });
        return;
      }

      if (!response.ok) {
        // 500 u otro status inesperado: fail closed, sin intentar determinar la causa.
        setStep({ kind: "denied", canGoToMfa: false });
        return;
      }

      const body: unknown = await response.json().catch(() => null);
      // response.json() puede resolver tras un logout/unmount: un efecto invalidado nunca
      // debe establecer verified/denied.
      if (cancelled) return;
      const role =
        body && typeof body === "object" ? (body as { role?: unknown }).role : undefined;
      if (role !== "admin") {
        // 200 con una forma inesperada nunca se trata como éxito: fail closed.
        setStep({ kind: "denied", canGoToMfa: false });
        return;
      }

      setStep({ kind: "verified" });
    }

    void resolveAccess();
    return () => {
      cancelled = true;
    };
  }, [sessionLoading, hasSession]);

  if (step.kind === "checking") {
    return (
      <AdminAuthCard title="Panel de administración">
        <p className="text-sm text-text-secondary" role="status">
          Comprobando tu sesión…
        </p>
      </AdminAuthCard>
    );
  }

  if (step.kind === "no-session") {
    return (
      <AdminAuthCard
        title="Panel de administración"
        footer={
          <Link
            to="/admin/login"
            className="font-medium text-accent-primary hover:underline"
          >
            Iniciar sesión
          </Link>
        }
      >
        <p className="text-sm text-text-secondary">
          Inicia sesión para acceder al panel de administración.
        </p>
      </AdminAuthCard>
    );
  }

  if (step.kind === "denied") {
    return (
      <AdminAuthCard title="Panel de administración">
        <p role="alert" className="text-sm text-accent-live">
          No se pudo autorizar esta sesión para acceder al panel.
        </p>
        {step.canGoToMfa ? (
          <p className="mt-4 text-sm text-text-secondary">
            <Link
              to="/admin/mfa"
              className="font-medium text-accent-primary hover:underline"
            >
              Ir a verificación en dos pasos
            </Link>
          </p>
        ) : (
          <button
            type="button"
            onClick={() => void signOut()}
            className="mt-6 inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary"
          >
            Cerrar sesión
          </button>
        )}
      </AdminAuthCard>
    );
  }

  // step.kind === "verified": único estado que renderiza contenido administrativo.
  return (
    <div className="mx-auto max-w-4xl px-4 py-16">
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
    </div>
  );
}
