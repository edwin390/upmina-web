import { useQuery } from "@tanstack/react-query";
import type { InstagramMediaItem } from "@/types";
import { isDemoMode } from "@/lib/runtime";

async function fetchInstagramFeed(): Promise<InstagramMediaItem[]> {
  if (isDemoMode) return [];

  const res = await fetch("/api/instagram-feed");
  if (!res.ok) throw new Error("No se pudo obtener el feed de Instagram");
  return res.json();
}

export function useInstagramFeed() {
  return useQuery({
    queryKey: ["instagram", "feed"],
    queryFn: fetchInstagramFeed,
    staleTime: 15 * 60_000,
    retry: 1,
  });
}
