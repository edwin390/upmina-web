import { supabase } from "@/lib/supabase";

// Reverificación del TOTP dentro de la propia página (Developer Panel V1). Aprobar o rechazar una
// recuperación excepcional exige que el último TOTP de la sesión sea de hace ≤ 5 minutos (el servidor
// lo mide con el timestamp `amr` del JWT verificado). /admin/mfa NO sirve para esto: si el MFA general
// (30 min) sigue vigente, esa página no pide el código. Aquí se hace challenge + verify sobre el factor
// TOTP verificado de la sesión actual; Supabase emite un token nuevo con un `amr` reciente.
//
// No autoriza nada: solo renueva la prueba; el servidor vuelve a comprobar rol, capacidad y recencia en
// cada operación. El código nunca se guarda, se registra ni se envía a nuestros endpoints.

export type ReverifyResult =
  "ok" | "invalid_format" | "no_factor" | "invalid_code" | "failed";

const CODE_SHAPE = /^\d{6}$/;
// Códigos estables de la API (no se inspecciona el texto del proveedor).
const INVALID_OR_EXPIRED_CODES = new Set([
  "mfa_verification_failed",
  "mfa_challenge_expired",
  "mfa_verification_rejected",
]);

export async function reverifyTotp(code: string): Promise<ReverifyResult> {
  const trimmed = code.trim();
  if (!CODE_SHAPE.test(trimmed)) return "invalid_format";
  if (!supabase) return "failed";
  try {
    const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
    if (listError) return "failed";
    // `totp` solo contiene factores ya VERIFICADOS (contrato de auth-js).
    const factor = factors?.totp?.[0];
    if (!factor) return "no_factor";
    // Un challenge nuevo por intento, siempre del factor que se verifica.
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId: factor.id,
    });
    if (challengeError || !challenge) return "failed";
    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: factor.id,
      challengeId: challenge.id,
      code: trimmed,
    });
    if (verifyError) {
      const errorCode = (verifyError as { code?: unknown }).code;
      return typeof errorCode === "string" && INVALID_OR_EXPIRED_CODES.has(errorCode)
        ? "invalid_code"
        : "failed";
    }
    return "ok";
  } catch {
    return "failed";
  }
}
