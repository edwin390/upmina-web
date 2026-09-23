import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabase";

// Fuente única y centralizada de "¿hay una sesión de Supabase Auth activa en este
// navegador?" para el área /admin (Bloque 3A). Deliberadamente NO decide autorización:
// expone identidad autenticada (o su ausencia), nunca un rol. Consultar admin_roles o
// interpretar AAL como autorización sigue siendo responsabilidad exclusiva del backend
// (ver src/lib/admin-auth.ts) — este contexto es "¿quién eres, según Supabase Auth?",
// no "¿qué puedes hacer?".
//
// Un único listener: se suscribe una vez en el <AuthProvider> más alto de la subruta
// /admin (ver src/pages/admin/AdminAuthLayout.tsx), no en cada página. Login y signup
// comparten la misma instancia sin duplicar la suscripción a onAuthStateChange.

interface AuthContextValue {
  /** Sesión completa de Supabase Auth, o null si no hay ninguna. */
  session: Session | null;
  /** Atajo a session.user, o null. Nunca se deriva un rol de aquí. */
  user: User | null;
  /** true mientras se resuelve la sesión inicial (primer getSession()). */
  loading: boolean;
  /** Cierra la sesión actual de Supabase Auth. No-op si Supabase no está configurado. */
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  // Sin supabase configurado no hay nada que esperar: se resuelve como "sin sesión" de
  // inmediato en vez de quedar cargando para siempre.
  const [loading, setLoading] = useState(supabase !== null);

  useEffect(() => {
    if (!supabase) return;

    let isMounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!isMounted) return;
      setSession(data.session);
      setLoading(false);
    });

    // onAuthStateChange también dispara con el estado inicial en algunos casos, pero
    // getSession() de arriba es quien resuelve `loading`: este listener solo importa
    // para los cambios posteriores (login, logout, refresh de token).
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!isMounted) return;
      setSession(nextSession);
      setLoading(false);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
  }

  const value = useMemo<AuthContextValue>(
    () => ({ session, user: session?.user ?? null, loading, signOut }),
    [session, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// useAuth vive junto a AuthProvider a propósito (necesita el mismo AuthContext, que es
// privado del módulo): patrón estándar de contexto+hook. Solo implica que guardar este
// archivo en dev fuerza una recarga completa en vez de Fast Refresh, no afecta el
// comportamiento.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth debe usarse dentro de <AuthProvider>");
  }
  return context;
}
