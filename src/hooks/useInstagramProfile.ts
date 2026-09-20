import { useQuery } from "@tanstack/react-query";
import type { InstagramProfile } from "@/types";
import { isDemoMode } from "@/lib/runtime";

async function fetchInstagramProfile(): Promise<InstagramProfile> {
  if (isDemoMode) return {};

  const res = await fetch("/api/instagram-profile");
  if (!res.ok) throw new Error("No se pudo obtener el perfil de Instagram");
  return res.json();
}

/**
 * Perfil de la cuenta (foto + username). Misma queryKey en la sección y en el modal:
 * TanStack Query lo deduplica, así que hay UNA petición por sesión (staleTime 1 h,
 * acorde al caché del edge), no una por publicación. Si falla, la UI usa el fallback.
 */
export function useInstagramProfile() {
  return useQuery({
    queryKey: ["instagram", "profile"],
    queryFn: fetchInstagramProfile,
    staleTime: 60 * 60_000,
    retry: 1,
  });
}
