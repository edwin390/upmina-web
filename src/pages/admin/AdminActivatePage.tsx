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
import { useTranslations } from "use-intl";

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
    state &&
    typeof state === "object" &&
    ((state as { fromMfa?: unknown }).fromMfa ||
      (state as { mfaCancelled?: unknown }).mfaCancelled),
  );
}

type ActivationErrorKey =
  | "unexpected"
  | "network"
  | "transient"
  | "session"
  | "mfa"
  | "reenroll"
  | "cleanupPending";

interface ActivationError {
  key: ActivationErrorKey;
  action?: "login" | "mfa";
}

const UNEXPECTED_ERROR: ActivationError = { key: "unexpected" };

const NETWORK_ERROR: ActivationError = { key: "network" };

const TRANSIENT_ERROR: ActivationError = { key: "transient" };

const SESSION_ERROR: ActivationError = { key: "session", action: "login" };

const MFA_ERROR: ActivationError = { key: "mfa", action: "mfa" };

// MFA fase 1: tras perder el acceso privilegiado hay que configurar un autenticador NUEVO; el
// anterior (aunque la sesión lo recuerde) no sirve para activar.
const REENROLL_ERROR: ActivationError = { key: "reenroll", action: "mfa" };

const CLEANUP_PENDING_ERROR: ActivationError = { key: "cleanupPending" };

/** Código de negocio de una respuesta de error (sin consumir el cuerpo original). */
async function readErrorCode(response: Response): Promise<string | null> {
  try {
    // En el navegador la respuesta es clonable; el cuerpo original queda intacto para quien siga.
    const source = typeof response.clone === "function" ? response.clone() : response;
    const body: unknown = await source.json();
    const code = (body as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

type FinalStep = { kind: "activated" } | { kind: "rejected" } | { kind: "unavailable" };

const BUTTON_SECONDARY =
  "inline-flex min-h-11 items-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary";

export default function AdminActivatePage() {
  const t = useTranslations("admin.activate");

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

      if (
        response.status === 403 &&
        (await readErrorCode(response)) === "mfa_reenroll_required"
      ) {
        // El token de la sesión puede seguir diciendo aal2 aunque Supabase ya degradó la sesión al
        // borrar el factor antiguo: se renueva y se revalida el acceso para que el recorrido pase
        // por /admin/mfa (enrolar y verificar uno nuevo). El servidor sigue decidiendo.
        try {
          await supabase.auth.refreshSession();
        } catch {
          /* sin renovación: el servidor sigue decidiendo en la siguiente comprobación */
        }
        setActivationError(REENROLL_ERROR);
        await invalidate();
        return;
      }

      if (
        response.status === 503 &&
        (await readErrorCode(response)) === "mfa_cleanup_pending"
      ) {
        setActivationError(CLEANUP_PENDING_ERROR);
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
      <AdminAuthCard title={t("activatedTitle")}>
        <p className="text-sm text-text-secondary" role="status">
          {t("activated")}
        </p>
      </AdminAuthCard>
    );
  }

  if (finalStep?.kind === "rejected") {
    return (
      <AdminAuthCard title={t("title")}>
        <p role="alert" className="text-sm text-accent-live">
          {t("rejected")}
        </p>
        <p className="mt-4 text-sm text-text-secondary">
          <Link to="/account" className="font-medium text-accent-primary hover:underline">
            {t("goToAccount")}
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
      <AdminAuthCard title={t("title")}>
        <p role="alert" className="text-sm text-accent-live">
          {t("unavailable")}
        </p>
      </AdminAuthCard>
    );
  }

  if (sessionLoading) {
    return (
      <AdminAuthCard title={t("title")}>
        <p className="text-sm text-text-secondary" role="status">
          {t("checkingSession")}
        </p>
      </AdminAuthCard>
    );
  }

  if (!userId) {
    // Sin sesión: se autentica con el login normal. El token NO viaja: sigue en memoria.
    return <Navigate to={LOGIN_PATH} replace state={location.state} />;
  }

  if (bindState?.userId !== userId || status === "loading") {
    return (
      <AdminAuthCard title={t("title")}>
        <p className="text-sm text-text-secondary" role="status">
          {t("checkingMfa")}
        </p>
      </AdminAuthCard>
    );
  }

  if (status === "unauthenticated" || status === "no-session") {
    return (
      <AdminAuthCard title={t("title")}>
        <p role="alert" className="text-sm text-accent-live">
          {t("invalidSession")}
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          className={`mt-6 ${BUTTON_SECONDARY}`}
        >
          {t("signOut")}
        </button>
      </AdminAuthCard>
    );
  }

  if (status === "error" || !access) {
    return (
      <AdminAuthCard title={t("title")}>
        <p role="alert" className="text-sm text-accent-live">
          {t("mfaCheckError")}
        </p>
        <button
          type="button"
          onClick={() => void refetch()}
          className={`mt-6 ${BUTTON_SECONDARY}`}
        >
          {t("retry")}
        </button>
      </AdminAuthCard>
    );
  }

  if (!access.mfaRecent) {
    if (mfaReturnGuardRef.current) {
      // Volvió de un MFA y el servidor todavía no lo reconoce: no se redirige otra vez.
      return (
        <AdminAuthCard title={t("title")}>
          <p role="alert" className="text-sm text-accent-live">
            {t("mfaUnconfirmed")}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void refetch()}
              className={BUTTON_SECONDARY}
            >
              {t("retry")}
            </button>
            <Link
              to={MFA_PATH}
              state={location.state}
              className="inline-flex min-h-11 items-center rounded-md border border-accent-primary/60 px-5 py-2.5 text-sm font-semibold text-accent-primary hover:underline"
            >
              {t("verifyAgain")}
            </Link>
          </div>
        </AdminAuthCard>
      );
    }
    return <Navigate to={MFA_PATH} replace state={location.state} />;
  }

  // Sesión + token asociado + MFA reciente: la activación exige un clic explícito.
  return (
    <AdminAuthCard title={t("title")}>
      <p className="text-sm text-text-secondary">{t("pressToActivate")}</p>

      {activationError ? (
        <p role="alert" className="mt-4 text-sm text-accent-live">
          {t(`errors.${activationError.key}`)}{" "}
          {activationError.action === "login" ? (
            <Link to={LOGIN_PATH} className="font-medium underline">
              {t("signIn")}
            </Link>
          ) : null}
          {activationError.action === "mfa" ? (
            <Link
              to={MFA_PATH}
              state={{ cancelTo: ACTIVATE_PATH }}
              className="font-medium underline"
            >
              {t("goToMfa")}
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
        {isSubmitting ? t("activating") : t("activate")}
      </button>
    </AdminAuthCard>
  );
}
