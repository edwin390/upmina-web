import { useQuery } from "@tanstack/react-query";
import type { TwitchVideo } from "@/types";
import { isDemoMode } from "@/lib/runtime";

async function fetchTwitchLatestVideo(): Promise<TwitchVideo | null> {
  if (isDemoMode) return null;

  const response = await fetch("/api/twitch-latest-video");
  if (response.status === 204) return null;
  if (!response.ok) throw new Error("No se pudo obtener el último stream de Twitch");
  return response.json();
}

export function useTwitchLatestVideo() {
  return useQuery({
    queryKey: ["twitch", "latest-video"],
    queryFn: fetchTwitchLatestVideo,
    staleTime: 5 * 60_000,
  });
}
