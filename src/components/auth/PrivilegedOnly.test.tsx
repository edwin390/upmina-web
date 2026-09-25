import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";

// PrivilegedOnly (Fase 9G-3): SOLO presentación. Falla cerrado: mientras el acceso carga, falla o
// no coincide no renderiza nada (ni placeholders ni botones deshabilitados). No es autorización.

const authFakes = vi.hoisted(() => ({
  session: null as null | { access_token: string; user: { id: string } },
  loading: false,
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: authFakes.session,
    user: authFakes.session?.user ?? null,
    loading: authFakes.loading,
    signOut: async () => undefined,
  }),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: authFakes.session } }) },
  },
}));

import PrivilegedOnly from "./PrivilegedOnly";

const CAPS: Record<string, string[]> = {
  admin: ["moderation", "technical", "social_admin", "team_admin"],
  moderator: ["moderation"],
  developer: ["moderation", "technical"],
};

function stubAccess(role: string | null, recent = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        role,
        capabilities: role ? CAPS[role] : [],
        mfa: { recent },
      }),
    })),
  );
}

function renderGuard(props: Parameters<typeof PrivilegedOnly>[0]) {
  return render(
    <QueryClientProvider client={testQueryClient}>
      <PrivilegedOnly {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  testQueryClient.clear();
  authFakes.session = { access_token: "at", user: { id: "u1" } };
  authFakes.loading = false;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PrivilegedOnly", () => {
  it("role=admin: ADMIN ve el contenido", async () => {
    stubAccess("admin");
    renderGuard({ role: "admin", children: <p>contenido admin</p> });

    expect(await screen.findByText("contenido admin")).toBeInTheDocument();
  });

  it("role=admin: se muestra aunque el MFA no sea reciente (el step-up ocurre al cruzar la frontera)", async () => {
    stubAccess("admin", false);
    renderGuard({ role: "admin", children: <p>contenido admin</p> });

    expect(await screen.findByText("contenido admin")).toBeInTheDocument();
  });

  it.each([
    ["USER", null],
    ["MODERATOR", "moderator"],
    ["DEVELOPER", "developer"],
  ])("role=admin: %s no ve nada", async (_n, role) => {
    stubAccess(role);
    renderGuard({ role: "admin", children: <p>contenido admin</p> });

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("contenido admin")).toBeNull();
    expect(document.body.textContent).toBe("");
  });

  it("USER con MFA reciente sigue sin ver nada", async () => {
    stubAccess(null, true);
    renderGuard({ role: "admin", children: <p>contenido admin</p> });

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(document.body.textContent).toBe("");
  });

  it("capability: requiere la capacidad además de tener rol", async () => {
    stubAccess("moderator");
    const view = renderGuard({ capability: "moderation", children: <p>moderar</p> });
    expect(await screen.findByText("moderar")).toBeInTheDocument();
    view.unmount();

    testQueryClient.clear();
    stubAccess("moderator");
    renderGuard({ capability: "team_admin", children: <p>equipo</p> });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("equipo")).toBeNull();
  });

  it("rol y capacidad a la vez: ambos deben coincidir", async () => {
    stubAccess("developer");
    renderGuard({ role: "admin", capability: "technical", children: <p>ambos</p> });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("ambos")).toBeNull();
  });

  it("sin ningún requisito NO muestra nada (no sirve como 'cualquier privilegiado')", async () => {
    stubAccess("admin");
    renderGuard({ children: <p>sin requisito</p> });

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("sin requisito")).toBeNull();
  });

  it("mientras el acceso carga no muestra nada (sin destello privilegiado)", async () => {
    let release: (v: unknown) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((resolve) => (release = resolve))),
    );
    renderGuard({ role: "admin", children: <p>contenido admin</p> });

    expect(screen.queryByText("contenido admin")).toBeNull();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText("contenido admin")).toBeNull();
    release({
      ok: true,
      status: 200,
      json: async () => ({
        role: "admin",
        capabilities: CAPS.admin,
        mfa: { recent: true },
      }),
    });
    expect(await screen.findByText("contenido admin")).toBeInTheDocument();
  });

  it.each([
    ["error 500", { ok: false, status: 500, json: async () => ({}) }],
    ["401", { ok: false, status: 401, json: async () => ({}) }],
    ["cuerpo inválido", { ok: true, status: 200, json: async () => ({ role: "admin" }) }],
    [
      "rol desconocido",
      {
        ok: true,
        status: 200,
        json: async () => ({ role: "root", capabilities: [], mfa: { recent: true } }),
      },
    ],
  ])("acceso con %s → falla cerrado", async (_n, response) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    renderGuard({ role: "admin", children: <p>contenido admin</p> });

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("contenido admin")).toBeNull();
  });

  it("sin sesión no consulta y no muestra nada", async () => {
    authFakes.session = null;
    vi.stubGlobal("fetch", vi.fn());
    renderGuard({ role: "admin", children: <p>contenido admin</p> });

    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByText("contenido admin")).toBeNull();
  });

  it("no usa datos locales: app_metadata.role del cliente no muestra nada", async () => {
    authFakes.session = {
      access_token: "at",
      user: { id: "u1", app_metadata: { role: "admin" } },
    } as never;
    stubAccess(null);
    renderGuard({ role: "admin", children: <p>contenido admin</p> });

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("contenido admin")).toBeNull();
  });
});
