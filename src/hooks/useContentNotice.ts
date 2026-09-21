import { useCallback, useEffect, useState } from "react";

/** Aviso temporal: `show()` lo muestra y desaparece solo a los `ms` (o al desmontar). */
export function useContentNotice(ms = 6000) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setVisible(false), ms);
    return () => clearTimeout(timer);
  }, [visible, ms]);

  const show = useCallback(() => setVisible(true), []);
  return { visible, show };
}
