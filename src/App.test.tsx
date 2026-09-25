import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";
import App from "./App";

// /admin/* usa Supabase (VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY) solo si está
// configurado; en el entorno de test esas env vars no existen, así que src/lib/supabase.ts
// ya resuelve `supabase` como null y AuthProvider se resuelve como "sin sesión" de
// inmediato (ver auth-context.tsx) sin necesidad de mockear nada aquí.

describe("rutas legales", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
  });

  it.each([
    ["/terms", "Terms of Service"],
    ["/privacy", "Privacy Policy"],
  ])("%s muestra su página, la fecha y el contacto", (path, title) => {
    render(
      <QueryClientProvider client={testQueryClient}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    expect(screen.getByText("Effective date: September 20, 2026")).toBeInTheDocument();
    const mail = screen.getAllByRole("link", { name: "er179822@gmail.com" });
    expect(mail.length).toBeGreaterThan(0);
    for (const link of mail) {
      expect(link).toHaveAttribute("href", "mailto:er179822@gmail.com");
    }
  });

  it("el footer enlaza a Terms y Privacy, que no están en el menú principal", () => {
    render(
      <QueryClientProvider client={testQueryClient}>
        <MemoryRouter initialEntries={["/terms"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const legalNav = screen.getByRole("navigation", { name: "Legal" });
    expect(legalNav.querySelector('a[href="/terms"]')).not.toBeNull();
    expect(legalNav.querySelector('a[href="/privacy"]')).not.toBeNull();
    const headerNav = document.querySelector("header nav");
    expect(headerNav?.querySelector('a[href="/terms"], a[href="/privacy"]')).toBeNull();
  });
});

describe("/admin (Bloque 5C)", () => {
  afterEach(() => {
    cleanup();
  });

  it("sigue lazy-loaded: se muestra el fallback de Suspense antes del contenido de /admin", async () => {
    render(
      <QueryClientProvider client={testQueryClient}>
        <MemoryRouter initialEntries={["/admin"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Recién montado, el chunk de /admin (AdminDashboardPage + AdminAuthLayout) todavía
    // no resolvió: ni el shell ni el CTA de "sin sesión" están presentes todavía.
    expect(screen.queryByRole("heading", { name: "Panel de administración" })).toBeNull();
    expect(screen.queryByRole("link", { name: /iniciar sesión/i })).toBeNull();

    expect(
      await screen.findByRole("link", { name: /iniciar sesión/i }),
    ).toBeInTheDocument();
  });

  it.each([
    ["/admin/login", "Acceso admin"],
    ["/admin/signup", "Crear cuenta"],
  ])("%s sigue funcionando junto a la nueva ruta /admin", async (path, headingName) => {
    render(
      <QueryClientProvider client={testQueryClient}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("heading", { name: headingName })).toBeInTheDocument();
  });

  it("/admin/mfa y /admin/activate siguen funcionando junto a la nueva ruta /admin", async () => {
    render(
      <QueryClientProvider client={testQueryClient}>
        <MemoryRouter initialEntries={["/admin/mfa"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Verificación en dos pasos" }),
    ).toBeInTheDocument();
    cleanup();

    render(
      <QueryClientProvider client={testQueryClient}>
        <MemoryRouter initialEntries={["/admin/activate"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Activar acceso" }),
    ).toBeInTheDocument();
  });
});
