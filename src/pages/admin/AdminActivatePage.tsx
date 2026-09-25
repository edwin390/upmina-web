import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useAdminAccess } from "@/hooks/useAdminAccess";
import { classifyPrivilegedFailure } from "@/lib/privileged-response";
import { resolveActivationDestination } from "@/lib/activation-destination";
import {
  bindPendingInvitationToUser,
  capturePendingInvitation,
  clearPendingInvitation,
  hasPendingInvitation,
  readPendingInvitation,
} from "@/lib/pending-invitation";
import AdminAuthCard from "@/components/admin/AdminAuthCard";

// /admin/activate (Bloque 3C, flujo completo en la Fase 9G-4). Consume una invitación desde un
// enlace privado /admin/activate#token=<secreto>. Recorrido:
//
//   enlace con #token → captura en MEMORIA (pending-invitation) y limpia el fragmento
//   sin sesión        → /login?returnTo=/admin/activate (el token NO viaja: sigue en memoria)
//   con sesión        → el token se asocia (bind) al user.id autenticado; NO se consume
//   sin MFA reciente  → /admin/mfa?returnTo=/admin/activate (según /access, nunca según aal2)
//   con MFA reciente  → botón EXPLÍCITO "Activar acceso"; volver de login/MFA NO activa solo
//   POST /activate    → el backend vuelve a verificar MFA reciente, la invitación y concede el rol
//   éxito             → se borra el token y se va al destino según el rol concedido
//
// El frontend solo transporta temporalmente el secreto y presenta estados: token, expiración,
// revocación, uso, rol y MFA los decide el backend. Un refresco completo pierde el token
// (memoria de módulo, a propósito): se pide volver a abrir el enlace original; nunca se guarda
// en storage, URL, history state ni returnTo.
//
// Retención del token según la respuesta (contrato actual de POST /api/admin/activate):
//   2xx                   → se borra (el backend ya lo consumió)
//   400                   → se borra (rechazo de invitación: el backend no distingue el motivo)
//   403 step_up_required  → se conserva: MFA y volver, pulsando "Activar acceso" otra vez
//   401 / 5xx / red / otro → se conserva: reintento manual sin reabrir el enlace
// El token se LEE (no se consume) antes del POST para poder reintentar.

const ACTIVATE_PATH = "/admin/activate";
const LOGIN_PATH = `/login?returnTo=${ACTIVATE_PATH}`;
const MFA_PATH = `/admin/mfa?returnTo=${ACTIVATE_PATH}`;
const ACTIVATION_ENDPOINT = "/api/admin/activate";

type TokenCapture = "none" | "captured" | "invalid";

// El token viaja por fragmento (#), nunca por query string, para que no llegue a logs de servidor
// ni al header Referer. Se lee, se guarda en memoria y se limpia el fragmento de inmediato.
function captureTokenFromHash(): TokenCapture {
  if (typeof window === "undefined") return "none";

  const rawHash = window.location.hash;
  if (!rawHash) return "none";

  const token =
    rawHash.length > 1 ? new URLSearchParams(rawHash.slice(1)).get("token") : null;

  // Deja la URL visible sin el fragmento, sin crear una entrada nueva en el historial y
  // conservando el state que React Router guarda en window.history.
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname + window.location.search,
  );

  if (capturePendingInvitation(token)) return "captured";
  // Un enlace inválido es el ÚLTIMO enlace abierto: no se sigue usando un token anterior.
  clearPendingInvitation();
  return "invalid";
}

/** Estado del router al volver del step-up (ver AdminMfaPage). Solo UX anti-bucle. */
function returnedFromMfa(state: unknown): boolean {
  return Boolean(
    state && typeof state === "object" && (state as { fromMfa?: unknown }).fromMfa,
  );
}

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

const TRANSIENT_ERROR: ActivationError = {
  message: "Ocurrió un error interno. Inténtalo de nuevo más tarde.",
};

const SESSION_ERROR: ActivationError = {
  message: "Tu sesión expiró o no es válida.",
  action: "login",
};

const MFA_ERROR: ActivationError = {
  message: "Debes completar la verificación en dos pasos antes de activar el acceso.",
  action: "mfa",
};

