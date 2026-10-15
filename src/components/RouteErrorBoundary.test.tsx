import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import RouteErrorBoundary from "./RouteErrorBoundary";
import { isChunkLoadError, reloadOnceForStaleChunk } from "@/lib/chunk-recovery";

function Boom(): never {
  throw new Error("fallo de render");
}

describe("RouteErrorBoundary", () => {
  it("muestra un aviso en vez de desmontar la aplicación", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <header>cabecera</header>
        <RouteErrorBoundary>
          <Boom />
        </RouteErrorBoundary>
      </div>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("cabecera")).toBeTruthy();
    spy.mockRestore();
  });

  it("reconoce fallos de descarga de chunks y no otros errores", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: /a.js"))).toBe(true);
    expect(isChunkLoadError(new Error("fallo de render"))).toBe(false);
  });

  it("no recarga de nuevo si ya se recargó hace menos de un minuto (sin bucles)", () => {
    window.sessionStorage.setItem("upmina:chunk-reload-at", String(Date.now()));
    expect(reloadOnceForStaleChunk()).toBe(false);
    window.sessionStorage.clear();
  });

  it("con fallback=null el fallo de un bloque secundario no derriba el resto", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <main>contenido</main>
        <RouteErrorBoundary fallback={null}>
          <Boom />
        </RouteErrorBoundary>
      </div>,
    );
    expect(screen.getByText("contenido")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
