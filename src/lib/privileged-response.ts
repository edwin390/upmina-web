// Clasificación de los rechazos de un request privilegiado (Fase 9G-3). Una sola semántica para
// todos los consumidores, en vez de que cada componente invente la suya:
//
//   401                            → "unauthenticated": la sesión ya no es válida.
//   403 + code "step_up_required"  → "step_up_required": la persona ESTÁ autorizada para la
//                                     operación, pero le falta MFA reciente → puede iniciar MFA.
//   403 (cualquier otro cuerpo)    → "forbidden": privilegios insuficientes o revocados → NUNCA
//                                     debe llevar a MFA (MFA no concede permisos).
//   cualquier otro status          → null (no es un rechazo de autorización).
//
// El cuerpo solo se lee en un 403 y únicamente para buscar el código EXACTO; cualquier fallo al
// leerlo cuenta como 403 genérico (fail closed hacia "sin MFA"). Este módulo no ejecuta nada:
// devuelve DATOS; qué hacer con ellos lo decide quien lo llama, y nunca se reintenta la petición.

export type PrivilegedFailure = "unauthenticated" | "step_up_required" | "forbidden";

export const STEP_UP_REQUIRED = "step_up_required";

interface ResponseLike {
  status: number;
  clone?: () => ResponseLike;
  json?: () => Promise<unknown>;
}

export async function classifyPrivilegedFailure(
  response: ResponseLike | null | undefined,
): Promise<PrivilegedFailure | null> {
  if (!response || typeof response.status !== "number") return null;
  if (response.status === 401) return "unauthenticated";
  if (response.status !== 403) return null;

  try {
    // Se lee una copia si existe: quien llamó puede necesitar el cuerpo original.
    const source = typeof response.clone === "function" ? response.clone() : response;
    if (typeof source.json !== "function") return "forbidden";
    const body: unknown = await source.json();
    const code =
      body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
    return code === STEP_UP_REQUIRED ? "step_up_required" : "forbidden";
  } catch {
    return "forbidden";
  }
}
