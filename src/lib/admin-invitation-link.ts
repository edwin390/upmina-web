const ACTIVATION_PATH_PREFIX = "/admin/activate#token=";

/**
 * activation_path (relativo, devuelto UNA vez por la creación de una invitación) + origin del
 * navegador → URL absoluta de activación, o null si no es exactamente `/admin/activate#token=...`
 * del mismo origen. Solo cliente: el servidor nunca conoce el origin ni el enlace absoluto.
 */
export function buildActivationUrl(activationPath: unknown): string | null {
  if (
    typeof activationPath !== "string" ||
    !activationPath.startsWith(ACTIVATION_PATH_PREFIX)
  ) {
    return null;
  }
  // El token es base64url; cualquier otro carácter (espacios, saltos de línea, ?, &, /) se
  // rechaza en lugar de dejar que `new URL` lo normalice a un enlace distinto del del servidor.
  if (!/^[A-Za-z0-9_-]+$/.test(activationPath.slice(ACTIVATION_PATH_PREFIX.length)))
    return null;
  try {
    const url = new URL(activationPath, window.location.origin);
    return url.origin === window.location.origin ? url.toString() : null;
  } catch {
    return null;
  }
}
