import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

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
        return { data: { session: null } };
      },
    },
  },
}));

import AccountPage from "./AccountPage";

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
    <MemoryRouter initialEntries={["/account"]}>
      <Routes>
        <Route path="/account" element={<AccountPage />} />
        <Route path="/login" element={<p>Login stub</p>} />
      </Routes>
    </MemoryRouter>
  );
}

function renderAccount() {
  return render(accountTree());
}

beforeEach(() => {
  authFakes.session = null;
  authFakes.loading = false;
  supabaseFakes.signOutImpl = undefined;
  supabaseFakes.signOutCalls = 0;
  supabaseFakes.getSessionCalls = 0;
  vi.stubGlobal("fetch", vi.fn());
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
    expect(supabaseFakes.getSessionCalls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
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
