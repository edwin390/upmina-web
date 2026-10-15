// Los documentos legales nuevos (Reglas de comunidad, Aviso legal) siguen siendo BORRADORES (docs/legal/): sus rutas y
// los enlaces del footer solo existen con VITE_LEGAL_DOCS_ENABLED=true. Por defecto está desactivado y no se publica nada.
export function isLegalDocsEnabled(
  env: Record<string, unknown> = import.meta.env,
): boolean {
  return env.VITE_LEGAL_DOCS_ENABLED === "true";
}
