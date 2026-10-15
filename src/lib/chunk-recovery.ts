// Recuperación de chunks obsoletos tras un despliegue: el HTML antiguo pide un archivo con hash que ya no existe.
// React.lazy memoriza el rechazo, así que la única recuperación real es recargar; se hace UNA sola vez por
// ventana de tiempo para no entrar en bucle si el fallo es persistente.
const KEY = "upmina:chunk-reload-at";
const WINDOW_MS = 60_000;

const CHUNK_ERROR =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError/i;

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  return CHUNK_ERROR.test(message);
}

/** Devuelve true si inició la recarga (no hubo otra en el último minuto). */
export function reloadOnceForStaleChunk(): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < WINDOW_MS) return false;
    window.sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
