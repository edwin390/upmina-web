// Prueba CONTROLADA (solo DEV, operator-side) de qué exige Supabase Auth para cambiar la contraseña desde una sesión de
// recuperación de una cuenta NO privilegiada con MFA verificado. Lógica pura + llamadas HTTP con fetch inyectable.
//
// Reglas (ver docs/9K-PASSWORD-RECOVERY-AND-REMINDERS.md §5):
//   * Nada de esto se ejecuta en tests, build ni dev: solo lo lanza una persona a mano (scripts/dev-password-reset-aal-check.mjs).
//   * Solo DEV: la URL de Supabase debe ser la del proyecto DEV; cualquier otra se rechaza.
//   * NUNCA se imprime ni se guarda: tokens, enlaces, códigos TOTP, contraseñas, correos ni ids. La salida son solo
//     códigos HTTP, códigos de error de Auth y conclusiones.
//   * Solo cuentas SIN rol privilegiado: se comprueba contra /api/admin/access y se aborta si hay rol.

export const DEV_PROJECT_REF = "rkqeqbqwdswhpzwqptac";
export const CONFIRM_VALUE = "DEV_ONLY";

export class CheckError extends Error {}

export function assertDevSupabaseUrl(url) {
  let host;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("protocol");
    host = parsed.hostname;
  } catch {
    throw new CheckError("VITE_SUPABASE_URL no es una URL https válida");
  }
  if (host !== `${DEV_PROJECT_REF}.supabase.co`) {
    throw new CheckError("La URL de Supabase no es la del proyecto DEV: se aborta");
  }
  return url.replace(/\/+$/, "");
}

/** access_token del enlace pegado (URL completa con #access_token=… o solo el fragmento). type debe ser recovery. */
export function parseRecoveryLink(input) {
  const text = String(input ?? "").trim();
  const hash = text.includes("#")
    ? text.slice(text.indexOf("#") + 1)
    : text.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const token = params.get("access_token");
  if (!token || params.get("type") !== "recovery") {
    throw new CheckError(
      "El enlace pegado no contiene una sesión de recuperación (#access_token=…&type=recovery)",
    );
  }
  return token;
}

/** Solo claims NO identificativos: aal y métodos de autenticación. */
export function describeJwt(token) {
  try {
    const part = token.split(".")[1];
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
    const amr = Array.isArray(payload.amr)
      ? payload.amr.map((a) => (a && typeof a.method === "string" ? a.method : "?"))
      : [];
    return { aal: typeof payload.aal === "string" ? payload.aal : "?", amr };
  } catch {
    throw new CheckError("El token no se pudo interpretar");
  }
}

/** Clasifica la respuesta de PUT /auth/v1/user. No devuelve el cuerpo ni mensajes del proveedor. */
export function classifyUpdate(status, body) {
  const code = typeof body?.error_code === "string" ? body.error_code : null;
  if (status >= 200 && status < 300) {
    return {
      verdict: "ALLOWED_AAL1",
      text: "Supabase PERMITIÓ cambiar la contraseña con una sesión de recuperación aal1 SIN TOTP (el paso TOTP del cliente no es una garantía del servidor).",
    };
  }
  if (code === "insufficient_aal") {
    return {
      verdict: "REQUIRES_AAL2",
      text: "Supabase EXIGE aal2 (TOTP) para cambiar la contraseña de una cuenta con MFA: el paso TOTP está respaldado por el servidor.",
    };
  }
  if (code && /reauthentication/.test(code)) {
    return {
      verdict: "REQUIRES_REAUTH",
      text: "«Secure password change» exige una reautenticación (nonce) para este cambio.",
    };
  }
  if (code && /current.?password/.test(code)) {
    return {
      verdict: "REQUIRES_CURRENT_PASSWORD",
      text: "«Require current password» está activo: el flujo de restablecimiento no puede aportar la contraseña actual.",
    };
  }
  if (code === "same_password" || code === "weak_password") {
    return {
      verdict: "POLICY",
      text: `La política de contraseñas rechazó el valor (${code}).`,
    };
  }
  return {
    verdict: "OTHER",
    text: `Respuesta no clasificada (HTTP ${status}${code ? `, ${code}` : ""}).`,
  };
}

/** Contraseña aleatoria desechable (cumple cualquier política razonable); no se imprime ni se guarda. */
export function throwawayPassword(randomBytes) {
  return `Tmp-${randomBytes(18).toString("base64url")}-9aZ!`;
}

async function json(response) {
  return response.json().catch(() => null);
}

/** Único origen de la aplicación contra el que se comprueba el rol (el alias DEV). */
export const DEV_APP_URL = "https://upmina-testing-backend.vercel.app";

export function assertDevAppUrl(url) {
  if (String(url ?? "").replace(/\/+$/, "") !== DEV_APP_URL) {
    throw new CheckError("La URL de la aplicación no es el alias DEV: se aborta");
  }
  return DEV_APP_URL;
}

/**
 * ¿El SERVIDOR confirma, sin ambigüedad, que la cuenta autenticada no tiene rol administrativo? Solo cuenta una
 * respuesta 200 de /api/admin/access (que verifica el JWT criptográficamente en el servidor y consulta admin_roles)
 * con `role` exactamente null, sin capacidades y con `mfa.recent === false` (coherente con una sesión aal1).
 * Cualquier otra cosa —401, 403, 5xx, cuerpo ausente o malformado, rol ausente, un rol, capacidades— NO es
 * concluyente y aborta. Lo que dice el cliente (claims del token) nunca prueba la falta de privilegios.
 */
