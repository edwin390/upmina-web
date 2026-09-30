import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";
import { useCommunityProfile } from "./useCommunityProfile";

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

describe("useCommunityProfile", () => {
  it("pide /api/content/community-profile?username= sin cursor la primera vez", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        profile: { username: "edwin1", displayName: null, bio: null, postCount: 0 },
        posts: { items: [], nextCursor: null },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCommunityProfile("edwin1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/content/community-profile?username=edwin1",
    );
    expect(result.current.data?.pages[0]?.profile.username).toBe("edwin1");
  });

  it("404 → resuelve a null (perfil inexistente), sin lanzar", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const { result } = renderHook(() => useCommunityProfile("nadie"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.pages[0]).toBeNull();
  });

  it("error de servidor real (500) → isError, distinto de un 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const { result } = renderHook(() => useCommunityProfile("edwin1"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("fetchNextPage añade username y el cursor codificado a la URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          profile: { username: "edwin1", displayName: null, bio: null, postCount: 30 },
          posts: { items: [], nextCursor: "abc123" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          profile: { username: "edwin1", displayName: null, bio: null, postCount: 30 },
          posts: { items: [], nextCursor: null },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCommunityProfile("edwin1"), { wrapper });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));

    await result.current.fetchNextPage();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/content/community-profile?username=edwin1&cursor=abc123",
    );
  });

  it("username vacío: query deshabilitada, nunca llama a fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useCommunityProfile(""), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
