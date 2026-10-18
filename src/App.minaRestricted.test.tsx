import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";

// Modo restringido: Instagram, TikTok y Cosplays desactivados en la interfaz (solo presentación; el servidor repite el control).
const flags = vi.hoisted(() => ({ on: new Set<string>() }));
vi.mock("@/lib/mina-features-client", () => ({
  isMinaFeatureEnabled: (f: string) => flags.on.has(f),
}));
vi.mock("./lib/mina-features-client", () => ({
  isMinaFeatureEnabled: (f: string) => flags.on.has(f),
}));

import App from "./App";

const renderAt = (path: string) =>
  render(
    <QueryClientProvider client={testQueryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  window.scrollTo = vi.fn();
  flags.on = new Set();
});
afterEach(() => cleanup());

describe("modo restringido (funciones desactivadas)", () => {
  it.each(["/instagram", "/tiktok", "/cosplay", "/cosplay/un-slug"])(
    "%s muestra un estado neutral, sin cargar datos ni el aviso de permiso",
    async (path) => {
      renderAt(path);
      expect(
        await screen.findByRole("heading", { level: 1, name: "Sección no disponible" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Esta sección no está disponible por ahora."),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Volver al inicio" })).toHaveAttribute(
        "href",
        "/",
      );
      expect(screen.queryByText(/esperando el permiso de Mina/i)).toBeNull();
    },
  );

  it("la navegación y la home ocultan solo esas tres funciones y conservan Twitch, YouTube y Comunidad", async () => {
    renderAt("/");
    const nav = (await screen.findAllByRole("navigation"))[0];
    await screen.findByRole("heading", { name: /explora/i });
    const hrefs = [...document.querySelectorAll("header a, main a")].map((a) =>
      a.getAttribute("href"),
    );
    for (const hidden of ["/instagram", "/tiktok", "/cosplay"])
      expect(hrefs).not.toContain(hidden);
    for (const kept of ["/twitch", "/youtube", "/community"])
      expect(hrefs).toContain(kept);
    expect(nav).toBeTruthy();
  });

  it("Twitch, YouTube y Comunidad siguen siendo accesibles por su ruta", async () => {
    for (const path of ["/twitch", "/youtube", "/community"]) {
      renderAt(path);
      expect(screen.queryByText("Sección no disponible")).toBeNull();
      await within(document.body).findAllByRole("navigation");
      cleanup();
    }
  });
});

describe("funciones reactivadas", () => {
  it("con las tres activas vuelven los enlaces de la navegación", async () => {
    flags.on = new Set(["instagram", "tiktok", "cosplay"]);
    renderAt("/");
    await screen.findByRole("heading", { name: /explora/i });
    const hrefs = [...document.querySelectorAll("header a")].map((a) =>
      a.getAttribute("href"),
    );
    for (const shown of ["/instagram", "/tiktok", "/cosplay"])
      expect(hrefs).toContain(shown);
  });
  it("activar solo Cosplays no reabre Instagram ni TikTok", async () => {
    flags.on = new Set(["cosplay"]);
    renderAt("/instagram");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Sección no disponible" }),
    ).toBeInTheDocument();
  });
});
