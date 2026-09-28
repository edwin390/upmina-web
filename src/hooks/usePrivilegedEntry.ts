import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminAccess } from "@/hooks/useAdminAccess";

// Entrada a una superficie de autoría privilegiada (Fase 9G/9I — endurecimiento global). Antes de
// abrir el editor/panel (p. ej. "Nueva publicación"/"Editar" de Cosplay), se revalida MFA reciente
// con el SERVIDOR justo en el momento del clic (nunca un valor cacheado potencialmente obsoleto).
// Evita que el ADMIN empiece a editar/subir fotos para recién entonces descubrir, a mitad de
// camino, que hacía falta MFA (bug real observado: una subida fallaba con "No autorizado" en vez
// de enrutar a step-up). Deliberadamente genérico (no conoce Cosplay ni ningún otro dominio) para
// que una futura superficie privilegiada lo reutilice sin reinventar esta navegación.
//
// Esto es SOLO UX, nunca autorización:
//   - la capacidad ya se comprobó antes de mostrar el control que llama a `enter` (normalmente un
//     PrivilegedOnly) — este hook no vuelve a comprobar capacidad, solo MFA reciente;
//   - cada mutación posterior sigue revalidando rol → capacidad → MFA reciente en el servidor por
//     su cuenta (ver useCosplayEditor): si el MFA vence DESPUÉS de entrar, esta gate de entrada no
//     ayuda y es esa revalidación mid-session la que enruta a MFA;
//   - un fallo al comprobar el acceso (red, sesión inválida) se trata igual que "sin MFA reciente"
//     (fail closed hacia pedir MFA) en vez de abrir la superficie a ciegas; /admin/mfa vuelve a
//     comprobar todo por sí mismo y no exige ningún rol concreto para enrolar/verificar TOTP.
export function usePrivilegedEntry() {
  const navigate = useNavigate();
  const { refetch } = useAdminAccess();

  const enter = useCallback(
    async (returnTo: string, onReady: () => void) => {
      const access = await refetch();
      if (access?.mfaRecent) {
        onReady();
        return;
      }
      navigate(`/admin/mfa?returnTo=${encodeURIComponent(returnTo)}`);
    },
    [refetch, navigate],
  );

  return { enter };
}
