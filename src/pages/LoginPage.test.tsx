import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";

// Fija /login (Bloque 6C): formulario público email + contraseña sobre el cliente
// Supabase existente. useAuth se mockea (el AuthProvider ya está cubierto por
// auth-context.test.tsx y App.auth.test.tsx); aquí importa cómo reacciona la página.

const authFakes = vi.hoisted(() => ({
  session: null as { user: { email: string } } | null,
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

const supabaseFakes = vi.hoisted(() => ({
  signInImpl: undefined as (() => Promise<{ error: unknown }>) | undefined,
  signInCalls: [] as { email: string; password: string }[],
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      async signInWithPassword(credentials: { email: string; password: string }) {
        supabaseFakes.signInCalls.push(credentials);
        if (supabaseFakes.signInImpl) return supabaseFakes.signInImpl();
        return { error: null };
      },
    },
  },
}));

import LoginPage from "./LoginPage";

function loginTree() {
  return (
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <div>
              <p>Home stub</p>
              <Link to="/otra">Ir a otra</Link>
            </div>
          }
        />
        <Route path="/otra" element={<p>Otra stub</p>} />
        <Route path="/signup" element={<p>Signup stub</p>} />
      </Routes>
    </MemoryRouter>
  );
}

function renderLogin() {
  return render(loginTree());
}

function fillAndSubmit(email = "fan@example.com", password = "clave-sintetica-1") {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: password } });
  fireEvent.submit(
    screen.getByRole("button", { name: /iniciar sesión/i }).closest("form")!,
  );
}

beforeEach(() => {
  authFakes.session = null;
  authFakes.loading = false;
  supabaseFakes.signInImpl = undefined;
  supabaseFakes.signInCalls = [];
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/login — estados", () => {
  it("mientras AuthProvider está loading no aparece el formulario", () => {
    authFakes.loading = true;
    renderLogin();

    expect(screen.getByRole("status")).toHaveTextContent(/comprobando sesión/i);
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByRole("button", { name: /iniciar sesión/i })).toBeNull();
  });

  it("visitante: ve Email, Contraseña y el botón 'Iniciar sesión'", () => {
    renderLogin();

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Contraseña")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /iniciar sesión/i })).toBeInTheDocument();
  });

  it("'Crear cuenta' es un enlace SPA a /signup", () => {
    renderLogin();

    const link = screen.getByRole("link", { name: "Crear cuenta" });
    expect(link).toHaveAttribute("href", "/signup");
    fireEvent.click(link);

    expect(screen.getByText("Signup stub")).toBeInTheDocument();
  });

  it("sesión ya existente: redirige a / sin mostrar el formulario", () => {
    authFakes.session = { user: { email: "fan@example.com" } };
    renderLogin();

    expect(screen.getByText("Home stub")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).toBeNull();
  });
});

