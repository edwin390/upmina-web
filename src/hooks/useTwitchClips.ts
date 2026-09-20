import { useQuery } from "@tanstack/react-query";
import type { TwitchClip } from "@/types";
import { isDemoMode } from "@/lib/runtime";

// Distingue "Twitch no está configurado" (503, ver TwitchApiError en
// src/lib/twitch-shared.ts) de un error temporal (Twitch caído, rate limit,
// etc.), para que la UI pueda mostrar un mensaje distinto en cada caso.
export class TwitchClipsError extends Error {
  constructor(readonly status: number) {
    super("No se pudieron obtener los clips de Twitch");
    this.name = "TwitchClipsError";
  }
}

async function fetchTwitchClips(): Promise<TwitchClip[]> {
  if (isDemoMode) return [];

  const res = await fetch("/api/twitch-clips");
  if (!res.ok) throw new TwitchClipsError(res.status);
  return res.json();
}

export function useTwitchClips() {
  return useQuery({
    queryKey: ["twitch", "clips"],
    queryFn: fetchTwitchClips,
    staleTime: 5 * 60_000,
  });
}
