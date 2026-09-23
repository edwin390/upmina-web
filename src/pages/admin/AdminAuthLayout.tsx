import { Outlet } from "react-router-dom";
import { AuthProvider } from "@/lib/auth-context";

// Layout de ruta para /admin/login y /admin/signup: monta un único <AuthProvider> (un
// único listener de Supabase Auth) compartido por ambas páginas mientras se navega
// entre ellas, sin tocar el resto del sitio. Vive en su propio chunk (ver App.tsx: se
// importa con lazy()) para que Supabase y el contexto de auth nunca formen parte del
// bundle principal de Home — solo se descargan al entrar a /admin/*.
export default function AdminAuthLayout() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}
