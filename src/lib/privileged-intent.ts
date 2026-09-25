// Intención privilegiada (Fase 9G-2). Es SOLO DATOS: un valor cerrado que un futuro flujo de
// step-up puede transportar para saber qué UI REABRIR al volver (p. ej. el diálogo de "Eliminar"
// tras completar el MFA).
//
// Una intención NO es autorización y NO ejecuta nada:
//   - no concede permisos: cada mutación vuelve a exigir en el servidor rol ACTUAL → capacidad →
//     MFA reciente (ver admin-auth.ts), sin mirar la intención;
//   - no ejecuta mutaciones: este módulo no contiene callbacks, fetch ni efectos de ningún tipo;
//     parsear "delete" es exactamente igual de inerte que parsear "create";
//   - no se salta el MFA ni la confirmación: una intención "delete" solo puede reabrir una
//     confirmación que la persona debe aceptar de nuevo.
// Una intención manipulada (URL editada a mano) solo puede abrir un diálogo que el backend
// rechazará si la persona no está autorizada.

export const PRIVILEGED_INTENTS = ["create", "edit", "delete"] as const;

export type PrivilegedIntent = (typeof PRIVILEGED_INTENTS)[number];

/**
 * Valor de intención reconocido, o null. Coincidencia EXACTA y sensible a mayúsculas: "Create",
 * " create", "create " o "" no son intenciones válidas (fail closed, sin normalizar). Cualquier
 * cosa que no sea un string devuelve null.
 */
export function parsePrivilegedIntent(raw: unknown): PrivilegedIntent | null {
  if (typeof raw !== "string") return null;
  return (PRIVILEGED_INTENTS as readonly string[]).includes(raw)
    ? (raw as PrivilegedIntent)
    : null;
}
