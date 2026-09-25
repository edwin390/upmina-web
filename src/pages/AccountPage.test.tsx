import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";

// Fija /account (Bloque 6E): página privada mínima que solo requiere una sesión normal.
// useAuth se mockea (el AuthProvider ya está cubierto por auth-context.test.tsx y
// App.auth.test.tsx); aquí importa cómo reacciona la página.

const USER_ID = "user-id-sintetico-0001";

const authFakes = vi.hoisted(() => ({
  session: null as null | {
    access_token: string;
    refresh_token: string;
    user: { id: string; email?: string; app_metadata: object };
  },
  loading: false,
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: authFakes.session,
    user: authFakes.session?.user ?? null,
    loading: authFakes.loading,
    signOut: async () => {},
  }),
}));

type SignOutResult = { error: unknown };

const supabaseFakes = vi.hoisted(() => ({
  signOutImpl: undefined as (() => Promise<SignOutResult>) | undefined,
  signOutCalls: 0,
  getSessionCalls: 0,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { username: "fan_sintetico", display_name: null, bio: null },
            error: null,
          }),
        }),
      }),
    }),
    auth: {
      async signOut() {
        supabaseFakes.signOutCalls++;
        if (supabaseFakes.signOutImpl) return supabaseFakes.signOutImpl();
        return { error: null };
      },
      async getSession() {
        supabaseFakes.getSessionCalls++;
        // El access token vigente sale de la misma sesión simulada que useAuth.
        return { data: { session: authFakes.session } };
      },
    },
  },
}));

import AccountPage from "./AccountPage";

const CAPABILITIES_BY_ROLE: Record<string, string[]> = {
  admin: ["moderation", "technical", "social_admin", "team_admin"],
  moderator: ["moderation"],
  developer: ["moderation", "technical"],
};

/** Respuesta simulada de GET /api/admin/access (contrato de 9G-1). */
function accessResponse(role: string | null, recent = true) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      role,
      capabilities: role ? CAPABILITIES_BY_ROLE[role] : [],
      mfa: { recent },
    }),
  };
}

function stubAccess(role: string | null, recent = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => accessResponse(role, recent)),
  );
}

function fakeSession(email: string | null = "fan@example.com") {
  return {
    access_token: "token-sintetico-de-prueba",
    refresh_token: "refresh-sintetico-de-prueba",
    user: {
      id: USER_ID,
      email: email ?? undefined,
      app_metadata: { role: "admin-sintetico" },
    },
  };
}

