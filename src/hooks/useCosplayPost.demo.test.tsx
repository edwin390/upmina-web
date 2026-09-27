import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";
import { COSPLAY_FIXTURE_POSTS } from "@/lib/cosplay-fixtures";

vi.mock("@/lib/runtime", () => ({ isDemoMode: true }));

const { useCosplayPost } = await import("./useCosplayPost");

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

describe("useCosplayPost con VITE_DEMO_MODE=true", () => {
  it("slug de un fixture conocido: devuelve ese fixture sin llamar a fetch", async () => {
    const fixture = COSPLAY_FIXTURE_POSTS[0]!;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCosplayPost(fixture.slug), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data).toEqual(fixture);
  });

  it("slug desconocido incluso en demo: data undefined, sin error", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { result } = renderHook(() => useCosplayPost("no-existe-ni-en-fixtures"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});
