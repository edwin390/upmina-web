import { vi } from "vitest";
import "@testing-library/jest-dom";

// DEL-2: requireAuthenticated consulta la barrera de eliminación de cuentas. Las pruebas de los demás handlers parten de una cuenta
// ACTIVA sin necesitar esa RPC en sus dobles de Supabase; admin-auth.test.ts y account-deletion-*.test.ts ejercitan la función real.
vi.mock("./lib/account-deletion-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/account-deletion-gate")>()),
  readAccountGate: async () => "active" as const,
}));