function accountTree() {
  return (
    <QueryClientProvider client={testQueryClient}>
      <MemoryRouter initialEntries={["/account"]}>
        <Routes>
          <Route path="/account" element={<AccountPage />} />
          <Route path="/login" element={<p>Login stub</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderAccount() {
  return render(accountTree());
}

beforeEach(() => {
  testQueryClient.clear();
  authFakes.session = null;
  authFakes.loading = false;
  supabaseFakes.signOutImpl = undefined;
  supabaseFakes.signOutCalls = 0;
  supabaseFakes.getSessionCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => accessResponse(null, false)),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("/account — acceso", () => {
  it("mientras AuthProvider está loading: no muestra contenido privado ni redirige", () => {
    authFakes.loading = true;
    authFakes.session = fakeSession();
    renderAccount();

    expect(screen.getByRole("status")).toHaveTextContent(/comprobando sesión/i);
    expect(screen.queryByRole("button", { name: /cerrar sesión/i })).toBeNull();
    expect(screen.queryByText("fan@example.com")).toBeNull();
    expect(screen.queryByText("Login stub")).toBeNull();
  });

  it("sin sesión: redirige a /login sin mostrar contenido privado", () => {
    renderAccount();

    expect(screen.getByText("Login stub")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cerrar sesión/i })).toBeNull();
  });

  it("con sesión: muestra 'Cuenta', sesión activa y el email de la sesión sin llamadas adicionales", () => {
    authFakes.session = fakeSession("fan@example.com");
    renderAccount();

    expect(screen.getByRole("heading", { name: "Cuenta" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Sesión activa como fan@example.com.",
    );
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeInTheDocument();
    // Única llamada de red permitida: el acceso para presentación (GET /api/admin/access).
    for (const [url] of (fetch as unknown as { mock: { calls: unknown[][] } }).mock
      .calls) {
      expect(String(url)).toBe("/api/admin/access");
    }
  });

  it("sin email en la sesión: muestra solo 'Sesión activa.'", () => {
    authFakes.session = fakeSession(null);
    renderAccount();

    expect(screen.getByRole("status")).toHaveTextContent(/^Sesión activa\.$/);
  });

  it("no muestra user_id, tokens, claims ni rol", () => {
    authFakes.session = fakeSession();
    renderAccount();

    const html = document.body.innerHTML;
    expect(html).not.toContain(USER_ID);
    expect(html).not.toContain("token-sintetico-de-prueba");
    expect(html).not.toContain("refresh-sintetico-de-prueba");
    expect(html).not.toContain("admin-sintetico");
    expect(html).not.toMatch(/admin|moderator|aal/i);
  });
});

describe("/account — logout", () => {
  it("llama signOut exactamente una vez", async () => {
    authFakes.session = fakeSession();
    renderAccount();

    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    await act(async () => {});

    expect(supabaseFakes.signOutCalls).toBe(1);
  });

  it("doble click durante el logout no duplica signOut y muestra el estado pendiente", async () => {
    let resolveSignOut!: (value: SignOutResult) => void;
    supabaseFakes.signOutImpl = () =>
      new Promise((resolve) => {
        resolveSignOut = resolve;
      });
    authFakes.session = fakeSession();
    renderAccount();

    const button = screen.getByRole("button", { name: "Cerrar sesión" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(screen.getByRole("button", { name: /cerrando sesión/i })).toBeDisabled();
    expect(supabaseFakes.signOutCalls).toBe(1);

    await act(async () => {
      resolveSignOut({ error: null });
    });
    expect(supabaseFakes.signOutCalls).toBe(1);
  });

  it("logout exitoso: al desaparecer la sesión global la página redirige a /login", async () => {
    authFakes.session = fakeSession();
    const { rerender } = renderAccount();

    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    await act(async () => {});
    // Efecto del AuthProvider real: onAuthStateChange(SIGNED_OUT) deja session en null.
    authFakes.session = null;
    rerender(accountTree());

    expect(screen.getByText("Login stub")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cerrar sesión/i })).toBeNull();
  });

  it("error de logout: mantiene la cuenta visible y muestra un mensaje genérico", async () => {
    supabaseFakes.signOutImpl = async () => ({
      error: new Error("detalle-interno-proveedor"),
    });
    authFakes.session = fakeSession();
    renderAccount();

    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudo cerrar la sesión. Inténtalo de nuevo.",
    );
    expect(document.body.innerHTML).not.toContain("detalle-interno-proveedor");
    expect(screen.getByRole("heading", { name: "Cuenta" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeEnabled();
  });

  it("excepción en signOut: mensaje genérico y se puede reintentar", async () => {
    supabaseFakes.signOutImpl = async () => {
      throw new Error("red-caida-10.0.0.7");
    };
    authFakes.session = fakeSession();
    renderAccount();

    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no se pudo cerrar la sesión/i,
    );
    expect(document.body.innerHTML).not.toContain("red-caida");

    supabaseFakes.signOutImpl = undefined;
    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    await act(async () => {});

    expect(supabaseFakes.signOutCalls).toBe(2);
  });

  it("bajo React StrictMode el logout sigue funcionando (una sola llamada)", async () => {
    authFakes.session = fakeSession();
    render(<StrictMode>{accountTree()}</StrictMode>);

    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    await act(async () => {});

    expect(supabaseFakes.signOutCalls).toBe(1);
  });
});

describe("/account — Panel de administración (9G-3): presentación según GET /api/admin/access", () => {
  const ADMIN_LINK = { name: "Panel de administración" };

  async function settle() {
    // Deja resolver la consulta de acceso antes de afirmar la AUSENCIA de algo.
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  function expectNoPrivilegedUi() {
    expect(screen.queryByRole("link", ADMIN_LINK)).toBeNull();
    expect(screen.queryByText(/panel de administración/i)).toBeNull();
    expect(screen.queryByText(/moderad/i)).toBeNull();
    expect(screen.queryByText(/developer|desarrollad/i)).toBeNull();
    expect(screen.queryByText(/solo (para )?admin/i)).toBeNull();
    expect(screen.queryByRole("link", { name: /admin/i })).toBeNull();
  }

  it("ADMIN (sin MFA reciente): el enlace se muestra, sin exigir MFA para mostrarlo", async () => {
    authFakes.session = fakeSession();
    stubAccess("admin", false);
    renderAccount();

    const link = await screen.findByRole("link", ADMIN_LINK);
    expect(link).toHaveAttribute("href", "/admin");
  });

  it("ADMIN (MFA reciente): el enlace navega a /admin", async () => {
    authFakes.session = fakeSession();
    stubAccess("admin", true);
    render(
      <QueryClientProvider client={testQueryClient}>
        <MemoryRouter initialEntries={["/account"]}>
          <Routes>
            <Route path="/account" element={<AccountPage />} />
            <Route path="/admin" element={<p>Admin stub</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("link", ADMIN_LINK));
    expect(await screen.findByText("Admin stub")).toBeInTheDocument();
  });

  it("USER (role null): cero UI privilegiada, ni placeholders ni botones deshabilitados", async () => {
    authFakes.session = fakeSession();
    stubAccess(null, false);
    renderAccount();
    await settle();

    expectNoPrivilegedUi();
  });

  it("USER con aal2 y MFA reciente sigue sin ver nada privilegiado (MFA no concede rol)", async () => {
    authFakes.session = fakeSession();
    stubAccess(null, true);
    renderAccount();
    await settle();

    expectNoPrivilegedUi();
  });

  it("MODERATOR: no ve el panel ni ningún placeholder de moderación", async () => {
    authFakes.session = fakeSession();
    stubAccess("moderator", true);
    renderAccount();
    await settle();

    expectNoPrivilegedUi();
  });

  it("DEVELOPER: no ve el panel ni ningún placeholder de developer", async () => {
    authFakes.session = fakeSession();
    stubAccess("developer", true);
    renderAccount();
    await settle();

    expectNoPrivilegedUi();
  });

  it("mientras el acceso carga no se muestra el enlace (sin destello privilegiado)", async () => {
    authFakes.session = fakeSession();
    let release: (v: unknown) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((resolve) => (release = resolve))),
    );
    renderAccount();

    expect(screen.queryByRole("link", ADMIN_LINK)).toBeNull();
    // La petición sale tras leer la sesión: se espera a que esté en vuelo antes de resolverla.
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("link", ADMIN_LINK)).toBeNull();
    await act(async () => {
      release(accessResponse("admin", true));
    });
    expect(await screen.findByRole("link", ADMIN_LINK)).toBeInTheDocument();
  });

  it.each([
    ["error 500", async () => ({ ok: false, status: 500, json: async () => ({}) })],
    ["401", async () => ({ ok: false, status: 401, json: async () => ({}) })],
    ["fallo de red", async () => Promise.reject(new TypeError("red"))],
    ["JSON inválido", async () => ({ ok: true, status: 200, json: async () => "x" })],
    [
      "rol desconocido",
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          role: "superadmin",
          capabilities: [],
          mfa: { recent: true },
        }),
      }),
    ],
    [
      "USER con capacidades",
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          role: null,
          capabilities: ["team_admin"],
          mfa: { recent: true },
        }),
      }),
    ],
  ])("acceso con %s → falla cerrado: sin enlace ni UI privilegiada", async (_n, impl) => {
    authFakes.session = fakeSession();
    vi.stubGlobal("fetch", vi.fn(impl));
    renderAccount();
    await settle();

    expectNoPrivilegedUi();
    // La cuenta sigue usable: el error de acceso no rompe la página.
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeInTheDocument();
  });

  it("el enlace no depende de datos locales: app_metadata.role del cliente no lo muestra", async () => {
    authFakes.session = fakeSession(); // app_metadata: { role: "admin-sintetico" }
    stubAccess(null, true);
    renderAccount();
    await settle();

    expect(screen.queryByRole("link", ADMIN_LINK)).toBeNull();
  });

  it("no consulta el acceso sin sesión (redirige a /login)", async () => {
    authFakes.session = null;
    renderAccount();

    expect(await screen.findByText("Login stub")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cambio de usuario: el estado de acceso del usuario anterior no se reutiliza", async () => {
    authFakes.session = fakeSession();
    stubAccess("admin", true);
    const view = renderAccount();
    expect(await screen.findByRole("link", ADMIN_LINK)).toBeInTheDocument();

    // Otra cuenta (sin rol) en la misma pestaña: la clave de caché incluye el user.id.
    authFakes.session = {
      ...fakeSession("otra@example.com"),
      user: { id: "user-id-sintetico-0002", email: "otra@example.com", app_metadata: {} },
    };
    stubAccess(null, false);
    view.rerender(accountTree());

    await waitFor(() => expect(screen.queryByRole("link", ADMIN_LINK)).toBeNull());
  });

  it("cerrar la sesión no deja el enlace visible", async () => {
    authFakes.session = fakeSession();
    stubAccess("admin", true);
    const view = renderAccount();
    expect(await screen.findByRole("link", ADMIN_LINK)).toBeInTheDocument();

    authFakes.session = null;
    view.rerender(accountTree());

    expect(await screen.findByText("Login stub")).toBeInTheDocument();
    expect(screen.queryByRole("link", ADMIN_LINK)).toBeNull();
  });
});
