import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useAdminAccess } from "@/hooks/useAdminAccess";
import { parseSafeReturnTo } from "@/lib/safe-return-to";
import AdminAuthCard from "@/components/admin/AdminAuthCard";
import AdminAuthField from "@/components/admin/AdminAuthField";
import { buildTotpQrImageSrc } from "@/lib/mfa-qr";

// /admin/mfa (Bloque 3B). Enrolamiento y verificación TOTP mediante la API oficial de
// MFA de Supabase Auth (`supabase.auth.mfa`). Este contexto solo importa para UX y
// navegación: el AAL observado aquí NUNCA se convierte en autorización. No se consulta
// admin_roles desde el cliente, no se deriva ADMIN/MODERATOR de email/metadata/
// localStorage, y la autoridad real sigue siendo exclusivamente server-side (ver
// src/lib/admin-auth.ts, que exige aal2 verificado criptográficamente vía JWT antes de
// cualquier operación privilegiada).
//
// MFA es un segundo factor, no una prueba de identidad real ni una fuente de rol.
//
// Fase 9G-3 — MFA RECIENTE, no AAL2. `aal2` significa "esta sesión pasó MFA alguna vez"; el
// backend exige un TOTP de los últimos 30 minutos. Por eso esta página ya NO decide por el AAL:
// pregunta a GET /api/admin/access (vía useAdminAccess) si el MFA es reciente según el servidor.
// Una sesión aal2 con MFA vencido vuelve a pedir el código (challenge + verify sobre la sesión
// existente renueva el timestamp TOTP del token). Tras verificar se REVALIDA /access con el token
// nuevo antes de continuar; si el servidor todavía no lo reconoce se muestra un error, sin
// redirigir ni reintentar solo (no hay bucle).
//
// returnTo: se valida con parseSafeReturnTo (allowlist interna) y se navega SOLO con React Router.
// Un destino presente pero inválido cae en /account; sin returnTo la página muestra su estado.
// Nada se reproduce después del MFA: la persona vuelve y decide de nuevo qué hacer.
//
// Esta página no exige un rol: cualquier sesión puede enrolar/verificar su propio TOTP (también
// quien aún no tiene rol y va a activar una invitación, 9G-4). El acceso a /admin, en cambio, se
// decide ANTES de llegar aquí y a un usuario sin rol nunca se le envía.

const INVALID_OR_EXPIRED_CODES = new Set([
  "mfa_verification_failed",
  "mfa_challenge_expired",
  "mfa_verification_rejected",
]);

/** Traduce un AuthError de Supabase MFA a un mensaje seguro y entendible. Usa
 *  `error.code` (campo estable de la API, ver @supabase/auth-js/lib/error-codes) en vez
 *  de inspeccionar `error.message`: nunca se propaga el texto interno del proveedor. */
function mfaErrorMessage(error: unknown, fallback: string): string {
  const code =
    error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && INVALID_OR_EXPIRED_CODES.has(code)) {
    return "Código incorrecto o expirado.";
  }
  return fallback;
}

const UNEXPECTED_ERROR = "Ocurrió un error inesperado. Inténtalo de nuevo.";

type MfaStep =
  | { kind: "checking" }
  | { kind: "no-session" }
  | { kind: "session-invalid" }
  | { kind: "verified" }
  | { kind: "need-factor"; abandonedFactorId: string | null }
  | { kind: "enrolling"; factorId: string; qrCode: string; secret: string }
  | { kind: "challenge"; factorId: string }
  | { kind: "fatal"; message: string };

