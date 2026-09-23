import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// AuthProvider global (Bloque 6A): una sola fuente de sesión y un solo listener de
// Supabase Auth para TODA la app (rutas públicas y /admin/*), sin requests a
// /api/admin/me fuera de /admin. Se mockea únicamente @/lib/supabase; el AuthProvider,
// AdminAuthLayout, AdminDashboardPage y el routing de App son los reales.

const authFakes = vi.hoisted(() => ({
  session: null as null | { access_token: string; user: { id: string } },
  getSessionCalls: 0,
  onAuthStateChangeCalls: 0,
  unsubscribeCalls: 0,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      async getSession() {
        authFakes.getSessionCalls++;
        return { data: { session: authFakes.session } };
      },
      onAuthStateChange() {
        authFakes.onAuthStateChangeCalls++;
        return {
          data: {
            subscription: {
              unsubscribe() {
                authFakes.unsubscribeCalls++;
              },
            },
          },
        };
      },
      mfa: {
        async getAuthenticatorAssuranceLevel() {
          return { data: { currentLevel: "aal1" }, error: null };
        },
      },
    },
  },
}));

// /terms se sustituye por una sonda que consume useAuth() desde una ruta PÚBLICA y
// ofrece un enlace hacia /admin para probar la navegación pública → admin.
vi.mock("./pages/TermsPage", async () => {
  const { useAuth } = await import("./lib/auth-context");
  const { Link } = await import("react-router-dom");
  return {
    default: function TermsProbe() {
      const { session, loading } = useAuth();
      return (
        <div>
          <p data-testid="probe">
            {loading ? "cargando" : session ? "con-sesion" : "sin-sesion"}
          </p>
          <Link to="/admin">Ir a admin</Link>
        </div>
      );
    },
  };
});

import App from "./App";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

function adminMeCalls() {
  return (fetch as Mock).mock.calls.filter(([url]) => String(url) === "/api/admin/me");
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  authFakes.session = null;
  authFakes.getSessionCalls = 0;
  authFakes.onAuthStateChangeCalls = 0;
  authFakes.unsubscribeCalls = 0;
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AuthProvider global (Bloque 6A)", () => {
  it("una ruta pública sin sesión funciona y consume useAuth(); un solo listener, sin /api/admin/me", async () => {
    renderAt("/terms");

    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent("sin-sesion"),
    );
    expect(authFakes.getSessionCalls).toBe(1);
    expect(authFakes.onAuthStateChangeCalls).toBe(1);
    expect(adminMeCalls()).toHaveLength(0);
    expect(screen.queryByText("Sesión administrativa verificada.")).toBeNull();
  });

  it("una ruta pública ve la sesión global sin consultar /api/admin/me", async () => {
    authFakes.session = { access_token: "at-sintetico", user: { id: "u1" } };
    renderAt("/terms");

    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent("con-sesion"),
    );
    expect(adminMeCalls()).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("público → /admin reutiliza la misma sesión global: sin listeners duplicados y /admin sigue lazy", async () => {
    authFakes.session = { access_token: "at-sintetico", user: { id: "u1" } };
    (fetch as Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ role: "admin" }),
    });
    renderAt("/terms");
    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent("con-sesion"),
    );
    expect(adminMeCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole("link", { name: "Ir a admin" }));

    // Lazy: el shell solo aparece cuando el chunk de /admin carga y /api/admin/me responde.
    expect(
      await screen.findByText("Sesión administrativa verificada."),
    ).toBeInTheDocument();
    expect(adminMeCalls()).toHaveLength(1);
    expect(authFakes.onAuthStateChangeCalls).toBe(1);
    expect(authFakes.unsubscribeCalls).toBe(0);
  });

  it("navegar público → /admin sin sesión no duplica listeners ni llama a /api/admin/me", async () => {
    renderAt("/terms");
    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent("sin-sesion"),
    );

    fireEvent.click(screen.getByRole("link", { name: "Ir a admin" }));

    expect(
      await screen.findByRole("link", { name: /iniciar sesión/i }),
    ).toBeInTheDocument();
    expect(authFakes.onAuthStateChangeCalls).toBe(1);
    expect(adminMeCalls()).toHaveLength(0);
  });

  it("existe un único AuthProvider: desmontar la app cancela exactamente una suscripción", async () => {
    const { unmount } = renderAt("/terms");
    await waitFor(() => expect(authFakes.onAuthStateChangeCalls).toBe(1));

    await act(async () => {});
    unmount();

    expect(authFakes.unsubscribeCalls).toBe(1);
  });

  it("/admin/login sigue funcionando bajo el provider global", async () => {
    renderAt("/admin/login");

    expect(
      await screen.findByRole("heading", { name: "Acceso admin" }),
    ).toBeInTheDocument();
    expect(authFakes.onAuthStateChangeCalls).toBe(1);
  });
});
