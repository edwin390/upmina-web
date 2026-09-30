import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";
import { useCommunityPostDetail } from "./useCommunityPostDetail";

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

describe("useCommunityPostDetail", () => {
  it("pide /api/content/community-post-detail?postId=", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        post: {
          id: "p1",
          text: "hola",
          createdAt: "2026-01-01T00:00:00.000Z",
          author: { username: "edwin1", displayName: null },
          media: [],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCommunityPostDetail("p1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/content/community-post-detail?postId=p1",
    );
    expect(result.current.data?.id).toBe("p1");
  });

  it("404 → resuelve a null, sin lanzar", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const { result } = renderHook(() => useCommunityPostDetail("no-existe"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("error de servidor real (500) → isError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const { result } = renderHook(() => useCommunityPostDetail("p1"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("sin postId: query deshabilitada, nunca llama a fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useCommunityPostDetail(undefined), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
