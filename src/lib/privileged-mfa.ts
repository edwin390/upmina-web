// MFA reciente para operaciones privilegiadas (Fase 9G-1). Funciones PURAS y sin estado:
// SOLO servidor en la práctica (se aplican a claims ya verificadas por getClaims), pero sin
// dependencias de Node ni de Supabase para poder probarlas con un reloj inyectado.
//
// Por qué AMR y no `aal` solo: `aal` es una propiedad de la SESIÓN. Una vez que la sesión pasó
// MFA, todos sus JWT (incluidos los refrescados) dicen `aal2` hasta que la sesión termina, así
// que `aal2` significa "esta sesión pasó MFA alguna vez", no "MFA reciente". El claim `amr`
// del JWT sí lleva la marca de tiempo del último factor verificado ({ method, timestamp } en
// segundos UNIX). Probado empíricamente en el proyecto desechable (probe 9G-1):
//   - un challenge+verify TOTP sobre una sesión que YA es aal2 actualiza el timestamp `totp`;
//   - refrescar el access token CONSERVA el timestamp `totp` del último verify;
//   - un login nuevo genera una sesión con solo `password` en `amr` (no hereda MFA).
//
// La marca sale exclusivamente del JWT verificado criptográficamente: nunca de body, query,
// headers propios ni de nada que controle el navegador.
//
// Fail closed: cualquier `amr` ausente, malformado, sin timestamp o con un timestamp inválido
// equivale a "sin MFA reciente".

/** Ventana de MFA reciente para operaciones privilegiadas. ÚNICA definición de la constante. */
export const PRIVILEGED_MFA_WINDOW_SECONDS = 1800;

/** Tolerancia explícita a un reloj del emisor ligeramente adelantado respecto al servidor. */
export const PRIVILEGED_MFA_CLOCK_SKEW_SECONDS = 60;

/** Métodos AMR que representan un TOTP verificado. "totp" es el observado en Supabase Auth;
 *  "mfa/totp" se acepta defensivamente porque el SDK lo enumera entre los métodos AMR. */
const TOTP_AMR_METHODS: ReadonlySet<string> = new Set(["totp", "mfa/totp"]);

/** Segundos UNIX actuales. Los llamadores que necesiten un reloj controlado lo inyectan. */
export function currentEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Mayor timestamp de las entradas AMR de TOTP con forma válida (número finito y positivo), o
 * null si no hay ninguna. Ignora por completo entradas sin timestamp numérico (p. ej. el formato
 * RFC 8176 `string[]`), de otro método o malformadas; nunca lanza.
 */
export function getLatestTotpTimestamp(amr: unknown): number | null {
  if (!Array.isArray(amr)) return null;
  let latest: number | null = null;
  for (const entry of amr) {
    if (!entry || typeof entry !== "object") continue;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    if (typeof method !== "string" || !TOTP_AMR_METHODS.has(method)) continue;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
      continue;
    }
    if (latest === null || timestamp > latest) latest = timestamp;
  }
  return latest;
}

/**
 * ¿La verificación TOTP de `mfaVerifiedAt` es reciente y la sesión es aal2? Reglas, todas
 * obligatorias:
 *   - `aal === "aal2"`;
 *   - `mfaVerifiedAt` es un número finito;
 *   - `nowSeconds - mfaVerifiedAt <= windowSeconds` (el límite exacto cuenta como reciente);
 *   - `mfaVerifiedAt <= nowSeconds + clock skew` (un timestamp muy futuro es una anomalía: falla).
 * Una ventana o un reloj no finitos también fallan cerrado.
 */
export function isMfaRecent(
  aal: unknown,
  mfaVerifiedAt: number | null | undefined,
  nowSeconds: number = currentEpochSeconds(),
  windowSeconds: number = PRIVILEGED_MFA_WINDOW_SECONDS,
): boolean {
  if (aal !== "aal2") return false;
  if (typeof mfaVerifiedAt !== "number" || !Number.isFinite(mfaVerifiedAt)) return false;
  if (!Number.isFinite(nowSeconds)) return false;
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return false;
  if (mfaVerifiedAt > nowSeconds + PRIVILEGED_MFA_CLOCK_SKEW_SECONDS) return false;
  return nowSeconds - mfaVerifiedAt <= windowSeconds;
}

/** MFA reciente a partir de las claims verificadas del JWT (`aal` + `amr`). */
export function hasRecentMfa(
  claims: { aal?: unknown; amr?: unknown } | null | undefined,
  nowSeconds: number = currentEpochSeconds(),
  windowSeconds: number = PRIVILEGED_MFA_WINDOW_SECONDS,
): boolean {
  if (!claims || typeof claims !== "object") return false;
  return isMfaRecent(
    claims.aal,
    getLatestTotpTimestamp(claims.amr),
    nowSeconds,
    windowSeconds,
  );
}
