import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { AdminAccessError, fetchAdminAccess, type AdminAccess } from "@/lib/admin-access";

// Acceso actual de la sesión para PRESENTACIÓN (Fase 9G-3), vía GET /api/admin/access.
// Autorización != UI: este hook nunca autoriza nada; el backend valida cada operación.
//
// Caché de TanStack Query, no autoridad:
//   - la clave incluye el user.id: un usuario nunca ve el estado de otro;
//   - sin sesión no se consulta y no se expone ningún dato en caché;
//   - al cambiar el usuario o cerrar sesión se eliminan las entradas de otros usuarios;
//   - staleTime corto y refetch al recuperar el foco (una revocación o un MFA hecho en otra
//     pestaña se recogen al volver); gcTime bajo para no retener el estado de una cuenta;
//   - tras un rechazo privilegiado se invalida explícitamente (ver Dashboard).
// Nada se guarda en localStorage/sessionStorage.

export const ADMIN_ACCESS_QUERY_ROOT = "admin-access";

export function adminAccessQueryKey(userId: string | null) {
  return [ADMIN_ACCESS_QUERY_ROOT, userId] as const;
}

const STALE_MS = 15_000;
const GC_MS = 60_000;

export type AdminAccessStatus =
  | "loading" // resolviendo sesión o acceso: no se muestra nada privilegiado
  | "no-session" // no hay sesión local
  | "unauthenticated" // hay sesión local pero el servidor la rechazó (401)
  | "error" // no se pudo comprobar (red / 5xx / respuesta inválida): fail closed
  | "ready";

export interface UseAdminAccessResult {
  status: AdminAccessStatus;
  /** Solo presente con status "ready". */
  access: AdminAccess | null;
  /** Vuelve a pedir el acceso al servidor y devuelve el resultado, o null si falló. */
  refetch: () => Promise<AdminAccess | null>;
  /** Marca el acceso como obsoleto y lo recarga (tras un 403/step-up de un request privilegiado). */
  invalidate: () => Promise<void>;
}

interface Options {
  /** Recomprueba en cada montaje (Dashboard/MFA: decisiones de acceso), no solo si está obsoleto. */
  fresh?: boolean;
}

export function useAdminAccess(options: Options = {}): UseAdminAccessResult {
  const { session, user, loading } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  const hasSession = Boolean(session) && userId !== null;

  // Limpieza entre usuarios/logout: se descartan las entradas de cualquier otro user.id.
  useEffect(() => {
    queryClient.removeQueries({
      queryKey: [ADMIN_ACCESS_QUERY_ROOT],
      predicate: (query) => query.queryKey[1] !== userId,
    });
  }, [queryClient, userId]);

  const query = useQuery<AdminAccess, AdminAccessError>({
    queryKey: adminAccessQueryKey(userId),
    queryFn: ({ signal }) => fetchAdminAccess(signal, userId),
    enabled: !loading && hasSession,
    staleTime: STALE_MS,
    gcTime: GC_MS,
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnMount: options.fresh ? "always" : true,
  });

  const { refetch: queryRefetch } = query;

  // Estables entre renders: los consumidores los usan como dependencia de efectos.
  const refetch = useCallback(async (): Promise<AdminAccess | null> => {
    const result = await queryRefetch({ cancelRefetch: true });
    return result.data ?? null;
  }, [queryRefetch]);

  const invalidate = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: adminAccessQueryKey(userId) });
  }, [queryClient, userId]);

  let status: AdminAccessStatus;
  if (loading) status = "loading";
  else if (!hasSession) status = "no-session";
  else if (query.data && !query.isError) status = "ready";
  else if (query.isError) {
    status =
      query.error instanceof AdminAccessError && query.error.kind === "unauthenticated"
        ? "unauthenticated"
        : "error";
  } else status = "loading";

  return {
    status,
    access: status === "ready" ? (query.data ?? null) : null,
    refetch,
    invalidate,
  };
}
