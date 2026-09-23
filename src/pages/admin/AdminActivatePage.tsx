import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import AdminAuthCard from "@/components/admin/AdminAuthCard";

// /admin/activate (Bloque 3C). Consume una invitación admin (ver
// src/lib/admin-handlers.ts / POST /api/admin/activate) desde un enlace privado de la
// forma /admin/activate#token=<secreto>. El AAL observado aquí es solo UX: la única
// autoridad real es el backend, que vuelve a verificar el JWT y aal2 de forma
// independiente. No se consulta admin_roles desde el cliente, no se decodifica el JWT
// manualmente y no se deriva ningún rol/AAL de datos controlados por el navegador.

// El token viaja por fragmento (#), nunca por query string, para que no llegue a logs de
// servidor ni al header Referer. Se lee y se limpia inmediatamente con
// history.replaceState.
function readAndClearHashToken(): string | null {
  if (typeof window === "undefined") return null;

  const rawHash = window.location.hash;
  const token =
    rawHash.length > 1 ? new URLSearchParams(rawHash.slice(1)).get("token") : null;

  if (rawHash) {
    // Deja la URL visible sin el fragmento (p. ej. /admin/activate), sin crear una
    // entrada nueva en el historial ni disparar una navegación.
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }

  return token;
}

const ACTIVATION_ENDPOINT = "/api/admin/activate";

type RoleLabel = "admin" | "moderator";

type ActivateStep =
  | { kind: "checking" }
  | { kind: "invalid-link" }
  | { kind: "no-session" }
  | { kind: "checking-aal" }
  | { kind: "need-mfa" }
  | { kind: "aal-error" }
  | { kind: "ready" }
  | { kind: "activated"; role: RoleLabel };

interface ActivationError {
  message: string;
  action?: "login" | "mfa";
}

const UNEXPECTED_ERROR: ActivationError = {
  message: "Ocurrió un error inesperado. Inténtalo de nuevo.",
};

const NETWORK_ERROR: ActivationError = {
  message: "No se pudo conectar. Comprueba tu conexión e inténtalo de nuevo.",
};

/** Mapea el status HTTP de /api/admin/activate a un mensaje seguro. Nunca se propaga el
 *  body real de la respuesta (podría contener detalles internos inesperados). */
function activationErrorFromStatus(status: number): ActivationError {
  switch (status) {
    case 400:
      return { message: "La invitación no es válida, expiró o ya fue utilizada." };
    case 401:
      return { message: "Tu sesión expiró o no es válida.", action: "login" };
    case 403:
      return {
        message:
          "Debes completar la verificación en dos pasos antes de activar el acceso.",
        action: "mfa",
      };
    case 405:
      return { message: "No se pudo procesar la solicitud. Inténtalo más tarde." };
    default:
      return { message: "Ocurrió un error interno. Inténtalo más tarde." };
  }
}

const ROLE_LABELS: Record<RoleLabel, string> = {
  admin: "Administrador",
  moderator: "Moderador",
};

