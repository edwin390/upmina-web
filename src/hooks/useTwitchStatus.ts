import { useQuery } from "@tanstack/react-query";
import type { TwitchStatus } from "@/types";
import { isDemoMode } from "@/lib/runtime";

// Canal mostrado en modo demo únicamente (no hay backend real que consultar
// en ese modo). En producción, el canal siempre viene de la respuesta de
// /api/twitch-status, que a su vez lo lee de TWITCH_CHANNEL.
const DEMO_CHANNEL = "upminaa";

const TWITCH_STATUS_POLL_MS = 30_000;

async function fetchTwitchStatus(): Promise<TwitchStatus> {
  if (isDemoMode) return { isLive: false, channel: DEMO_CHANNEL };

  const res = await fetch("/api/twitch-status");
  if (!res.ok) throw new Error("No se pudo obtener el estado de Twitch");
  return res.json();
}

export function useTwitchStatus() {
  return useQuery({
    queryKey: ["twitch", "status"],
    queryFn: fetchTwitchStatus,
    staleTime: TWITCH_STATUS_POLL_MS,
    // Los viewers cambian durante el directo: se consulta cada 30 s (en línea con el s-maxage=30 de
    // /api/twitch-status). TanStack pausa el intervalo con la pestaña oculta (refetchIntervalInBackground
    // false) y, al volver, refetchOnWindowFocus actualiza al instante si el dato ya está obsoleto.
    refetchInterval: TWITCH_STATUS_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}
