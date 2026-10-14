import type { QueryClient } from "@tanstack/react-query";

// Al desconectar TikTok o Instagram, el contenido ya cargado en el navegador (TanStack Query, con staleTime de
// hasta 1 h) debe desaparecer sin recargar: en esta pestaña (evento de window) y en las demás pestañas del mismo
// navegador (BroadcastChannel). Se reinician las consultas del proveedor: las activas se vuelven a pedir y
// muestran el estado vacío/no disponible. Solo cubre pestañas abiertas del MISMO navegador.
export type SocialContentProvider = "tiktok" | "instagram";
const EVENT = "upmina:social-disconnected";
const CHANNEL = "upmina-social";

export function notifySocialDisconnected(provider: SocialContentProvider): void {
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: provider }));
  } catch {
    // sin window/CustomEvent: nada que notificar
  }
  try {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage(provider);
    channel.close();
  } catch {
    // BroadcastChannel no disponible: solo esta pestaña
  }
}

const isProvider = (v: unknown): v is SocialContentProvider =>
  v === "tiktok" || v === "instagram";

export function installSocialContentCacheListener(queryClient: QueryClient): () => void {
  const reset = (provider: unknown) => {
    if (isProvider(provider)) void queryClient.resetQueries({ queryKey: [provider] });
  };
  const onEvent = (e: Event) => reset((e as CustomEvent).detail);
  window.addEventListener(EVENT, onEvent);
  let channel: BroadcastChannel | undefined;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (m) => reset(m.data);
    }
  } catch {
    channel = undefined;
  }
  return () => {
    window.removeEventListener(EVENT, onEvent);
    channel?.close();
  };
}