export default function AdminActivatePage() {
  const { session, loading: sessionLoading } = useAuth();
  const hasSession = Boolean(session);

  // Ciclo de vida: UNA captura por MONTAJE de este componente, no una por evaluación de
  // módulo. Un import dinámico (React.lazy) solo evalúa el módulo la primera vez que se
  // visita la ruta; si la captura viviera a nivel de módulo, navegar fuera de
  // /admin/activate y volver a entrar más tarde con un token distinto (sin recargar la
  // página) reutilizaría silenciosamente el primer token capturado, o ignoraría uno
  // nuevo. Atando la captura al ciclo de vida del COMPONENTE en cambio, cada entrada real
  // a la ruta (cada montaje) vuelve a leer el hash tal como está en ESE momento.
  //
  // La captura ocurre en el cuerpo del render (no en un useEffect ni en el inicializador
  // de useState) y se protege con un ref para que ocurra como mucho una vez por montaje:
  //   - Bajo React StrictMode (dev), React invoca el cuerpo del componente dos veces
  //     seguidas por cada render, usando el MISMO fiber/hooks antes de confirmar — un
  //     ref escrito en la primera invocación ya está poblado en la segunda, así que la
  //     guarda (`current === undefined`) evita una segunda lectura del hash (que ya
  //     estaría vacío tras la primera limpieza). React también duplica el ciclo
  //     setup→cleanup→setup de los EFECTOS en StrictMode, pero eso no toca useRef/
  //     useState: el valor ya capturado sobrevive intacto a esa simulación.
  //   - Un desmontaje real (navegar a otra ruta) destruye el fiber y, con él, este ref.
  //     Si el usuario vuelve a entrar a /admin/activate más tarde (con un token distinto
  //     en el hash), React crea una instancia nueva del componente con un ref nuevo
  //     (`current === undefined` otra vez), así que esa entrada captura el token que
  //     esté presente en ESE momento — nunca el de una visita anterior.
  const capturedTokenRef = useRef<string | null | undefined>(undefined);
  if (capturedTokenRef.current === undefined) {
    capturedTokenRef.current = readAndClearHashToken();
  }
  const activationToken = capturedTokenRef.current;

  const [step, setStep] = useState<ActivateStep>({ kind: "checking" });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activationError, setActivationError] = useState<ActivationError | null>(null);

  // Única fuente de verdad de "qué pantalla mostrar": el AAL se consulta mediante la API
  // oficial de Supabase (nunca se infiere de datos guardados localmente) y solo importa
  // para UX. Se reevalúa cuando cambia la sesión, no en cada render.
  useEffect(() => {
    let cancelled = false;

    async function resolveStep() {
      if (sessionLoading) {
        setStep({ kind: "checking" });
        return;
      }
      if (!activationToken) {
        setStep({ kind: "invalid-link" });
        return;
      }
      if (!hasSession) {
        setStep({ kind: "no-session" });
        return;
      }
      if (!supabase) {
        setStep({ kind: "aal-error" });
        return;
      }

      setStep({ kind: "checking-aal" });
      const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (cancelled) return;
      if (error) {
        setStep({ kind: "aal-error" });
        return;
      }
      setStep(data.currentLevel === "aal2" ? { kind: "ready" } : { kind: "need-mfa" });
    }

    void resolveStep();
    return () => {
      cancelled = true;
    };
  }, [sessionLoading, hasSession, activationToken]);

  async function activate() {
    if (!supabase || !activationToken) return;
    setActivationError(null);
    setIsSubmitting(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        setActivationError({
          message: "Tu sesión expiró o no es válida.",
          action: "login",
        });
        return;
      }

      let response: Response;
      try {
        // Body EXCLUSIVAMENTE { token }: nunca se envía userId, role, email, aal ni
        // ningún otro dato — el backend es la única autoridad para todo eso.
        response = await fetch(ACTIVATION_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ token: activationToken }),
        });
      } catch {
        setActivationError(NETWORK_ERROR);
        return;
      }

      if (!response.ok) {
        setActivationError(activationErrorFromStatus(response.status));
        return;
      }

      const body: unknown = await response.json().catch(() => null);
      const role =
        body && typeof body === "object" ? (body as { role?: unknown }).role : undefined;
      if (role !== "admin" && role !== "moderator") {
        setActivationError(activationErrorFromStatus(500));
        return;
      }

      setStep({ kind: "activated", role });
    } catch {
      setActivationError(UNEXPECTED_ERROR);
    } finally {
      setIsSubmitting(false);
    }
  }

  if (step.kind === "checking" || step.kind === "checking-aal") {
    return (
      <AdminAuthCard title="Activar acceso">
        <p className="text-sm text-text-secondary" role="status">
          {step.kind === "checking"
            ? "Comprobando tu sesión…"
            : "Comprobando tu estado de verificación…"}
        </p>
      </AdminAuthCard>
    );
  }

  if (step.kind === "invalid-link") {
    return (
      <AdminAuthCard title="Activar acceso">
        <p role="alert" className="text-sm text-accent-live">
          Este enlace de activación no es válido o está incompleto.
        </p>
      </AdminAuthCard>
    );
  }

  if (step.kind === "aal-error") {
    return (
      <AdminAuthCard title="Activar acceso">
        <p role="alert" className="text-sm text-accent-live">
          No se pudo comprobar tu estado de verificación en dos pasos.
        </p>
      </AdminAuthCard>
    );
  }

  if (step.kind === "no-session") {
    return (
      <AdminAuthCard
        title="Activar acceso"
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
          Inicia sesión para activar tu invitación. Si abandonas esta página deberás
          volver a abrir el enlace de activación.
        </p>
      </AdminAuthCard>
    );
  }

  if (step.kind === "need-mfa") {
    return (
      <AdminAuthCard
        title="Activar acceso"
        footer={
          <Link
            to="/admin/mfa"
            className="font-medium text-accent-primary hover:underline"
          >
            Ir a verificación en dos pasos
          </Link>
        }
      >
        <p className="text-sm text-text-secondary">
          Debes completar la verificación en dos pasos antes de activar tu invitación. Si
          abandonas esta página deberás volver a abrir el enlace de activación.
        </p>
      </AdminAuthCard>
    );
  }

  if (step.kind === "activated") {
    return (
      <AdminAuthCard title="Acceso activado">
        <p className="text-sm text-text-secondary" role="status">
          Tu acceso fue activado correctamente con el rol{" "}
          <span className="font-medium text-text-primary">{ROLE_LABELS[step.role]}</span>.
        </p>
      </AdminAuthCard>
    );
  }

  // step.kind === "ready"
  return (
    <AdminAuthCard title="Activar acceso">
      <p className="text-sm text-text-secondary">
        Pulsa el botón para activar tu invitación con esta cuenta.
      </p>

      {activationError ? (
        <p role="alert" className="mt-4 text-sm text-accent-live">
          {activationError.message}{" "}
          {activationError.action === "login" ? (
            <Link to="/admin/login" className="font-medium underline">
              Iniciar sesión
            </Link>
          ) : null}
          {activationError.action === "mfa" ? (
            <Link to="/admin/mfa" className="font-medium underline">
              Ir a verificación en dos pasos
            </Link>
          ) : null}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void activate()}
        disabled={isSubmitting}
        className="mt-6 inline-flex min-h-11 items-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50"
      >
        {isSubmitting ? "Activando…" : "Activar acceso"}
      </button>
    </AdminAuthCard>
  );
}
