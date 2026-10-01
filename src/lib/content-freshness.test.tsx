import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  freshContentUrl,
  refreshCommunityContent,
  refreshCosplayContent,
} from "./content-freshness";
import { useCommunityFeed } from "@/hooks/useCommunityFeed";
import { useCommunityProfile } from "@/hooks/useCommunityProfile";
import { useCommunityPostDetail } from "@/hooks/useCommunityPostDetail";
import { useCosplayList } from "@/hooks/useCosplayList";
import { useCosplayPost } from "@/hooks/useCosplayPost";

vi.mock("@/lib/runtime", () => ({ isDemoMode: false }));
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  let version = 1;
  let deleted = false;
  // Simulate public HTTP caching: the original URL continues returning pre-mutation data.
  const fetchMock = vi.fn(async (url: string) => {
    const fresh = new URL(url, "https://local.test").searchParams.has("_r");
    const data = { id: "post", version: fresh ? version : 1 };
    if (fresh && deleted && /post-detail|cosplay-post/.test(url))
      return { status: 404, ok: false };
    const body = url.includes("community-profile")
      ? {
          profile: {},
          posts: { items: deleted && fresh ? [] : [data], nextCursor: null },
        }
      : url.includes("community-post-detail")
        ? { post: data }
        : url.includes("cosplay-post")
          ? data
          : { items: deleted && fresh ? [] : [data], nextCursor: null };
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    client,
    wrapper,
    fetchMock,
    mutate: (remove = false) => {
      version++;
      deleted = remove;
    },
  };
}

describe("post-mutation freshness with public HTTP caching", () => {
  it.each(["create", "edit", "delete"])(
    "Community %s refreshes fresh feed/profile/detail caches",
    async (mutation) => {
      const env = setup();
      const { result } = renderHook(
        () => ({
          feed: useCommunityFeed(),
          profile: useCommunityProfile("edwin"),
          detail: useCommunityPostDetail("post"),
        }),
        { wrapper: env.wrapper },
      );
      await waitFor(() =>
        expect(result.current.detail.data).toMatchObject({ version: 1 }),
      );
      await waitFor(() =>
        expect(result.current.feed.isSuccess && result.current.profile.isSuccess).toBe(
          true,
        ),
      );
      expect(result.current.feed.data?.pages[0].items[0]).toMatchObject({ version: 1 });
      expect(result.current.profile.data?.pages[0]?.posts.items[0]).toMatchObject({
        version: 1,
      });
      let ownVersion = 1;
      const own = new QueryObserver(env.client, {
        queryKey: ["community", "own-posts"],
        staleTime: 60_000,
        queryFn: async () => ownVersion,
      });
      const unsubscribe = own.subscribe(() => undefined);
      await own.refetch();
      env.mutate(mutation === "delete");
      ownVersion = 2;
      await act(async () => {
        await refreshCommunityContent(
          env.client,
          "edwin",
          mutation === "create" ? undefined : "post",
          mutation === "delete",
        );
      });
      await waitFor(() =>
        expect(result.current.feed.data?.pages[0].items).toEqual(
          mutation === "delete" ? [] : [{ id: "post", version: 2 }],
        ),
      );
      expect(own.getCurrentResult().data).toBe(2);
      expect(result.current.profile.data?.pages[0]?.posts.items).toEqual(
        mutation === "delete" ? [] : [{ id: "post", version: 2 }],
      );
      if (mutation === "edit")
        expect(result.current.detail.data).toMatchObject({ version: 2 });
      if (mutation === "delete") expect(result.current.detail.data).toBeNull();
      expect(
        env.fetchMock.mock.calls.some(
          ([url]) => url.includes("community-feed") && url.includes("_r="),
        ),
      ).toBe(true);
      unsubscribe();
    },
  );

  it.each(["publish", "edit", "detach", "delete"])(
    "Cosplay %s refreshes list/detail without new query identities",
    async (mutation) => {
      const env = setup();
      const { result } = renderHook(
        () => ({ list: useCosplayList(), detail: useCosplayPost("slug") }),
        { wrapper: env.wrapper },
      );
      await waitFor(() =>
        expect(result.current.detail.data).toMatchObject({ version: 1 }),
      );
      await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
      expect(result.current.list.data?.pages[0].items[0]).toMatchObject({ version: 1 });
      env.mutate(mutation === "delete");
      await act(async () => {
        await refreshCosplayContent(
          env.client,
          "published",
          mutation === "delete" ? "slug" : undefined,
        );
      });
      await waitFor(() =>
        expect(result.current.list.data?.pages[0].items).toEqual(
          mutation === "delete" ? [] : [{ id: "post", version: 2 }],
        ),
      );
      expect(result.current.detail.data).toEqual(
        mutation === "delete" ? null : { id: "post", version: 2 },
      );
      expect(env.client.getQueryCache().getAll()).toHaveLength(2);
    },
  );

  it("draft-only persistence refreshes draft management without refetching the public feed", async () => {
    const env = setup();
    const { result } = renderHook(() => useCosplayList(), { wrapper: env.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    let drafts: string[] = [];
    const observer = new QueryObserver(env.client, {
      queryKey: ["cosplay", "own-drafts", "user"],
      queryFn: async () => drafts,
      staleTime: 60_000,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await observer.refetch();
    drafts = ["saved-draft"];
    await refreshCosplayContent(env.client, "draft");
    expect(observer.getCurrentResult().data).toEqual(["saved-draft"]);
    expect(env.fetchMock).toHaveBeenCalledTimes(1);
    expect(freshContentUrl(env.client, "cosplay", "/api/content/cosplay-list")).toBe(
      "/api/content/cosplay-list",
    );
    unsubscribe();
  });

  it("remount and separate sessions cannot restart freshness at _r=1; keys stay bounded", async () => {
    const env = setup();
    const first = renderHook(() => useCosplayList(), { wrapper: env.wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    await act(async () => {
      await refreshCosplayContent(env.client);
    });
    const firstUrl = env.fetchMock.mock.calls.at(-1)![0];
    first.unmount();
    env.mutate();
    await refreshCosplayContent(env.client);
    const second = renderHook(() => useCosplayList(), { wrapper: env.wrapper });
    await waitFor(() =>
      expect(second.result.current.data?.pages[0].items[0]).toMatchObject({ version: 2 }),
    );
    expect(env.fetchMock.mock.calls.at(-1)![0]).not.toBe(firstUrl);
    const otherClient = new QueryClient();
    await refreshCosplayContent(otherClient);
    expect(freshContentUrl(otherClient, "cosplay", "/api/content/cosplay-list")).not.toBe(
      firstUrl,
    );
    expect(env.client.getQueryCache().getAll()).toHaveLength(1);
  });
});
