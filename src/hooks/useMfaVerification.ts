import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import { useAdminAccess } from "@/hooks/useAdminAccess";

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

export function useMfaVerification(
  options: { explicit?: boolean; isCurrent?: () => Promise<boolean> } = {},
) {
  const {
    status: accessStatus,
    access,
    refetch: refetchAccess,
  } = useAdminAccess({ fresh: true });
  const mounted = useRef(true);
  const verified = useRef(false);
  const submitting = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = async () =>
    mounted.current &&
    (!optionsRef.current.isCurrent || (await optionsRef.current.isCurrent())) &&
    mounted.current;
  const mfaRecent = access?.mfaRecent ?? false;
  const [step, setStep] = useState<MfaStep>({ kind: "checking" });
  const [code, setCode] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSecretVisible, setIsSecretVisible] = useState(false);
  const [didVerify, setDidVerify] = useState(false);

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

    if (verified.current && options.explicit) return;
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
    } else if (mfaRecent && !options.explicit) {
      setStep({ kind: "verified" });
    } else {
      void loadFactors(isCurrent);
    }

    return () => {
      cancelled = true;
    };
  }, [accessStatus, mfaRecent, loadFactors, options.explicit]);

  async function startEnrollment(abandonedFactorId: string | null) {
    if (!supabase || submitting.current) return;
    submitting.current = true;
    setFormError(null);
    setIsSubmitting(true);
    try {
      if (!(await current())) return;
      if (abandonedFactorId) {
        // Limpieza de UN enrolamiento TOTP anterior interrumpido (unverified, detectado
        // en loadFactors vía factorsData.all) como parte de ESTA misma acción explícita
        // del usuario — nunca automática, nunca repetida en bucle: como mucho un
        // unenroll seguido de un enroll por cada clic. Si la limpieza falla, se detiene
        // aquí sin intentar el enroll (que volvería a fallar por la misma razón).
        const { error: cleanupError } = await supabase.auth.mfa.unenroll({
          factorId: abandonedFactorId,
        });
        if (!(await current())) return;
        if (cleanupError) {
          setFormError(
            "No se pudo limpiar un enrolamiento anterior incompleto. Inténtalo de nuevo.",
          );
          return;
        }
      }

      const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
      if (!(await current())) return;
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
      if (mounted.current) setFormError(UNEXPECTED_ERROR);
    } finally {
      submitting.current = false;
      if (mounted.current) setIsSubmitting(false);
    }
  }

  async function cancelEnrollment(factorId: string) {
    setIsSubmitting(true);
    try {
      if (supabase && (await current())) {
        // Best-effort: el factor todavía no está verificado (nadie depende de él), así
        // que un fallo aquí no debe bloquear la cancelación ni mostrarse como error.
        // NUNCA se elimina un factor ya verificado por esta vía.
        await supabase.auth.mfa.unenroll({ factorId });
      }
    } catch {
      // Limpieza best-effort: se ignora deliberadamente.
    } finally {
      if (mounted.current) {
        setCode("");
        setFormError(null);
        submitting.current = false;
        if (mounted.current) setIsSubmitting(false);
        // El factor que se acaba de cancelar/unenroll ya no existe: no hay ningún
        // enrolamiento abandonado pendiente de limpiar.
        setStep({ kind: "need-factor", abandonedFactorId: null });
      }
    }
  }

  async function submitCode(event: FormEvent, factorId: string) {
    event.preventDefault();
    if (!supabase || submitting.current) return;
    submitting.current = true;
    setFormError(null);
    setIsSubmitting(true);
    try {
      if (!(await current())) {
        if (mounted.current) setStep({ kind: "session-invalid" });
        return;
      }
      // Un challenge nuevo por intento: nunca se reutiliza un challengeId de un envío
      // anterior, y siempre pertenece al factor que se está verificando.
      const { data: challengeData, error: challengeError } =
        await supabase.auth.mfa.challenge({ factorId });
      if (challengeError) {
        setFormError("No se pudo iniciar la verificación. Inténtalo de nuevo.");
        return;
      }

      if (!(await current())) {
        if (mounted.current) setStep({ kind: "session-invalid" });
        return;
      }
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challengeData.id,
        code,
      });
      if (!(await current())) return;
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
      if (!(await current())) {
        if (mounted.current) setStep({ kind: "session-invalid" });
        return;
      }
      if (
        refreshed?.mfaRecent &&
        (!options.explicit || refreshed.capabilities.includes("cosplay_admin"))
      ) {
        verified.current = true;
        setDidVerify(true);
        setStep({ kind: "verified" });
      } else {
        setFormError("No se pudo confirmar la verificación. Inténtalo de nuevo.");
      }
    } catch {
      if (mounted.current) setFormError(UNEXPECTED_ERROR);
    } finally {
      submitting.current = false;
      if (mounted.current) setIsSubmitting(false);
    }
  }

  return {
    step,
    didVerify,
    code,
    setCode,
    formError,
    invalidCode: formError === "Código incorrecto o expirado.",
    isSubmitting,
    isSecretVisible,
    setIsSecretVisible,
    startEnrollment,
    cancelEnrollment,
    submitCode,
  };
}
