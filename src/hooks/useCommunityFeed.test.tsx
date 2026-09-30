import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";
import { useCommunityFeed } from "./useCommunityFeed";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={testQueryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  testQueryClient.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useCommunityFeed", () => {
  it("pide /api/content/community-feed?mode=recent sin cursor la primera vez (mode por defecto)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], nextCursor: null }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCommunityFeed(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith("/api/content/community-feed?mode=recent");
    expect(result.current.data?.pages[0]).toEqual({ items: [], nextCursor: null });
  });

  it("fetchNextPage añade el cursor codificado a la URL, preservando mode", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [], nextCursor: "abc123" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [], nextCursor: null }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCommunityFeed(), { wrapper });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));

    await result.current.fetchNextPage();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/content/community-feed?mode=recent&cursor=abc123",
    );
  });

  it("respuesta no-ok → error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const { result } = renderHook(() => useCommunityFeed(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it("mode='popular' pide /api/content/community-feed?mode=popular", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], nextCursor: null }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCommunityFeed("popular"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith("/api/content/community-feed?mode=popular");
  });

  it("recent y popular usan cachés de TanStack Query separadas", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], nextCursor: null }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const recent = renderHook(() => useCommunityFeed("recent"), { wrapper });
    const popular = renderHook(() => useCommunityFeed("popular"), { wrapper });
    await waitFor(() => expect(recent.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(popular.result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith("/api/content/community-feed?mode=recent");
    expect(fetchMock).toHaveBeenCalledWith("/api/content/community-feed?mode=popular");
  });
});
