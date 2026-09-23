import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AuthResponse } from "@supabase/supabase-js";

// Fija /admin/signup (Bloque 3A): render, contraseñas distintas, submit correcto (sin
// metadata de rol), flujo de confirmación de email, error seguro (nunca el texto crudo
// del proveedor) y la navegación hacia /admin/login. Una cuenta nueva sigue siendo USER
// sin privilegios: esta página nunca decide ni envía ningún rol.

const supabaseFakes = vi.hoisted(() => ({
  signUpResult: undefined as { error: unknown } | undefined,
  signUpCalls: [] as unknown[],
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      async signUp(payload: unknown) {
        supabaseFakes.signUpCalls.push(payload);
        return supabaseFakes.signUpResult ?? { error: null };
      },
    },
  },
}));

import AdminSignupPage from "./AdminSignupPage";
import AdminLoginPage from "./AdminLoginPage";

function resetFakes() {
  supabaseFakes.signUpResult = undefined;
  supabaseFakes.signUpCalls = [];
}

function renderSignup() {
  return render(
    <MemoryRouter initialEntries={["/admin/signup"]}>
      <Routes>
        <Route path="/admin/signup" element={<AdminSignupPage />} />
        <Route path="/admin/login" element={<AdminLoginPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const VALID_PASSWORD = "una-contraseña-válida";

function fillAndSubmit(
  email: string,
  password: string,
  confirmPassword: string = password,
) {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Contraseña"), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText("Confirmar contraseña"), {
    target: { value: confirmPassword },
  });
  fireEvent.click(screen.getByRole("button", { name: /crear cuenta/i }));
}

beforeEach(() => {
  resetFakes();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// AdminLoginPage usa useAuth(); sin mockear @/lib/auth-context aquí (este archivo no lo
// necesita para signup), pero como el mismo módulo de rutas la monta al navegar,
// AdminLoginPage debe poder renderizar contra el AuthProvider real. Para mantener esta
// prueba enfocada en signup, no se monta AdminLoginPage bajo AuthProvider; en su lugar
// solo se comprueba el título al navegar (ver test "ofrece navegación hacia
// /admin/login" más abajo), que no requiere useAuth si login mockea su propio contexto.
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: null, user: null, loading: false, signOut: vi.fn() }),
}));

describe("AdminSignupPage", () => {
  it("renderiza email, contraseña, confirmación y el botón de submit", () => {
    renderSignup();

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Contraseña")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirmar contraseña")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /crear cuenta/i })).toBeInTheDocument();
  });

  it("conserva la validación HTML nativa: campos required, email type=email, contraseña con minLength, sin noValidate", () => {
    renderSignup();

    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Contraseña");
    const confirmPassword = screen.getByLabelText("Confirmar contraseña");

    expect(email).toBeRequired();
    expect(email).toHaveAttribute("type", "email");
    expect(password).toBeRequired();
    expect(password).toHaveAttribute("minLength", "8");
    expect(confirmPassword).toBeRequired();
    expect(email.closest("form")).not.toHaveAttribute("novalidate");
  });

  it("contraseñas distintas → error, sin llamar a signUp", async () => {
    renderSignup();

    fillAndSubmit("fan@example.com", VALID_PASSWORD, "otra-contraseña");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Las contraseñas no coinciden.");
    expect(supabaseFakes.signUpCalls).toHaveLength(0);
  });

  it("contraseña demasiado corta → error, sin llamar a signUp", async () => {
    renderSignup();

    fillAndSubmit("fan@example.com", "corta1", "corta1");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/al menos/i);
    expect(supabaseFakes.signUpCalls).toHaveLength(0);
  });

  it("submit correcto: llama a signUp con email/contraseña, sin ningún metadata de rol", async () => {
    renderSignup();

    fillAndSubmit("fan@example.com", VALID_PASSWORD);

    await waitFor(() => expect(supabaseFakes.signUpCalls).toHaveLength(1));
    expect(supabaseFakes.signUpCalls[0]).toEqual({
      email: "fan@example.com",
      password: VALID_PASSWORD,
    });
    expect(JSON.stringify(supabaseFakes.signUpCalls[0])).not.toMatch(
      /role|admin|moderator/i,
    );
  });

  it("loading/disabled durante el submit", async () => {
    let resolveSignUp: (value: AuthResponse) => void = () => {};
    const authClient = (await import("@/lib/supabase")).supabase!.auth;
    supabaseFakes.signUpResult = undefined;
    vi.spyOn(authClient, "signUp").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSignUp = resolve;
        }),
    );

    renderSignup();
    fillAndSubmit("fan@example.com", VALID_PASSWORD);

    const button = await screen.findByRole("button", { name: /creando cuenta/i });
    expect(button).toBeDisabled();

    resolveSignUp({ data: { user: null, session: null }, error: null });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /creando cuenta/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("flujo de confirmación de email: éxito muestra el mensaje de revisar el email, no el formulario", async () => {
    renderSignup();

    fillAndSubmit("fan@example.com", VALID_PASSWORD);

    await screen.findByRole("heading", { name: "Revisa tu email" });
    expect(screen.getByText("fan@example.com")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("error de signup: email ya registrado → mensaje entendible, nunca el texto crudo del proveedor", async () => {
    supabaseFakes.signUpResult = { error: new Error("User already registered") };
    renderSignup();

    fillAndSubmit("fan@example.com", VALID_PASSWORD);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Ya existe una cuenta con ese email.");
    expect(alert.textContent).not.toMatch(/already registered/i);
  });

  it("error de signup desconocido → mensaje genérico, nunca el texto crudo del proveedor", async () => {
    supabaseFakes.signUpResult = {
      error: new Error('relation "auth.users" violates constraint xyz'),
    };
    renderSignup();

    fillAndSubmit("fan@example.com", VALID_PASSWORD);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("No se pudo crear la cuenta. Inténtalo de nuevo.");
    expect(alert.textContent).not.toMatch(/relation|constraint/i);
  });

  it("ofrece navegación hacia /admin/login", async () => {
    renderSignup();

    fireEvent.click(screen.getByRole("link", { name: /iniciar sesión/i }));

    expect(
      await screen.findByRole("heading", { name: "Acceso admin" }),
    ).toBeInTheDocument();
  });
});
