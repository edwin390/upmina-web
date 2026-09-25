// Destino tras una activación de invitación exitosa (Fase 9G-2). Función pura y reutilizable;
// todavía no está conectada a AdminActivatePage (9G-4).
//
//   admin     → /admin
//   moderator → /account   (todavía no hay panel de moderación)
//   developer → /account   (defensivo: hoy NO es un rol invitable —el CHECK de admin_invitations y
//                           el handler de activación solo admiten admin/moderator—; este mapeo no
//                           cambia esa regla)
//   cualquier otro valor → /account (la superficie de menor privilegio; nunca /admin por defecto)
//
// El destino no concede nada: /admin sigue protegido por el backend (rol ACTUAL + MFA reciente).

export type ActivationDestination = "/admin" | "/account";

export function resolveActivationDestination(role: unknown): ActivationDestination {
  return role === "admin" ? "/admin" : "/account";
}
