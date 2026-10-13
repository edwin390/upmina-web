// Cliente de «Olvidé mi contraseña» con comprobación del correo (lote 3P-R). Habla SOLO con el endpoint propio
// POST /api/profile?action=password-recovery (src/lib/password-recovery-handlers.ts); nunca con tablas ni con claves
// privilegiadas. El resultado se reduce a un conjunto cerrado: cualquier respuesta inesperada es "error" y JAMÁS se
// interpreta como «correo inexistente».

// El servidor NO envía la recuperación: solo comprueba y limita. Con «confirmed» es el navegador quien llama a
// supabase.auth.resetPasswordForEmail (la IP de cada persona cuenta en los límites por IP de Supabase Auth, en vez de
// compartir el cupo de la IP de salida de Vercel; ver password-recovery-handlers.ts).

export type RecoveryOutcome =
  | { kind: "confirmed" }
  | { kind: "unconfirmed" }
  | { kind: "unregistered" }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "error" };

const ENDPOINT = "/api/profile?action=password-recovery";
const MAX_EMAIL = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Integración CONTROLADA: la comprobación del correo solo se usa si el build lo activa explícitamente
 * (VITE_PASSWORD_RECOVERY_LOOKUP=1). Mientras no esté aplicada la migración 20261105120000 en el entorno ni desplegado el
 * endpoint, el interruptor está apagado y /forgot-password conserva EXACTAMENTE el flujo neutro anterior.
 */
export function passwordRecoveryLookupEnabled(): boolean {
  return import.meta.env.VITE_PASSWORD_RECOVERY_LOOKUP === "1";
}

export async function requestPasswordRecovery(
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RecoveryOutcome> {
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      credentials: "omit",
      body: JSON.stringify({ email }),
    });
    const body = (await response.json().catch(() => null)) as {
      status?: unknown;
      retryAfterSeconds?: unknown;
    } | null;
    if (response.status === 429 && body?.status === "rate_limited") {
      const raw = Number(body.retryAfterSeconds);
      const seconds = Number.isFinite(raw)
        ? Math.min(3600, Math.max(1, Math.ceil(raw)))
        : 60;
      return { kind: "rate_limited", retryAfterSeconds: seconds };
    }
    if (response.status === 200) {
      if (body?.status === "confirmed") return { kind: "confirmed" };
      if (body?.status === "unconfirmed") return { kind: "unconfirmed" };
      if (body?.status === "unregistered") return { kind: "unregistered" };
    }
    return { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

/**
 * Correo precargado en /signup desde el ESTADO del router (location.state), nunca desde la URL: así no queda en el
 * historial, en logs ni en cabeceras Referer. Solo rellena el campo (no envía nada) y se descarta si no es un correo
 * con forma válida.
 */
export function prefilledEmailFromState(state: unknown): string {
  if (typeof state !== "object" || state === null) return "";
  const value = (state as { email?: unknown }).email;
  if (typeof value !== "string") return "";
  const email = value.trim();
  if (email.length === 0 || email.length > MAX_EMAIL || CONTROL_CHARS.test(email))
    return "";
  return EMAIL_SHAPE.test(email) ? email : "";
}
