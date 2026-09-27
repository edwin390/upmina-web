import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";
import { COSPLAY_FIXTURE_LIST } from "@/lib/cosplay-fixtures";

// isDemoMode=true SOLO en este archivo (vi.mock es de módulo completo y se aplica a todos los
// tests del archivo): comprueba la divergencia intencional de useCosplayList frente al resto de
// hooks con isDemoMode (ver el comentario en useCosplayList.ts). El comportamiento por defecto
// (isDemoMode=false, sin mockear nada) está en useCosplayList.test.ts.
vi.mock("@/lib/runtime", () => ({ isDemoMode: true }));

const { useCosplayList } = await import("./useCosplayList");

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

describe("useCosplayList con VITE_DEMO_MODE=true", () => {
  it("devuelve los fixtures SIN llamar a fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCosplayList(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data?.pages[0]).toEqual({
      items: COSPLAY_FIXTURE_LIST,
      nextCursor: null,
    });
  });

  it("no hay una segunda página que pedir (nextCursor null en demo)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { result } = renderHook(() => useCosplayList(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(false);
  });
});
