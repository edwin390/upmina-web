import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";

// Perfil PROPIO del usuario autenticado (Fase 9J-2B.1): fuente compartida de "¿tengo un
// @username configurado, y cuál es?" para Header (destino de "Perfil"), ProfilePage
// (derivar ownership de forma segura) y cualquier otro consumidor futuro. Mismo patrón de
// lectura que ya usaba ProfileSection.tsx (SELECT directo del navegador contra profiles,
// permitido por la policy pública profiles_select_public — nunca escribe nada aquí), ahora
// compartido vía TanStack Query en vez de duplicado como estado local en cada componente.
//
// Es SOLO PARA PRESENTACIÓN/NAVEGACIÓN, igual que useAdminAccess: nunca se usa como prueba de
// autorización. "¿Es esta MI publicación?" para una mutación sigue siendo decidido única y
// exclusivamente por el servidor (author_user_id bajo lock, ver community-post-handlers.ts) —
// este hook solo evita que la UI muestre controles de dueño a quien no lo es.
//
// supabase-js (~227 kB) se importa DINÁMICAMENTE, dentro de queryFn — nunca un `import`
// estático de "@/lib/supabase" arriba: Header.tsx llama a este hook en TODA ruta (no está
// lazy-loaded), así que un import estático habría metido supabase-js en el bundle crítico de
// Home (exactamente lo que auth-context.tsx ya evita a propósito, ver su comentario). Un import
// dinámico dentro de queryFn preserva esa exclusión: solo se descarga cuando la query realmente
// se ejecuta (con sesión), nunca en la carga inicial de un visitante.

export interface OwnProfile {
  username: string;
  displayName: string | null;
  bio: string | null;
}

export const OWN_PROFILE_QUERY_ROOT = "own-profile";

async function fetchOwnProfile(userId: string): Promise<OwnProfile | null> {
  const { supabase } = await import("@/lib/supabase");
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("username, display_name, bio")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as {
    username: string;
    display_name: string | null;
    bio: string | null;
  };
  return { username: row.username, displayName: row.display_name, bio: row.bio };
}

export function useOwnProfile() {
  const { session, user, loading } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  const hasSession = Boolean(session) && userId !== null;

  const query = useQuery<OwnProfile | null>({
    queryKey: [OWN_PROFILE_QUERY_ROOT, userId],
    queryFn: () => fetchOwnProfile(userId as string),
    enabled: !loading && hasSession,
    staleTime: 15_000,
    retry: false,
  });

  const refetchAndInvalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: [OWN_PROFILE_QUERY_ROOT, userId] });
  };

  return {
    /** true mientras se resuelve sesión o la consulta del perfil propio. */
    isLoading: loading || (hasSession && query.isLoading),
    /** null = sin sesión, o con sesión pero sin perfil configurado todavía. */
    profile: hasSession ? (query.data ?? null) : null,
    hasSession,
    isError: query.isError,
    /** Invalida la caché (llamar tras crear/editar el perfil propio en /account). */
    invalidate: refetchAndInvalidate,
  };
}
