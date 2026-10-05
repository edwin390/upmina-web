import { useMfaVerification } from "@/hooks/useMfaVerification";
import {
  Link,
  Navigate,
  useSearchParams,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useAuth } from "@/lib/auth-context";
import {
  parseSafeReturnTo,
  parseSafeReturnToWithRoutes,
  type ReturnRoutes,
  safeMfaCancelTo,
} from "@/lib/safe-return-to";
import AdminAuthCard from "@/components/admin/AdminAuthCard";
import AdminAuthField from "@/components/admin/AdminAuthField";
import { buildTotpQrImageSrc } from "@/lib/mfa-qr";
import { useEffect, useRef } from "react";
import { showActionSuccess } from "@/lib/action-notice";

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

// Fase 9I-2C: /dev/media-harness (arnés de desarrollo del pipeline de medios) también necesita
// volver aquí tras un step-up de MFA, como cualquier otra sección privilegiada — pero NUNCA existe
// como ruta real en Production (ver App.tsx: el import es condicional a import.meta.env.DEV), así
// que no pertenece a RETURN_ROUTES (la allowlist DE PRODUCCIÓN, congelada, ver safe-return-to.ts).
// import.meta.env.DEV se sustituye estáticamente en build time: en Production esta constante es
// `null` y todo el bloque (incluido el string "/dev/media-harness") se elimina por tree-shaking,
// igual que la propia página del arnés — verificado tras el build, nunca solo asumido.
const DEV_RETURN_ROUTES: ReturnRoutes | null = import.meta.env.DEV
  ? Object.freeze({ "/dev/media-harness": Object.freeze({ allowsIntent: false }) })
  : null;

/** Igual que parseSafeReturnTo, pero en build de desarrollo también acepta el arnés de medios.
 *  Nunca se usa DEV_RETURN_ROUTES como sustituto de la allowlist de Producción: solo se consulta
 *  si esta primero no reconoce el destino. */
function resolveReturnTo(raw: string) {
  return (
    parseSafeReturnTo(raw) ??
    (DEV_RETURN_ROUTES && parseSafeReturnToWithRoutes(raw, DEV_RETURN_ROUTES))
  );
}

export default function AdminMfaPage() {
  const { signOut } = useAuth();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const origin = location.state?.cancelTo;
  const cancelTo =
    (import.meta.env.DEV && typeof origin === "string" && DEV_RETURN_ROUTES
      ? parseSafeReturnToWithRoutes(origin, DEV_RETURN_ROUTES)?.path
      : null) ?? safeMfaCancelTo(origin);

  // Destino tras un MFA reciente: null si no hay returnTo; un returnTo presente pero inválido
  // (externo, protocol-relative, malformado, fuera de la allowlist…) cae en /account.
  const rawReturnTo = searchParams.get("returnTo");
  const safeReturnTo =
    rawReturnTo === null ? null : (resolveReturnTo(rawReturnTo)?.path ?? null);
  const destination = rawReturnTo === null ? null : (safeReturnTo ?? "/account");

  const {
    step,
    didVerify,
    code,
    setCode,
    formError,
    isSubmitting,
    isSecretVisible,
    setIsSecretVisible,
    startEnrollment,
    cancelEnrollment,
    submitCode,
  } = useMfaVerification();
  const announced = useRef(false);
  useEffect(() => {
    if (step.kind !== "verified" || !didVerify || announced.current) return;
    announced.current = true;
    if (destination?.split("?")[0] === cancelTo.split("?")[0]) {
      showActionSuccess(
        "Verificación completada. Ya puedes realizar acciones de administrador.",
      );
    }
  }, [step.kind, didVerify, destination, cancelTo]);
  const cancelLink = (
    <Link
      to={cancelTo}
      replace
      state={{ mfaCancelled: true }}
      className="mt-4 inline-flex min-h-11 items-center text-sm text-text-secondary underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
    >
      Cancelar
    </Link>
  );

  if (step.kind === "checking") {
    return (
      <AdminAuthCard title="Verificación en dos pasos">
        <p className="text-sm text-text-secondary" role="status">
          Comprobando tu sesión…
        </p>
        {cancelLink}
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
            state={{ cancelTo }}
            className="font-medium text-accent-primary hover:underline"
          >
            Iniciar sesión
          </Link>
        }
      >
        <p className="text-sm text-text-secondary">
          Inicia sesión para configurar o completar la verificación en dos pasos.
        </p>
        {cancelLink}
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
        {cancelLink}
      </AdminAuthCard>
    );
  }

  if (step.kind === "fatal") {
    return (
      <AdminAuthCard title="Verificación en dos pasos">
        <p role="alert" className="text-sm text-accent-live">
          {step.message}
        </p>
        {cancelLink}
      </AdminAuthCard>
    );
  }

  if (step.kind === "verified") {
    // MFA reciente confirmado por el servidor. Con returnTo se continúa con el router interno; el
    // estado `fromMfa` solo permite a /admin evitar un bucle si el servidor discrepara.
    if (destination) {
      return <Navigate to={destination} replace state={{ fromMfa: true, cancelTo }} />;
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
        {!isSubmitting && cancelLink}
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
              onClick={() => {
                void cancelEnrollment(factorId).then(() => {
                  navigate(cancelTo, { replace: true, state: { mfaCancelled: true } });
                });
              }}
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
      {!isSubmitting && cancelLink}
    </AdminAuthCard>
  );
}
