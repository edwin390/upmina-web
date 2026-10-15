import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Footer from "./Footer";

const renderFooter = () =>
  render(
    <MemoryRouter>
      <Footer />
    </MemoryRouter>,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  try {
    localStorage.clear();
  } catch {
    // sin almacenamiento
  }
});

describe("Footer legal", () => {
  it("por defecto: sin licencia MIT, sin el enlace roto /docs/LEGAL.md y sin documentos no aprobados", async () => {
    const { container } = renderFooter();
    expect(
      await screen.findByRole("link", { name: "Reclamar derechos de autor" }),
    ).toHaveAttribute("href", "/copyright");
    expect(screen.getByRole("link", { name: "Términos" })).toHaveAttribute(
      "href",
      "/terms",
    );
    expect(screen.getByRole("link", { name: "Privacidad" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(screen.queryByRole("link", { name: "Reglas de comunidad" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Aviso legal" })).toBeNull();
    expect(container.textContent).not.toMatch(/MIT|licencia/i);
    expect(container.innerHTML).not.toContain("/docs/LEGAL.md");
    expect(container.textContent).toContain("proyecto independiente creado por fans");
    expect(container.textContent).toContain("Hecho con ♥ por fans");
  });

  it("con VITE_LEGAL_DOCS_ENABLED enlaza las Reglas y el Aviso legal (ruta real, no el inicio)", async () => {
    vi.stubEnv("VITE_LEGAL_DOCS_ENABLED", "true");
    renderFooter();
    expect(
      await screen.findByRole("link", { name: "Reglas de comunidad" }),
    ).toHaveAttribute("href", "/community-rules");
    const legal = screen.getAllByRole("link", { name: /aviso legal/i });
    expect(legal.length).toBeGreaterThan(0);
    for (const l of legal) expect(l).toHaveAttribute("href", "/legal");
  });

  it("el enlace de copyright aclara que no es un reporte de publicaciones", async () => {
    renderFooter();
    const link = await screen.findByRole("link", { name: "Reclamar derechos de autor" });
    expect(link.getAttribute("title")).toMatch(
      /titulares de derechos.*reportar una publicación/i,
    );
  });
});
