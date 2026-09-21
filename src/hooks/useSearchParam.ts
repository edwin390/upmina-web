import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Un parámetro de la URL como única fuente de verdad. `set` usa `replace` (los cambios dentro de
 * una sección no llenan el historial) y conserva el resto de parámetros; `null` lo elimina.
 */
export function useSearchParam(name: string) {
  const [params, setParams] = useSearchParams();
  const value = params.get(name);

  const set = useCallback(
    (next: string | null) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          if (next === null) updated.delete(name);
          else updated.set(name, next);
          return updated;
        },
        { replace: true },
      );
    },
    [name, setParams],
  );

  return [value, set] as const;
}
