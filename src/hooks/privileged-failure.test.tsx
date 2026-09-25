import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  PrivilegedFailureContext,
  usePrivilegedFailureReporter,
} from "./privileged-failure";

// Canal común de fallos privilegiados (Fase 9G-3): clasifica y comunica; no reintenta ni ejecuta.

const res = (status: number, body?: unknown) => ({ status, json: async () => body });

function withHandler(handler: (f: never) => void) {
  return ({ children }: { children: ReactNode }) => (
    <PrivilegedFailureContext.Provider value={handler as never}>
      {children}
    </PrivilegedFailureContext.Provider>
  );
}

describe("usePrivilegedFailureReporter", () => {
  it.each([
    ["401", res(401), "unauthenticated"],
    ["403 genérico", res(403, { error: "No autorizado" }), "forbidden"],
    ["403 step-up", res(403, { code: "step_up_required" }), "step_up_required"],
  ])("%s → el manejador recibe %s", async (_n, response, expected) => {
    const handler = vi.fn();
    const { result } = renderHook(() => usePrivilegedFailureReporter(), {
      wrapper: withHandler(handler),
    });

    result.current(response);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(expected));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each([200, 404, 409, 500])(
    "status %i → el manejador NO se invoca",
    async (status) => {
      const handler = vi.fn();
      const { result } = renderHook(() => usePrivilegedFailureReporter(), {
        wrapper: withHandler(handler),
      });

      result.current(res(status, { code: "step_up_required" }));
      await new Promise((r) => setTimeout(r, 10));

      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("sin proveedor es un no-op seguro", async () => {
    const { result } = renderHook(() => usePrivilegedFailureReporter());

    expect(() => result.current(res(403, { code: "step_up_required" }))).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });

  it("solo informa: no llama a fetch ni navega (nada se reproduce después de un MFA)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("no debe llamarse");
    });
    const before = window.location.href;
    const handler = vi.fn();
    const { result } = renderHook(() => usePrivilegedFailureReporter(), {
      wrapper: withHandler(handler),
    });

    result.current(res(403, { code: "step_up_required" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    fetchSpy.mockRestore();
  });

  it("el reporter es estable mientras el manejador no cambie", () => {
    const handler = vi.fn();
    const { result, rerender } = renderHook(() => usePrivilegedFailureReporter(), {
      wrapper: withHandler(handler),
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
