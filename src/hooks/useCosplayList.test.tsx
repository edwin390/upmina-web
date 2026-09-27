import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";

// isDemoMode se fuerza explícitamente a false (a diferencia de useCosplayList.demo.test.tsx, que
// lo fuerza a true): NO basta con dejarlo sin mockear, porque isDemoMode se calcula una sola vez
// al cargar el módulo a partir de import.meta.env.VITE_DEMO_MODE, y Vite/Vitest cargan .env.local
// igual que en desarrollo — si el entorno local de quien ejecuta los tests tiene
// VITE_DEMO_MODE=true (p. ej. para revisar los fixtures en el navegador), estos tests deben
// seguir verificando el comportamiento real de Production sin depender de ese estado ambiental.
vi.mock("@/lib/runtime", () => ({ isDemoMode: false }));

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
describe("useCosplayList (sin demo mode: comportamiento por defecto/Production)", () => {
  it("pide /api/content/cosplay-list sin cursor la primera vez", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], nextCursor: null }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCosplayList(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith("/api/content/cosplay-list");
    expect(result.current.data?.pages[0]).toEqual({ items: [], nextCursor: null });
  });

  it("fetchNextPage añade el cursor codificado a la URL", async () => {
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

    const { result } = renderHook(() => useCosplayList(), { wrapper });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));

    await result.current.fetchNextPage();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/content/cosplay-list?cursor=abc123",
    );
  });

  it("respuesta no-ok → error, NUNCA cae a los fixtures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const { result } = renderHook(() => useCosplayList(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
