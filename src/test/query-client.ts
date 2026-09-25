import { QueryClient } from "@tanstack/react-query";

// Cliente de TanStack Query COMPARTIDO por los tests de páginas que consumen useAdminAccess
// (Fase 9G-3). Sin reintentos (un fallo simulado debe verse de inmediato) y con `clear()` en cada
// beforeEach para que ninguna caché de un test se filtre al siguiente.
export const testQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: Infinity } },
});
