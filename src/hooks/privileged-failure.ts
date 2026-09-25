import { createContext, useCallback, useContext } from "react";
import {
  classifyPrivilegedFailure,
  type PrivilegedFailure,
} from "@/lib/privileged-response";

// Canal común para que las secciones privilegiadas (Equipo, Invitaciones, Conexiones sociales)
// informen al contenedor de un rechazo de autorización con UNA semántica compartida
// (ver privileged-response.ts). El contenedor (/admin) decide qué hacer: invalidar el acceso y,
// según el resultado del servidor, retirar la UI (403 genérico) o iniciar MFA (step_up_required).
//
// Fuera de un proveedor el manejador es un no-op: una sección usada sola conserva su
// comportamiento anterior. El reporte es informativo: no reintenta ni reproduce la petición, y
// nunca serializa cuerpos ni callbacks para ejecutarlos después de un MFA.

type FailureHandler = (failure: PrivilegedFailure) => void;

const noop: FailureHandler = () => undefined;

export const PrivilegedFailureContext = createContext<FailureHandler>(noop);

/** Devuelve `report(response)`: clasifica el rechazo y lo comunica al contenedor. */
export function usePrivilegedFailureReporter(): (
  response: Parameters<typeof classifyPrivilegedFailure>[0],
) => void {
  const handler = useContext(PrivilegedFailureContext);
  return useCallback(
    (response) => {
      void classifyPrivilegedFailure(response).then((failure) => {
        if (failure) handler(failure);
      });
    },
    [handler],
  );
}
