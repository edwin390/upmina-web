import type { QueryClient } from "@tanstack/react-query";
import { refreshCommunityContent } from "./content-freshness";

const CHANNEL = "upmina-community-visibility-v1";
type VisibilitySignal = { type: "community-post-state-changed"; postId: string };
const connections = new WeakMap<QueryClient, BroadcastChannel>();

// A signal requests an authoritative read. It never supplies post state or identity.
export function listenCommunityVisibility(client: QueryClient): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    return () => undefined;
  }
  connections.set(client, channel);
  channel.onmessage = ({ data }: MessageEvent<unknown>) => {
    if (!data || typeof data !== "object") return;
    const signal = data as Partial<VisibilitySignal>;
    if (
      signal.type !== "community-post-state-changed" ||
      typeof signal.postId !== "string" ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(signal.postId)
    )
      return;
    void refreshCommunityContent(client, undefined, signal.postId).catch(() => undefined);
  };
  return () => {
    channel.onmessage = null;
    channel.close();
    if (connections.get(client) === channel) connections.delete(client);
  };
}

export function notifyCommunityVisibility(client: QueryClient, postId: string) {
  try {
    connections.get(client)?.postMessage({
      type: "community-post-state-changed",
      postId,
    } satisfies VisibilitySignal);
  } catch {
    // Browser transport failure must not turn a confirmed write into an error.
  }
}
