import { Outlet } from "react-router-dom";

// Layout de ruta de /admin/*. Desde el Bloque 6A NO monta un AuthProvider propio: la
// sesión vive en el <AuthProvider> global de src/App.tsx y todas las páginas admin la
// consumen con useAuth() (una sola fuente de sesión, un solo listener de Supabase Auth).
// Solo conserva el agrupamiento de rutas /admin/* en su propio chunk lazy.
export default function AdminAuthLayout() {
  return <Outlet />;
}