export default function AdminMfaPage() {
  const { signOut } = useAuth();
  const [searchParams] = useSearchParams();
  const {
    status: accessStatus,
    access,
    refetch: refetchAccess,
  } = useAdminAccess({ fresh: true });
  const mfaRecent = access?.mfaRecent ?? false;

  // Destino tras un MFA reciente: null si no hay returnTo; un returnTo presente pero inválido
  // (externo, protocol-relative, malformado, fuera de la allowlist…) cae en /account.
  const rawReturnTo = searchParams.get("returnTo");
  const safeReturnTo =
    rawReturnTo === null ? null : (parseSafeReturnTo(rawReturnTo)?.path ?? null);
  const destination = rawReturnTo === null ? null : (safeReturnTo ?? "/account");

  const [step, setStep] = useState<MfaStep>({ kind: "checking" });
  const [code, setCode] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSecretVisible, setIsSecretVisible] = useState(false);

  // Carga los factores TOTP para decidir entre challenge y enrolamiento. NO consulta el AAL: la
  // decisión "¿hace falta MFA?" ya la tomó el servidor (MFA reciente vía /access).
  const loadFactors = useCallback(async (isCurrent: () => boolean) => {
    if (!supabase) {
      setStep({ kind: "fatal", message: "El acceso admin no está configurado todavía." });
      return;
    }

    let factorsResult: Awaited<ReturnType<typeof supabase.auth.mfa.listFactors>>;
    try {
      factorsResult = await supabase.auth.mfa.listFactors();
    } catch {
      if (isCurrent()) {
        setStep({
          kind: "fatal",
          message: "No se pudieron cargar tus factores de verificación.",
        });
      }
      return;
    }
    if (!isCurrent()) return;
    const { data: factorsData, error: factorsError } = factorsResult;
    if (factorsError) {
      setStep({
        kind: "fatal",
        message: "No se pudieron cargar tus factores de verificación.",
      });
      return;
    }

    // `factorsData.totp` (contrato real de @supabase/auth-js: ver
    // AuthMFAListFactorsResponse en node_modules/@supabase/auth-js/dist/main/lib/types.d.ts)
    // SOLO contiene factores TOTP ya VERIFICADOS por diseño — un factor unverified nunca
    // aparece ahí. Si existe uno, es utilizable para challenge/verify (también sobre una sesión
    // que ya es aal2 pero cuyo MFA venció: es el "reverify").
    const verifiedTotp = factorsData.totp[0];
    if (verifiedTotp) {
      setStep({ kind: "challenge", factorId: verifiedTotp.id });
      return;
    }

    // Un enrolamiento TOTP interrumpido (se abandonó /admin/mfa antes de verificar el
    // código) deja un factor `unverified` en el servidor que solo es visible en
    // `factorsData.all` (la lista sin filtrar por status). No limpiarlo bloquearía
    // permanentemente al usuario: un enroll() posterior es rechazado por Supabase
    // (`too_many_enrolled_mfa_factors`, ver @supabase/auth-js/dist/main/lib/error-codes.d.ts)
    // porque ya existe un factor TOTP sin verificar. Se guarda su id para limpiarlo
    // recién cuando el usuario pulse explícitamente "Configurar autenticador" — nunca
    // automáticamente aquí, y nunca se toca un factor que no sea TOTP unverified.
    const abandonedTotp = factorsData.all.find(
      (factor) => factor.factor_type === "totp" && factor.status === "unverified",
    );
    setStep({ kind: "need-factor", abandonedFactorId: abandonedTotp?.id ?? null });
  }, []);

  // Única fuente de verdad de "qué pantalla mostrar": el estado de acceso que informa el servidor.
  useEffect(() => {
    let cancelled = false;
    const isCurrent = () => !cancelled;

    if (accessStatus === "loading") {
      setStep({ kind: "checking" });
    } else if (accessStatus === "no-session") {
      setStep({ kind: "no-session" });
    } else if (accessStatus === "unauthenticated") {
      setStep({ kind: "session-invalid" });
    } else if (accessStatus === "error") {
      setStep({
        kind: "fatal",
        message: "No se pudo comprobar tu estado de verificación en dos pasos.",
      });
    } else if (mfaRecent) {
      setStep({ kind: "verified" });
    } else {
      void loadFactors(isCurrent);
    }

    return () => {
      cancelled = true;
    };
  }, [accessStatus, mfaRecent, loadFactors]);

  async function startEnrollment(abandonedFactorId: string | null) {
    if (!supabase) return;
    setFormError(null);
    setIsSubmitting(true);
    try {
      if (abandonedFactorId) {
        // Limpieza de UN enrolamiento TOTP anterior interrumpido (unverified, detectado
        // en loadFactors vía factorsData.all) como parte de ESTA misma acción explícita
        // del usuario — nunca automática, nunca repetida en bucle: como mucho un
        // unenroll seguido de un enroll por cada clic. Si la limpieza falla, se detiene
        // aquí sin intentar el enroll (que volvería a fallar por la misma razón).
        const { error: cleanupError } = await supabase.auth.mfa.unenroll({
          factorId: abandonedFactorId,
        });
        if (cleanupError) {
          setFormError(
            "No se pudo limpiar un enrolamiento anterior incompleto. Inténtalo de nuevo.",
          );
          return;
        }
      }

      const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
      if (error) {
        setFormError("No se pudo iniciar el enrolamiento. Inténtalo de nuevo.");
        return;
      }
      // Solo en memoria: qr_code/secret/uri nunca se guardan en localStorage,
      // sessionStorage, cookies propias, query params ni el hash de la URL.
      setStep({
        kind: "enrolling",
        factorId: data.id,
        qrCode: data.totp.qr_code,
        secret: data.totp.secret,
      });
      setIsSecretVisible(false);
    } catch {
      setFormError(UNEXPECTED_ERROR);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function cancelEnrollment(factorId: string) {
    setIsSubmitting(true);
    try {
      if (supabase) {
        // Best-effort: el factor todavía no está verificado (nadie depende de él), así
        // que un fallo aquí no debe bloquear la cancelación ni mostrarse como error.
        // NUNCA se elimina un factor ya verificado por esta vía.
        await supabase.auth.mfa.unenroll({ factorId });
      }
    } catch {
      // Limpieza best-effort: se ignora deliberadamente.
    } finally {
      setCode("");
      setFormError(null);
      setIsSubmitting(false);
      // El factor que se acaba de cancelar/unenroll ya no existe: no hay ningún
      // enrolamiento abandonado pendiente de limpiar.
      setStep({ kind: "need-factor", abandonedFactorId: null });
    }
  }

  async function submitCode(event: FormEvent, factorId: string) {
    event.preventDefault();
    if (!supabase) return;
    setFormError(null);
    setIsSubmitting(true);
    try {
      // Un challenge nuevo por intento: nunca se reutiliza un challengeId de un envío
      // anterior, y siempre pertenece al factor que se está verificando.
      const { data: challengeData, error: challengeError } =
        await supabase.auth.mfa.challenge({ factorId });
      if (challengeError) {
        setFormError("No se pudo iniciar la verificación. Inténtalo de nuevo.");
        return;
      }

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challengeData.id,
        code,
      });
      if (verifyError) {
        setFormError(
          mfaErrorMessage(
            verifyError,
            "No se pudo verificar el código. Inténtalo de nuevo.",
          ),
        );
        return;
      }

      setCode("");
      // verify() ya dejó el token nuevo en la sesión de Supabase. Se REVALIDA con el servidor
      // (token vigente, MFA reciente según el backend) antes de continuar: no se asume el éxito.
      const refreshed = await refetchAccess();
      if (refreshed?.mfaRecent) {
        setStep({ kind: "verified" });
      } else {
        setFormError("No se pudo confirmar la verificación. Inténtalo de nuevo.");
      }
    } catch {
      setFormError(UNEXPECTED_ERROR);
    } finally {
      setIsSubmitting(false);
    }
  }

  if (step.kind === "checking") {
    return (
      <AdminAuthCard title="Verificación en dos pasos">
        <p className="text-sm text-text-secondary" role="status">
          Comprobando tu sesión…
        </p>
      </AdminAuthCard>
    );
  }

  if (step.kind === "no-session") {
    return (
      <AdminAuthCard
        title="Verificación en dos pasos"
        footer={
          <Link
            to={safeReturnTo ? `/login?returnTo=${safeReturnTo}` : "/login"}
            className="font-medium text-accent-primary hover:underline"
          >
            Iniciar sesión
          </Link>
        }
      >
        <p className="text-sm text-text-secondary">
          Inicia sesión para configurar o completar la verificación en dos pasos.
        </p>
      </AdminAuthCard>
    );
  }

  if (step.kind === "session-invalid") {
    return (
      <AdminAuthCard title="Verificación en dos pasos">
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

  if (step.kind === "fatal") {
    return (
      <AdminAuthCard title="Verificación en dos pasos">
        <p role="alert" className="text-sm text-accent-live">
          {step.message}
        </p>
      </AdminAuthCard>
    );
  }

  if (step.kind === "verified") {
    // MFA reciente confirmado por el servidor. Con returnTo se continúa con el router interno; el
    // estado `fromMfa` solo permite a /admin evitar un bucle si el servidor discrepara.
    if (destination) {
      return <Navigate to={destination} replace state={{ fromMfa: true }} />;
    }
    return (
      <AdminAuthCard title="Verificación en dos pasos">
        <p className="text-sm text-text-secondary" role="status">
          Tu verificación en dos pasos está vigente.
        </p>
        <p className="mt-4 text-sm text-text-secondary">
          <Link to="/account" className="font-medium text-accent-primary hover:underline">
            Ir a mi cuenta
          </Link>
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-6 inline-flex min-h-11 items-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface"
        >
          Cerrar sesión
        </button>
      </AdminAuthCard>
    );
  }

  if (step.kind === "need-factor") {
    return (
      <AdminAuthCard title="Verificación en dos pasos">
        <p className="text-sm text-text-secondary">
          Todavía no configuraste una app autenticadora para tu cuenta.
        </p>
        {formError ? (
          <p role="alert" className="mt-4 text-sm text-accent-live">
            {formError}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => void startEnrollment(step.abandonedFactorId)}
          disabled={isSubmitting}
          className="mt-6 inline-flex min-h-11 items-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50"
        >
          {isSubmitting ? "Iniciando…" : "Configurar autenticador"}
        </button>
      </AdminAuthCard>
    );
  }

  if (step.kind === "enrolling") {
    const { factorId, qrCode, secret } = step;
    return (
      <AdminAuthCard
        title="Configurar autenticador"
        subtitle="Escanea el código con tu app autenticadora (Google Authenticator, 1Password, Authy…) o introduce la clave manual."
      >
        {/* La documentación instalada de @supabase/auth-js es internamente inconsistente
            sobre el formato de qr_code (ver comentario de buildTotpQrImageSrc en
            src/lib/mfa-qr.ts): puede llegar como data URI ya completa, como SVG crudo
            sin encodear, o ya percent-encoded sin el prefijo `data:`. El helper detecta
            el formato real por su forma en vez de asumir uno fijo, evitando tanto el
            doble encoding como una data URI anidada inválida. */}
        <img
          src={buildTotpQrImageSrc(qrCode)}
          alt="Código QR para configurar tu app autenticadora"
          className="mx-auto h-40 w-40 rounded-md border border-border-subtle bg-bg-base p-2"
        />

        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="mfa-secret" className="block text-sm text-text-secondary">
              Clave manual
            </label>
            <button
              type="button"
              onClick={() => setIsSecretVisible((visible) => !visible)}
              className="text-xs font-medium text-accent-primary hover:underline"
            >
              {isSecretVisible ? "Ocultar" : "Mostrar"}
            </button>
          </div>
          <input
            id="mfa-secret"
            readOnly
            type={isSecretVisible ? "text" : "password"}
            value={secret}
            className="w-full rounded-md border border-border-subtle bg-bg-base px-3 py-2 font-mono text-sm text-text-primary outline-none"
          />
        </div>

        <form
          onSubmit={(event) => void submitCode(event, factorId)}
          className="mt-6 flex flex-col gap-4"
        >
          <AdminAuthField
            label="Código de verificación"
            id="mfa-enroll-code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={isSubmitting}
            errorId={formError ? "mfa-enroll-error" : undefined}
          />

          {formError ? (
            <p id="mfa-enroll-error" role="alert" className="text-sm text-accent-live">
              {formError}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50"
            >
              {isSubmitting ? "Verificando…" : "Verificar y activar"}
            </button>
            <button
              type="button"
              onClick={() => void cancelEnrollment(factorId)}
              disabled={isSubmitting}
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-border-subtle px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors duration-200 ease-smooth hover:border-accent-primary/60 hover:text-text-primary disabled:pointer-events-none disabled:opacity-50"
            >
              Cancelar
            </button>
          </div>
        </form>
      </AdminAuthCard>
    );
  }

  // step.kind === "challenge"
  return (
    <AdminAuthCard title="Verificación en dos pasos">
      <p className="text-sm text-text-secondary">
        Introduce el código de tu app autenticadora.
      </p>
      <form
        onSubmit={(event) => void submitCode(event, step.factorId)}
        className="mt-6 flex flex-col gap-4"
      >
        <AdminAuthField
          label="Código de verificación"
          id="mfa-code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={isSubmitting}
          errorId={formError ? "mfa-error" : undefined}
        />

        {formError ? (
          <p id="mfa-error" role="alert" className="text-sm text-accent-live">
            {formError}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-2 inline-flex min-h-11 items-center justify-center rounded-md border border-accent-primary/60 bg-accent-primary px-5 py-2.5 text-sm font-bold uppercase tracking-[0.18em] text-text-inverse shadow-glow-primary transition duration-200 ease-bounce hover:-translate-y-1 hover:bg-accent-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface disabled:pointer-events-none disabled:opacity-50"
        >
          {isSubmitting ? "Verificando…" : "Verificar"}
        </button>
      </form>
    </AdminAuthCard>
  );
}
