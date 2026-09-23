import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// Fija /admin/login (Bloque 3A): render, validación básica del navegador (required),
// submit correcto, error seguro (nunca el texto crudo del proveedor), loading/disabled
// durante el submit, éxito (la sesión se refleja vía useAuth, no por navegación a un
// dashboard inexistente) y la navegación hacia /admin/signup. useAuth se mockea aquí
// (ya cubierto en profundidad por auth-context.test.tsx); solo importa cómo la página
// reacciona a lo que expone.

const authFakes = vi.hoisted(() => ({
  session: null as { user: { email: string } } | null,
  loading: false,
  signOutCalls: 0,
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: authFakes.session,
    user: authFakes.session?.user ?? null,
    loading: authFakes.loading,
    signOut: async () => {
      authFakes.signOutCalls++;
    },
  }),
}));

const supabaseFakes = vi.hoisted(() => ({
  signInResult: undefined as { error: unknown } | undefined,
  /** Si está definida, sustituye por completo la resolución de signInWithPassword
   *  (permite dejar la promesa pendiente a propósito para probar el estado loading). */
  signInImpl: undefined as (() => Promise<{ error: unknown }>) | undefined,
  signInCalls: [] as { email: string; password: string }[],
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      async signInWithPassword(credentials: { email: string; password: string }) {
        supabaseFakes.signInCalls.push(credentials);
        if (supabaseFakes.signInImpl) return supabaseFakes.signInImpl();
        return supabaseFakes.signInResult ?? { error: null };
      },
    },
  },
}));

import AdminLoginPage from "./AdminLoginPage";
import AdminSignupPage from "./AdminSignupPage";

function resetFakes() {
  authFakes.session = null;
  authFakes.loading = false;
  authFakes.signOutCalls = 0;
  supabaseFakes.signInResult = undefined;
  supabaseFakes.signInImpl = undefined;
  supabaseFakes.signInCalls = [];
}

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/admin/login"]}>
      <Routes>
        <Route path="/admin/login" element={<AdminLoginPage />} />
        <Route path="/admin/signup" element={<AdminSignupPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function fillAndSubmit(email: string, password: string) {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Contraseña"), {
    target: { value: password },
  });
  fireEvent.click(screen.getByRole("button", { name: /iniciar sesión/i }));
}

beforeEach(() => {
  resetFakes();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AdminLoginPage", () => {
  it("renderiza email, contraseña y el botón de submit", () => {
    renderLogin();

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Contraseña")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /iniciar sesión/i })).toBeInTheDocument();
  });

  it("los campos son required (validación básica del navegador)", () => {
    renderLogin();

    expect(screen.getByLabelText("Email")).toBeRequired();
    expect(screen.getByLabelText("Contraseña")).toBeRequired();
  });

  it("el formulario conserva la validación HTML nativa: sin noValidate, y el campo email es type=email", () => {
    renderLogin();

    expect(screen.getByLabelText("Email")).toHaveAttribute("type", "email");
    expect(screen.getByLabelText("Email").closest("form")).not.toHaveAttribute(
      "novalidate",
    );
  });

  it("submit correcto: llama a signInWithPassword con email y contraseña exactos", async () => {
    renderLogin();

    fillAndSubmit("fan@example.com", "una-contraseña-válida");

    await waitFor(() => expect(supabaseFakes.signInCalls).toHaveLength(1));
    expect(supabaseFakes.signInCalls[0]).toEqual({
      email: "fan@example.com",
      password: "una-contraseña-válida",
    });
  });

  it("loading/disabled durante el submit: el botón se deshabilita y cambia su texto", async () => {
    let resolveSignIn: (value: { error: null }) => void = () => {};
    supabaseFakes.signInImpl = () =>
      new Promise((resolve) => {
        resolveSignIn = resolve;
      });

    renderLogin();
    fillAndSubmit("fan@example.com", "una-contraseña-válida");

    const button = await screen.findByRole("button", { name: /iniciando sesión/i });
    expect(button).toBeDisabled();

    resolveSignIn({ error: null });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /iniciando sesión/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("error de login: credenciales inválidas → mensaje entendible, nunca el texto crudo del proveedor", async () => {
    supabaseFakes.signInResult = {
      error: new Error("Invalid login credentials"),
    };
    renderLogin();

    fillAndSubmit("fan@example.com", "contraseña-incorrecta");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Email o contraseña incorrectos.");
    expect(alert.textContent).not.toMatch(/Invalid login credentials/);
  });

  it("error de login desconocido → mensaje genérico, nunca el texto crudo del proveedor", async () => {
    supabaseFakes.signInResult = {
      error: new Error("connection terminated unexpectedly: internal db detail"),
    };
    renderLogin();

    fillAndSubmit("fan@example.com", "una-contraseña-válida");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("No se pudo iniciar sesión. Inténtalo de nuevo.");
    expect(alert.textContent).not.toMatch(/connection terminated|internal db detail/);
  });

  it("sesión ya autenticada (useAuth.session): muestra el email y un botón de cerrar sesión, no el formulario", () => {
    authFakes.session = { user: { email: "admin@example.com" } };
    renderLogin();

    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /cerrar sesión/i }));
    expect(authFakes.signOutCalls).toBe(1);
  });

  it("loading inicial de sesión: muestra un estado de comprobación, no el formulario", () => {
    authFakes.loading = true;
    renderLogin();

    expect(screen.getByRole("status")).toHaveTextContent(/comprobando sesión/i);
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("ofrece navegación hacia /admin/signup", () => {
    renderLogin();

    fireEvent.click(screen.getByRole("link", { name: /crear cuenta/i }));

    expect(screen.getByRole("heading", { name: "Crear cuenta" })).toBeInTheDocument();
  });
});
