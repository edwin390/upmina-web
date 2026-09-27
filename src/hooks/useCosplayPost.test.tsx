import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";

// isDemoMode se fuerza explícitamente a false (a diferencia de useCosplayPost.demo.test.tsx, que
// lo fuerza a true): ver el comentario equivalente en useCosplayList.test.tsx — isDemoMode se
// calcula una sola vez al cargar el módulo desde import.meta.env.VITE_DEMO_MODE, así que estos
// tests no pueden depender de que el .env.local de quien los ejecute no lo defina.
vi.mock("@/lib/runtime", () => ({ isDemoMode: false }));

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

describe("useCosplayPost (sin demo mode: comportamiento por defecto/Production)", () => {
  it("pide /api/content/cosplay-post con el slug codificado", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ slug: "kirito sao raro" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCosplayPost("kirito sao raro"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/content/cosplay-post?slug=kirito%20sao%20raro",
    );
  });

  it("404 → data undefined, sin isError (vacío legítimo, no un fallo)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const { result } = renderHook(() => useCosplayPost("no-existe"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it("500 → isError, NUNCA cae a los fixtures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const { result } = renderHook(() => useCosplayPost("kirito"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("sin slug: no dispara la consulta", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCosplayPost(undefined), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