describe("/login — envío", () => {
  it("submit válido: llama signInWithPassword una sola vez con email/password y navega a /", async () => {
    renderLogin();
    fillAndSubmit("fan@example.com", "clave-sintetica-1");

    expect(await screen.findByText("Home stub")).toBeInTheDocument();
    expect(supabaseFakes.signInCalls).toEqual([
      { email: "fan@example.com", password: "clave-sintetica-1" },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("mientras está pendiente: deshabilita el envío y no permite doble submit", async () => {
    let resolveSignIn!: (value: { error: unknown }) => void;
    supabaseFakes.signInImpl = () =>
      new Promise((resolve) => {
        resolveSignIn = resolve;
      });
    renderLogin();

    fillAndSubmit();
    const form = screen
      .getByRole("button", { name: /iniciando sesión/i })
      .closest("form")!;
    expect(screen.getByRole("button", { name: /iniciando sesión/i })).toBeDisabled();
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(supabaseFakes.signInCalls).toHaveLength(1);

    await act(async () => {
      resolveSignIn({ error: null });
    });
    expect(await screen.findByText("Home stub")).toBeInTheDocument();
    expect(supabaseFakes.signInCalls).toHaveLength(1);
  });

  it("bajo React StrictMode el login sigue funcionando (una sola llamada, navega a /)", async () => {
    render(<StrictMode>{loginTree()}</StrictMode>);
    fillAndSubmit();

    expect(await screen.findByText("Home stub")).toBeInTheDocument();
    expect(supabaseFakes.signInCalls).toHaveLength(1);
  });

  it("un intento fallido libera el bloqueo: el segundo intento legítimo sí se envía", async () => {
    supabaseFakes.signInImpl = async () => ({
      error: new Error("Invalid login credentials"),
    });
    renderLogin();
    fillAndSubmit();
    await screen.findByRole("alert");

    supabaseFakes.signInImpl = undefined;
    fillAndSubmit("fan@example.com", "clave-sintetica-2");

    expect(await screen.findByText("Home stub")).toBeInTheDocument();
    expect(supabaseFakes.signInCalls).toHaveLength(2);
  });

  it("si la sesión global ya redirigió a / mientras el login estaba pendiente, al resolver no vuelve a navegar", async () => {
    let resolveSignIn!: (value: { error: unknown }) => void;
    supabaseFakes.signInImpl = () =>
      new Promise((resolve) => {
        resolveSignIn = resolve;
      });
    const { rerender } = renderLogin();
    fillAndSubmit();

    // onAuthStateChange llega ANTES de que resuelva signInWithPassword: el Navigate por
    // sesión desmonta /login. La persona sigue navegando a otra ruta.
    authFakes.session = { user: { email: "fan@example.com" } };
    rerender(loginTree());
    fireEvent.click(await screen.findByText("Ir a otra"));
    expect(await screen.findByText("Otra stub")).toBeInTheDocument();

    await act(async () => {
      resolveSignIn({ error: null });
    });

    expect(screen.getByText("Otra stub")).toBeInTheDocument();
    expect(screen.queryByText("Home stub")).toBeNull();
  });

  it("credenciales inválidas: mensaje genérico sin filtrar el texto del proveedor", async () => {
    supabaseFakes.signInImpl = async () => ({
      error: new Error("Invalid login credentials (detalle-interno-proveedor)"),
    });
    renderLogin();
    fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Email o contraseña incorrectos.",
    );
    expect(document.body.innerHTML).not.toContain("detalle-interno-proveedor");
    expect(screen.queryByText("Home stub")).toBeNull();
    expect(screen.getByRole("button", { name: /iniciar sesión/i })).toBeEnabled();
  });

  it("'email no confirmado' no se distingue: mensaje genérico (sin enumeración de cuentas)", async () => {
    supabaseFakes.signInImpl = async () => ({ error: new Error("Email not confirmed") });
    renderLogin();
    fillAndSubmit();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No se pudo iniciar sesión. Inténtalo de nuevo.");
    expect(alert).not.toHaveTextContent(/confirm/i);
  });

  it("error inesperado (excepción): mensaje genérico, sin detalles internos", async () => {
    supabaseFakes.signInImpl = async () => {
      throw new Error("db-connection-refused-10.0.0.7");
    };
    renderLogin();
    fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudo iniciar sesión. Inténtalo de nuevo.",
    );
    expect(document.body.innerHTML).not.toContain("db-connection-refused");
    expect(screen.queryByText("Home stub")).toBeNull();
  });

  it("no llama a /api/admin/me ni renderiza tokens ni datos internos", async () => {
    supabaseFakes.signInImpl = async () => ({
      error: new Error("Invalid login credentials"),
    });
    renderLogin();
    fillAndSubmit("fan@example.com", "clave-sintetica-1");
    await screen.findByRole("alert");

    expect(fetch).not.toHaveBeenCalled();
    // Texto visible (el value de un input controlado sí vive en su atributo, como en
    // cualquier formulario): no debe haber tokens ni la contraseña como contenido.
    expect(document.body.textContent).not.toContain("clave-sintetica-1");
    expect(document.body.innerHTML).not.toMatch(/access_token|refresh_token|Bearer/i);
    await waitFor(() => expect(screen.getByLabelText("Contraseña")).toBeEnabled());
  });
});
