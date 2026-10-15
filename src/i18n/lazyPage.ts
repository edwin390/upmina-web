import { lazy, type ComponentType } from "react";
import { currentLocale, ensureNamespaces, type NamespaceName } from "./messages";

/** `React.lazy` que descarga, en paralelo con el chunk de la página, los mensajes (idioma activo) de los
 *  espacios de nombres que la página usa. La página no se pinta hasta tener ambos: nunca muestra claves. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyPage<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
  namespaces: readonly NamespaceName[],
) {
  return lazy(async () => {
    const [module] = await Promise.all([
      load(),
      ensureNamespaces(currentLocale(), namespaces),
    ]);
    return module;
  });
}