type FinalStep = { kind: "activated" } | { kind: "rejected" } | { kind: "unavailable" };

const BUTTON_SECONDARY =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary";

export default function AdminActivatePage() {
  const { user, loading: sessionLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const userId = user?.id ?? null;

  // UNA captura por MONTAJE (ref), en el cuerpo del render: bajo StrictMode el cuerpo se ejecuta
  // dos veces y el ref evita una segunda lectura del hash (que ya estaría vacío). Un montaje
  // nuevo con otro token en el hash captura ese token; sin hash (volver de login/MFA) no toca la
  // memoria.
  const captureRef = useRef<TokenCapture | undefined>(undefined);
  if (captureRef.current === undefined) {
    captureRef.current = captureTokenFromHash();
  }

  // Sin token (enlace perdido/inválido) no hay nada que comprobar: no se consulta /access.
  const { status, access, refetch, invalidate } = useAdminAccess({
    fresh: true,
    enabled: captureRef.current !== "invalid" && hasPendingInvitation(),
  });

  const [finalStep, setFinalStep] = useState<FinalStep | null>(null);
  const [bindState, setBindState] = useState<{ userId: string; ok: boolean } | null>(
    null,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activationError, setActivationError] = useState<ActivationError | null>(null);
  const submittingRef = useRef(false);
  const mfaReturnGuardRef = useRef(returnedFromMfa(location.state));

  // Asocia el token (aún sin usuario) a la cuenta autenticada. Un token ya asociado a OTRA cuenta
  // se destruye y falla cerrado. No consume nada.
  useEffect(() => {
    if (!userId) {
      setBindState(null);
      return;
    }
    setBindState({ userId, ok: bindPendingInvitationToUser(userId) });
  }, [userId]);

  const mfaRecent = status === "ready" && access?.mfaRecent === true;
  useEffect(() => {
    // El servidor ya reconoce el MFA reciente: la guarda anti-bucle cumplió su función.
    if (mfaRecent) mfaReturnGuardRef.current = false;
  }, [mfaRecent]);

  async function activate() {
    // Guarda síncrona contra doble clic: `disabled` solo se aplica en el siguiente render.
    if (submittingRef.current || !supabase || !userId) return;
    submittingRef.current = true;
    setActivationError(null);
    setIsSubmitting(true);
    try {
      // Se LEE sin consumir: si la petición no puede completarse, el token sigue disponible.
      const token = readPendingInvitation(userId);
      if (!token) {
        setFinalStep({ kind: "unavailable" });
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      // La sesión pudo cambiar entre el render y el clic: el token asociado a esta cuenta NUNCA se
      // envía con el Bearer de otra. Falla cerrado antes del POST y sin borrar nada.
      if (!accessToken || sessionData.session?.user?.id !== userId) {
        setActivationError(SESSION_ERROR);
        return;
      }

      let response: Response;
      try {
        // Body EXCLUSIVAMENTE { token }: nunca userId, role, email ni aal.
        response = await fetch(ACTIVATION_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ token }),
        });
      } catch {
        setActivationError(NETWORK_ERROR);
        return;
      }

      if (response.ok) {
        // El backend ya consumió la invitación: el token no se conserva.
        clearPendingInvitation();
        const body: unknown = await response.json().catch(() => null);
        const role =
          body && typeof body === "object"
            ? (body as { role?: unknown }).role
            : undefined;
        setFinalStep({ kind: "activated" });
        // Nada se inyecta en la caché de acceso: se revalida con el servidor y /admin (o la
        // cuenta) decide con el rol real.
        await invalidate();
        navigate(resolveActivationDestination(role), { replace: true });
        return;
      }

      if (response.status === 400) {
        // Rechazo de invitación (inexistente, usada, expirada, revocada…): terminal.
        clearPendingInvitation();
        setFinalStep({ kind: "rejected" });
        return;
      }

      if (response.status === 401) {
        setActivationError(SESSION_ERROR);
        return;
      }

      if (response.status === 403) {
        const failure = await classifyPrivilegedFailure(response);
        if (failure === "step_up_required") {
          // MFA vencido entre medias: se conserva el token y se revalida el acceso; el servidor
          // decide y, si corresponde, se vuelve a MFA. Nada se reintenta solo.
          setActivationError(MFA_ERROR);
          await invalidate();
          return;
        }
        setActivationError(TRANSIENT_ERROR);
        return;
      }

      setActivationError(TRANSIENT_ERROR);
    } catch {
      setActivationError(UNEXPECTED_ERROR);
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  if (finalStep?.kind === "activated") {
    return (
      <AdminAuthCard title="Acceso activado">
        <p className="text-sm text-text-secondary" role="status">
          Tu acceso fue activado correctamente.
        </p>
      </AdminAuthCard>
    );
  }

  if (finalStep?.kind === "rejected") {
    return (
      <AdminAuthCard title="Activar acceso">
        <p role="alert" className="text-sm text-accent-live">
          La invitación no es válida, expiró o ya fue utilizada.
        </p>
        <p className="mt-4 text-sm text-text-secondary">
          <Link to="/account" className="font-medium text-accent-primary hover:underline">
            Ir a mi cuenta
          </Link>
        </p>
      </AdminAuthCard>
    );
  }

  const linkUnavailable =
    finalStep?.kind === "unavailable" ||
    captureRef.current === "invalid" ||
    !hasPendingInvitation() ||
    bindState?.ok === false;

  if (linkUnavailable) {
    return (
      <AdminAuthCard title="Activar acceso">
        <p role="alert" className="text-sm text-accent-live">
          Este enlace de invitación ya no está disponible en esta sesión. Vuelve a abrir
          el enlace original.
        </p>
      </AdminAuthCard>
    );
  }

  if (sessionLoading) {
    return (
      <AdminAuthCard title="Activar acceso">
        <p className="text-sm text-text-secondary" role="status">
          Comprobando tu sesión…
        </p>
      </AdminAuthCard>
    );
  }

  if (!userId) {
    // Sin sesión: se autentica con el login normal. El token NO viaja: sigue en memoria.
    return <Navigate to={LOGIN_PATH} replace />;
  }

  if (bindState?.userId !== userId || status === "loading") {
    return (
      <AdminAuthCard title="Activar acceso">
        <p className="text-sm text-text-secondary" role="status">
          Comprobando tu estado de verificación…
        </p>
      </AdminAuthCard>
    );
  }

  if (status === "unauthenticated" || status === "no-session") {
    return (
      <AdminAuthCard title="Activar acceso">
        <p role="alert" className="text-sm text-accent-live">
          Tu sesión ya no es válida. Cierra sesión e inicia sesión de nuevo.
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          className={`mt-6 ${BUTTON_SECONDARY}`}
        >
          Cerrar sesión
        </button>
      </AdminAuthCard>
    );
  }

  if (status === "error" || !access) {
    return (
      <AdminAuthCard title="Activar acceso">
        <p role="alert" className="text-sm text-accent-live">
          No se pudo comprobar tu estado de verificación en dos pasos.
        </p>
        <button
          type="button"
          onClick={() => void refetch()}
          className={`mt-6 ${BUTTON_SECONDARY}`}
        >
          Reintentar
        </button>
      </AdminAuthCard>
    );
  }

  if (!access.mfaRecent) {
    if (mfaReturnGuardRef.current) {
      // Volvió de un MFA y el servidor todavía no lo reconoce: no se redirige otra vez.
      return (
        <AdminAuthCard title="Activar acceso">
          <p role="alert" className="text-sm text-accent-live">
            No pudimos confirmar tu verificación en dos pasos reciente.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void refetch()}
              className={BUTTON_SECONDARY}
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

  // Sesión + token asociado + MFA reciente: la activación exige un clic explícito.
  return (
    <AdminAuthCard title="Activar acceso">
      <p className="text-sm text-text-secondary">
        Pulsa el botón para activar tu invitación con esta cuenta.
      </p>

      {activationError ? (
        <p role="alert" className="mt-4 text-sm text-accent-live">
          {activationError.message}{" "}
          {activationError.action === "login" ? (
            <Link to={LOGIN_PATH} className="font-medium underline">
              Iniciar sesión
            </Link>
          ) : null}
          {activationError.action === "mfa" ? (
            <Link to={MFA_PATH} className="font-medium underline">
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
