import { vi } from "vitest";
import "@testing-library/jest-dom";
import { ensureNamespaces, NAMESPACES } from "./i18n/messages";

// En la app sólo el núcleo de ES viaja en el bundle y el resto se carga por ruta; las pruebas montan componentes sueltos
// o el proveedor sin rutas, así que se precargan todos los espacios en español (el idioma de sus textos esperados).
await ensureNamespaces("es", NAMESPACES);

// DEL-2: requireAuthenticated consulta la barrera de eliminación de cuentas. Las pruebas de los demás handlers parten de una cuenta
// ACTIVA sin necesitar esa RPC en sus dobles de Supabase; admin-auth.test.ts y account-deletion-*.test.ts ejercitan la función real.
vi.mock("./lib/account-deletion-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/account-deletion-gate")>()),
  readAccountGate: async () => "active" as const,
}));

// i18n global: la app monta UN proveedor de idioma en la raíz. Las pruebas unitarias de componentes sueltos no lo montan, así que
// useTranslations cae a los mensajes ES (los textos que verifican) cuando no hay proveedor; con proveedor se usa el real.
vi.mock("use-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("use-intl")>();
  const { ES_MESSAGES } = await import("./i18n/es-messages");
  return {
    ...actual,
    useTranslations: (namespace?: string) => {
      try {
        return actual.useTranslations(namespace as never);
      } catch {
        return actual.createTranslator({
          locale: "es",
          messages: ES_MESSAGES as never,
          namespace: namespace as never,
        });
      }
    },
  };
});
