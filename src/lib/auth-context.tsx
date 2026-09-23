import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";

// Fuente única y centralizada de "¿hay una sesión de Supabase Auth activa en este
// navegador?" para el área /admin (Bloque 3A). Deliberadamente NO decide autorización:
// expone identidad autenticada (o su ausencia), nunca un rol. Consultar admin_roles o
// interpretar AAL como autorización sigue siendo responsabilidad exclusiva del backend
// (ver src/lib/admin-auth.ts) — este contexto es "¿quién eres, según Supabase Auth?",
// no "¿qué puedes hacer?".
//
// Un único listener (Bloque 6A): AuthProvider se monta una sola vez, en la raíz de la
// app (ver src/App.tsx), y toda ruta —pública o /admin/*— consume esa misma instancia
// vía useAuth(), sin duplicar la suscripción a onAuthStateChange. Sigue sin ser
// autoridad de nada: ADMIN/MODERATOR solo se deciden server-side (GET /api/admin/me).
//
// supabase-js (~227 kB) se importa dinámicamente dentro del efecto, después del primer
// render, para que montar el provider globalmente no meta esa dependencia en el bundle
// crítico de Home ni retrase su primer paint.

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
  // loading=true hasta resolver la sesión inicial (incluye la carga diferida de
  // supabase-js). Sin supabase configurado se resuelve como "sin sesión" en cuanto el
  // módulo carga, en vez de quedar cargando para siempre.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    let unsubscribe: (() => void) | undefined;

    void import("./supabase")
      .then(({ supabase }) => {
        // Desmontado mientras cargaba el módulo: no se suscribe nada.
        if (!isMounted) return;
        if (!supabase) {
          setLoading(false);
          return;
        }

        supabase.auth
          .getSession()
          .then(({ data }) => {
            if (!isMounted) return;
            setSession(data.session);
            setLoading(false);
          })
          .catch(() => {
            // Fail closed: sin sesión conocida, sin quedar cargando para siempre.
            if (isMounted) setLoading(false);
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
        unsubscribe = () => subscription.unsubscribe();
      })
      .catch(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
      unsubscribe?.();
    };
  }, []);

  async function signOut() {
    const { supabase } = await import("./supabase");
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
