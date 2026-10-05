import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  listenCommunityVisibility,
  notifyCommunityVisibility,
} from "./community-visibility-sync";
import { freshContentUrl, refreshCommunityContent } from "./content-freshness";

const postId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
class Channel {
  static open = new Set<Channel>();
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    Channel.open.add(this);
  }
  postMessage(data: unknown) {
    for (const peer of Channel.open)
      if (peer !== this) peer.onmessage?.({ data } as MessageEvent);
  }
  close() {
    Channel.open.delete(this);
  }
}
afterEach(() => {
  Channel.open.clear();
  vi.unstubAllGlobals();
});

describe("same-origin Community refresh signals", () => {
  it("refreshes active Community queries from authority, not unrelated domains; cleans up", async () => {
    vi.stubGlobal("BroadcastChannel", Channel);
    const a = new QueryClient();
    const b = new QueryClient();
    const closeA = listenCommunityVisibility(a);
    const closeB = listenCommunityVisibility(b);
    let state = "published";
    const observers = [
      ["community", "feed", "recent"],
      ["community", "profile", "author"],
      ["community", "own-posts"],
      ["community", "post-detail", postId],
    ].map(
      (queryKey) =>
        new QueryObserver(b, {
          queryKey,
          staleTime: Infinity,
          queryFn: async () => state,
        }),
    );
    const unsubs = observers.map((o) => o.subscribe(() => undefined));
    await Promise.all(observers.map((o) => o.refetch()));
    b.setQueryData(["cosplay", "list"], "untouched");
    state = "hidden";
    notifyCommunityVisibility(a, postId);
    await waitFor(() =>
      observers.forEach((o) => expect(o.getCurrentResult().data).toBe("hidden")),
    );
    expect(freshContentUrl(b, "community", "/api/feed")).toContain("_r=");
    state = "published";
    notifyCommunityVisibility(a, postId);
    notifyCommunityVisibility(a, postId);
    await waitFor(() =>
      observers.forEach((o) => expect(o.getCurrentResult().data).toBe("published")),
    );
    expect(b.getQueryState(["cosplay", "list"])?.isInvalidated).toBe(false);
    closeA();
    closeB();
    expect(Channel.open.size).toBe(0);
    const closeAgain = listenCommunityVisibility(b);
    expect(Channel.open.size).toBe(1);
    closeAgain();
    unsubs.forEach((fn) => fn());
    a.clear();
    b.clear();
  });
  it("cancels older in-flight responses so rapid refreshes cannot restore stale content", async () => {
    const client = new QueryClient();
    let finish!: (value: string) => void;
    let request = 0;
    const observer = new QueryObserver(client, {
      queryKey: ["community", "feed"],
      queryFn: () =>
        ++request === 1
          ? new Promise<string>((resolve) => {
              finish = resolve;
            })
          : Promise.resolve("latest"),
    });
    const unsub = observer.subscribe(() => undefined);
    await refreshCommunityContent(client, undefined, postId);
    finish("obsolete");
    await waitFor(() => expect(observer.getCurrentResult().data).toBe("latest"));
    unsub();
    client.clear();
  });
  it("ignores malformed signals and tolerates unavailable transport", () => {
    vi.stubGlobal("BroadcastChannel", Channel);
    const client = new QueryClient();
    client.setQueryData(["community", "feed"], "current");
    const close = listenCommunityVisibility(client);
    const sender = new Channel();
    sender.postMessage({ type: "other", postId });
    sender.postMessage({ type: "community-post-state-changed", postId: "invalid" });
    expect(client.getQueryState(["community", "feed"])?.isInvalidated).toBe(false);
    close();
    sender.close();
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(() => listenCommunityVisibility(client)()).not.toThrow();
    expect(() => notifyCommunityVisibility(client, postId)).not.toThrow();
    client.clear();
  });
});
