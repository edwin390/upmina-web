// AUTH-1: interpretación del retorno de un enlace de confirmación de correo de Supabase.
//
// Supabase redirige a la URL de retorno con el RESULTADO en el fragmento (#...):
//  - éxito:   #access_token=...&type=signup (supabase-js crea la sesión por su cuenta);
//  - fallo:   #error=access_denied&error_code=otp_expired&error_description=... (enlace caducado,
//             ya usado o inválido).
// Solo se clasifica el tipo de fallo; `error_description` y cualquier otro valor del fragmento NO se
// muestran ni se registran, y los tokens nunca salen de aquí.

export type AuthLinkError = "expired" | "invalid";

function params(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
}

/** Fallo del enlace de confirmación, o null si el fragmento no describe ninguno. */
export function parseAuthLinkError(hash: string): AuthLinkError | null {
  if (!hash) return null;
  const p = params(hash);
  const code = p.get("error_code");
  const error = p.get("error");
  if (!code && !error) return null;
  return code === "otp_expired" ? "expired" : "invalid";
}

/** true si el fragmento trae la sesión de un enlace de confirmación correcto. */
export function isAuthLinkSuccess(hash: string): boolean {
  if (!hash) return false;
  const p = params(hash);
  return p.has("access_token") && p.get("type") === "signup";
}

/** URL de retorno de los correos de confirmación: siempre /login del mismo origen. Si el origen no
 *  está en la lista de redirecciones permitidas de Supabase, éste usa su Site URL (sin riesgo). */
export function confirmationRedirectUrl(): string | undefined {
  return typeof window === "undefined" ? undefined : `${window.location.origin}/login`;
}
