import type { ReactNode } from "react";
import { useAdminAccess } from "@/hooks/useAdminAccess";
import type { AdminCapability, AdminRole } from "@/lib/admin-access";

// Presentación condicionada al acceso que informa el servidor (Fase 9G-3). NO es autorización ni
// una frontera de seguridad: ocultar un control no impide llamar al endpoint, que valida siempre
// rol actual → capacidad → MFA reciente. Falla cerrado: mientras el acceso carga, falla o no
// coincide, NO renderiza nada (ni placeholders ni botones deshabilitados).

interface Props {
  /** Rol exacto requerido. */
  role?: AdminRole;
  /** Capacidad requerida (además del rol, si se indica). */
  capability?: AdminCapability;
  children: ReactNode;
}

export default function PrivilegedOnly({ role, capability, children }: Props) {
  const { status, access } = useAdminAccess();

  if (status !== "ready" || !access || access.role === null) return null;
  if (role !== undefined && access.role !== role) return null;
  if (capability !== undefined && !access.capabilities.includes(capability)) return null;
  // Sin ningún requisito explícito no se muestra nada: evita usarlo como "cualquier privilegiado".
  if (role === undefined && capability === undefined) return null;

  return <>{children}</>;
}
