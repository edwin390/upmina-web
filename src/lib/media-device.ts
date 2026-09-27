// Selección de concurrencia por dispositivo (Fase 9I-2C fix): puntero grueso (táctil) combinado
// con un viewport estrecho es la señal estándar de "dispositivo móvil" sin depender del string de
// user-agent (falsificable, y el propio checkpoint pide evitarlo si es razonablemente posible).
// Deliberadamente conservador: una tablet grande con puntero grueso pero viewport ancho sigue
// clasificándose como no-móvil, que es el lado seguro (más paralelismo, no menos).
export function isMobileUploadDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return false;
  return window.matchMedia("(pointer: coarse) and (max-width: 767px)").matches;
}