export function assertServerConfirmsNoRole(status, body) {
  const conclusive =
    status === 200 &&
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.hasOwn(body, "role") &&
    body.role === null &&
    Array.isArray(body.capabilities) &&
    body.capabilities.length === 0 &&
    body.mfa !== null &&
    typeof body.mfa === "object" &&
    body.mfa.recent === false;
  if (conclusive) return;
  if (status === 200 && body && typeof body === "object" && body.role) {
    throw new CheckError(
      "La cuenta TIENE un rol privilegiado: esta prueba es solo para cuentas ordinarias. Se aborta",
    );
  }
  throw new CheckError(
    `El servidor no confirmó de forma inequívoca que la cuenta carece de rol (HTTP ${status}). Se aborta por precaución`,
  );
}

/** fetch que nunca deja escapar detalles del error de red (podrían contener URLs o cabeceras). */
async function call(fetchImpl, url, init, what) {
  try {
    return await fetchImpl(url, init);
  } catch {
    throw new CheckError(`Error de red en ${what}. Se aborta`);
  }
}

/**
 * Ejecuta la prueba. `io` = { fetchImpl, supabaseUrl, anonKey, appUrl, confirm, askHidden, log, randomBytes }.
 * `mode`: "no-totp" (sin completar el TOTP: la prueba decisiva) o "with-totp" (completa el TOTP y confirma que el
 * flujo seguro funciona).
 *
 * Orden: primero TODOS los controles (modo, confirmación, URLs DEV, sesión aal1, rol, TOTP verificado); el único cambio
 * (PUT de la contraseña; y, en with-totp, challenge/verify) ocurre después y solo si todos pasaron.
 */
export async function runCheck(mode, io) {
  const {
    fetchImpl,
    supabaseUrl,
    anonKey,
    appUrl,
    confirm,
    askHidden,
    log,
    randomBytes,
  } = io;
  if (mode !== "no-totp" && mode !== "with-totp")
    throw new CheckError("Modo desconocido: se aborta");
  if (confirm !== CONFIRM_VALUE)
    throw new CheckError(`Falta la confirmación ${CONFIRM_VALUE}: se aborta`);
  assertDevSupabaseUrl(supabaseUrl);
  assertDevAppUrl(appUrl);
  if (!anonKey) throw new CheckError("Falta la clave anon");

  const link = await askHidden(
    "Pega la URL completa a la que te llevó el enlace de recuperación (no se mostrará): ",
  );
  let token = parseRecoveryLink(link);
  const auth = (extra = {}) => ({
    apikey: anonKey,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...extra,
  });

  const claims = describeJwt(token);
  log(
    `Sesión de recuperación: aal=${claims.aal} · métodos=${claims.amr.join(",") || "ninguno"}`,
  );
  if (claims.aal !== "aal1")
    throw new CheckError("La sesión no es aal1: no es una sesión de recuperación normal");

  // Cuenta NO privilegiada, confirmada por el servidor; y con MFA verificado.
  const access = await call(
    fetchImpl,
    `${appUrl}/api/admin/access`,
    { headers: auth() },
    "la comprobación de rol",
  );
  assertServerConfirmsNoRole(access.status, await json(access));
  log(`Comprobación de rol: HTTP ${access.status} · el servidor confirma que no hay rol`);

  const me = await call(
    fetchImpl,
    `${supabaseUrl}/auth/v1/user`,
    { headers: auth() },
    "la lectura de factores",
  );
  if (me.status !== 200)
    throw new CheckError(
      `No se pudieron leer los factores (HTTP ${me.status}). Se aborta`,
    );
  const user = await json(me);
  const factors = Array.isArray(user?.factors) ? user.factors : [];
  const verified = factors.filter(
    (f) => f?.status === "verified" && f?.factor_type === "totp",
  );
  log(`Factores TOTP verificados en la cuenta: ${verified.length}`);
  if (verified.length === 0)
    throw new CheckError(
      "La cuenta no tiene un TOTP verificado: la prueba no sería concluyente",
    );

  if (mode === "with-totp") {
    const code = (await askHidden("Código TOTP actual (no se mostrará): ")).trim();
    const challenge = await call(
      fetchImpl,
      `${supabaseUrl}/auth/v1/factors/${verified[0].id}/challenge`,
      {
        method: "POST",
        headers: auth(),
        body: "{}",
      },
      "el desafío TOTP",
    );
    const challengeBody = await json(challenge);
    if (!challenge.ok || typeof challengeBody?.id !== "string")
      throw new CheckError(`challenge falló (HTTP ${challenge.status})`);
    const verify = await call(
      fetchImpl,
      `${supabaseUrl}/auth/v1/factors/${verified[0].id}/verify`,
      {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ challenge_id: challengeBody.id, code }),
      },
      "la verificación TOTP",
    );
    const verifyBody = await json(verify);
    if (!verify.ok || typeof verifyBody?.access_token !== "string")
      throw new CheckError(`verify falló (HTTP ${verify.status})`);
    token = verifyBody.access_token;
    log(`Tras verificar el TOTP: ${JSON.stringify(describeJwt(token))}`);
  }

  const response = await call(
    fetchImpl,
    `${supabaseUrl}/auth/v1/user`,
    {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ password: throwawayPassword(randomBytes) }),
    },
    "el cambio de contraseña (resultado desconocido: la contraseña pudo cambiar)",
  );
  const result = classifyUpdate(response.status, await json(response));
  log(`PUT /auth/v1/user → HTTP ${response.status} · ${result.verdict}`);
  log(result.text);
  return { mode, status: response.status, ...result };
}
