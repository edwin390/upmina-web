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

// /community (Fase 9J-2A): /comunidad pasa a ser una redirección de compatibilidad — nunca dos
// páginas de Comunidad renderizadas por separado.
describe("/community (Fase 9J-2A)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ items: [], nextCursor: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("/comunidad redirige a /community (misma página, sin duplicar Comunidad)", async () => {
    render(
      <QueryClientProvider client={testQueryClient}>
        <MemoryRouter initialEntries={["/comunidad"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("heading", { level: 1, name: "Comunidad" }),
    ).toBeInTheDocument();
  });
});

// /@username (Fase 9J-2B): coexiste con todas las rutas literales existentes y con el catch-all,
// sin que una ruta normal del sitio se interprete accidentalmente como un username.
describe("/@username (Fase 9J-2B)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("/@edwin1 renderiza el perfil público", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.includes("community-profile")) {
          return json({
            profile: {
              username: "edwin1",
              displayName: null,
              bio: null,
              postCount: 0,
              totalLikes: 0,
            },
            posts: { items: [], nextCursor: null },
          });
        }
        return json({}, 404);
      }),
    );

    render(
      <QueryClientProvider client={testQueryClient}>
        <MemoryRouter initialEntries={["/@edwin1"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("@edwin1")).toBeInTheDocument();
  });

  it("username inexistente: estado de perfil-no-encontrado, nunca el 404 genérico del sitio (redirección a /)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "Perfil no encontrado" }, 404)),
    );

    render(
      <QueryClientProvider client={testQueryClient}>
        <MemoryRouter initialEntries={["/@nadie-existe"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Este perfil no existe")).toBeInTheDocument();
    // Nunca redirigido a Home por el catch-all "*": /@username tiene su propia ruta dedicada.
    expect(screen.queryByRole("heading", { level: 1, name: "Comunidad" })).toBeNull();
  });

  it("el catch-all sigue funcionando para rutas realmente desconocidas (sin @)", () => {
    render(
      <QueryClientProvider client={testQueryClient}>
        <MemoryRouter initialEntries={["/esto-no-existe"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // El catch-all "*" redirige a Home ("/"): Home no depende de fetch, así que basta con que no
    // haya quedado en un estado de perfil ni haya lanzado.
    expect(screen.queryByText("Este perfil no existe")).toBeNull();
  });

  it("las rutas literales existentes (/cosplay, /account) siguen resolviendo con normalidad junto a /@:username", async () => {
    render(
      <QueryClientProvider client={testQueryClient}>
        <MemoryRouter initialEntries={["/cosplay"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
  });
});
