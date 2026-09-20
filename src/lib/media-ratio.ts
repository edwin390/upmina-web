// Meta no da width/height de los media de Instagram, así que la proporción se lee del
// recurso real cuando el navegador lo carga (naturalWidth/naturalHeight o
// videoWidth/videoHeight). Nada se inventa: hasta entonces se usa 1:1.

/** Instagram muestra de 9:16 (Reels) a 1,91:1 (horizontal); fuera de eso se ajusta con barras. */
export const MIN_ASPECT_RATIO = 9 / 16;
export const MAX_ASPECT_RATIO = 1.91;

/** Proporción ancho/alto acotada al rango de Instagram, o `null` si no hay dimensiones válidas. */
export function clampAspectRatio(width: number, height: number): number | null {
  if (!(width > 0) || !(height > 0)) return null;
  return Math.min(MAX_ASPECT_RATIO, Math.max(MIN_ASPECT_RATIO, width / height));
}

// Proporciones ya conocidas por id de media (p. ej. de la miniatura de la grid), para
// que el modal se abra con el tamaño correcto sin esperar a cargar la imagen.
const knownRatios = new Map<string, number>();

export function rememberAspectRatio(id: string, width: number, height: number): void {
  const ratio = clampAspectRatio(width, height);
  if (ratio !== null) knownRatios.set(id, ratio);
}

export function getKnownAspectRatio(id: string): number | undefined {
  return knownRatios.get(id);
}

/** Índice vecino con navegación circular: el último → el primero y viceversa. */
export function wrapIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}
