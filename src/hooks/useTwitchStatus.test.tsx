import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useTwitchStatus } from "./useTwitchStatus";

// Contador de viewers: consulta inicial, refresco cada 30 s mientras la pestaña está visible, pausa con la pestaña
// oculta, actualización al volver, sin intervalos acumulados y sin datos inventados cuando falla la red.
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => state === "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
}
const live = (n: number) =>
  new Response(JSON.stringify({ isLive: true, channel: "c", viewerCount: n }), {
    status: 200,
  });

// TanStack solo re-renderiza por las propiedades que se LEEN durante el render: la sonda las lee todas, como hacen
// los componentes reales (TwitchSection/NowSection leen data, isLoading e isError).
function useProbe() {
  const q = useTwitchStatus();
  return { data: q.data, isError: q.isError, isLoading: q.isLoading, refetch: q.refetch };
}

let fetchMock: ReturnType<typeof vi.fn>;
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const W = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { W, client };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setVisibility("visible");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useTwitchStatus", () => {
  it("consulta al montar y refresca los viewers cada 30 s", async () => {
    fetchMock.mockImplementation(async () => live(10 + fetchMock.mock.calls.length));
    const { W } = wrapper();
    const { result } = renderHook(() => useProbe(), { wrapper: W });
    await waitFor(() => expect(result.current.data?.viewerCount).toBe(11));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    await waitFor(() => expect(result.current.data?.viewerCount).toBe(12));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("no acumula intervalos al desmontar y volver a montar, y se detiene al desmontar", async () => {
    fetchMock.mockImplementation(async () => live(5));
    const { W } = wrapper();
    const first = renderHook(() => useProbe(), { wrapper: W });
    await waitFor(() => expect(first.result.current.data).toBeDefined());
    first.unmount();
    await act(async () => void (await vi.advanceTimersByTimeAsync(120_000)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("con la pestaña oculta no consulta y al volver actualiza de inmediato si el dato está obsoleto", async () => {
    fetchMock.mockImplementation(async () => live(7));
    const { W } = wrapper();
    const { result } = renderHook(() => useProbe(), { wrapper: W });
    await waitFor(() => expect(result.current.data).toBeDefined());
    setVisibility("hidden");
    await act(async () => void (await vi.advanceTimersByTimeAsync(120_000)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("un fallo de red marca error sin inventar viewers; el siguiente intento recupera el dato", async () => {
    const queue: Array<() => Response> = [
      () => new Response("{}", { status: 503 }),
      () => live(11),
    ];
    fetchMock.mockImplementation(async () => (queue.shift() ?? (() => live(0)))());
    const { W } = wrapper();
    const { result } = renderHook(() => useProbe(), { wrapper: W });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    await act(async () => void (await vi.advanceTimersByTimeAsync(31_000)));
    await waitFor(() => expect(result.current.data?.viewerCount).toBe(11));
    expect(result.current.isError).toBe(false);
  });

  it("si un refresco posterior falla, hay error de consulta y se conserva el dato anterior (la interfaz no lo presenta como vigente)", async () => {
    const queue: Array<() => Response> = [
      () => live(9),
      () => new Response("{}", { status: 503 }),
      () => live(12),
    ];
    fetchMock.mockImplementation(async () => (queue.shift() ?? (() => live(0)))());
    const { W } = wrapper();
    const { result } = renderHook(() => useProbe(), { wrapper: W });
    await waitFor(() => expect(result.current.data?.viewerCount).toBe(9));
    await act(async () => void (await vi.advanceTimersByTimeAsync(31_000)));
    await waitFor(() => expect(result.current.isError).toBe(true));
    // TanStack conserva el último dato bueno junto al error: son dos señales distintas...
    expect(result.current.data?.viewerCount).toBe(9);
    // ...y los componentes dan prioridad a isError (badge "error", sin número): ver LiveBadge.test.tsx.
    await act(async () => void (await vi.advanceTimersByTimeAsync(31_000)));
    await waitFor(() => expect(result.current.data?.viewerCount).toBe(12));
    expect(result.current.isError).toBe(false);
  });

  it("volver a la pestaña con el dato vigente no genera una consulta extra", async () => {
    fetchMock.mockImplementation(async () => live(4));
    const { W } = wrapper();
    const { result } = renderHook(() => useProbe(), { wrapper: W });
    await waitFor(() => expect(result.current.data).toBeDefined());
    setVisibility("hidden");
    setVisibility("visible");
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pasa a OFFLINE cuando el directo termina (sin viewerCount)", async () => {
    fetchMock.mockResolvedValueOnce(live(3));
    const { W } = wrapper();
    const { result } = renderHook(() => useProbe(), { wrapper: W });
    await waitFor(() => expect(result.current.data?.isLive).toBe(true));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ isLive: false, channel: "c" }), { status: 200 }),
    );
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    await waitFor(() => expect(result.current.data?.isLive).toBe(false));
    expect(result.current.data?.viewerCount).toBeUndefined();
  });
});
