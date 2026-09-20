import { useQuery } from "@tanstack/react-query";
import type { TwitchStatus } from "@/types";
import { isDemoMode } from "@/lib/runtime";

// Canal mostrado en modo demo únicamente (no hay backend real que consultar
// en ese modo). En producción, el canal siempre viene de la respuesta de
// /api/twitch-status, que a su vez lo lee de TWITCH_CHANNEL.
const DEMO_CHANNEL = "upminaa";

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
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
