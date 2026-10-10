import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

// Fija /signup (Bloque 6D): registro público email + contraseña sobre el cliente Supabase
// existente. useAuth se mockea (el AuthProvider ya está cubierto por auth-context.test.tsx
// y App.auth.test.tsx); aquí importa cómo reacciona la página.

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
    refreshSession: async () => {},
  }),
}));

type SignUpResult = { data?: unknown; error: unknown };

const supabaseFakes = vi.hoisted(() => ({
  signUpImpl: undefined as (() => Promise<SignUpResult>) | undefined,
  signUpCalls: [] as unknown[],
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      async signUp(args: unknown) {
        supabaseFakes.signUpCalls.push(args);
        if (supabaseFakes.signUpImpl) return supabaseFakes.signUpImpl();
        return { data: { session: null }, error: null };
      },
    },
  },
}));

import SignupPage from "./SignupPage";

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function signupTree() {
  return (
    <MemoryRouter initialEntries={["/signup"]}>
      <Routes>
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/login" element={<p>Login stub</p>} />
        <Route path="/" element={<p>Home stub</p>} />
        <Route path="/account" element={<p>Account stub</p>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  );
}

function renderSignup() {
  return render(signupTree());
}

function fill(email: string, password: string, confirm: string) {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Confirmar contraseña"), {
    target: { value: confirm },
  });
}

function submitForm() {
  fireEvent.submit(screen.getByLabelText("Email").closest("form")!);
}

function fillAndSubmit(
  email = "fan@example.com",
  password = "clave-sintetica-1",
  confirm = password,
) {
  fill(email, password, confirm);
  submitForm();
}

beforeEach(() => {
  localStorage.setItem("upmina:locale", "en");
  authFakes.session = null;
  authFakes.loading = false;
  supabaseFakes.signUpImpl = undefined;
  supabaseFakes.signUpCalls = [];
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("/signup — estados", () => {
  it("mientras AuthProvider está loading no aparece el formulario", () => {
    authFakes.loading = true;
    renderSignup();

    expect(screen.getByRole("status")).toHaveTextContent(/comprobando sesión/i);
    expect(screen.queryByLabelText("Email")).toBeNull();
  });

  it("sesión ya existente: redirige a / sin mostrar el formulario", () => {
    authFakes.session = { user: { email: "fan@example.com" } };
    renderSignup();

    expect(screen.getByText("Home stub")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).toBeNull();
  });

  it("visitante: ve Email, Contraseña, Confirmar contraseña y 'Crear cuenta'", () => {
    renderSignup();

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Contraseña")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirmar contraseña")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Crear cuenta" })).toBeInTheDocument();
  });

  it("'Ya tengo una cuenta' navega a /login", () => {
    renderSignup();

    fireEvent.click(screen.getByRole("link", { name: "Ya tengo una cuenta" }));

    expect(screen.getByTestId("location")).toHaveTextContent("/login");
  });
});

describe("/signup — validación cliente", () => {
  it("contraseñas distintas: no llama signUp y muestra un error controlado", async () => {
    renderSignup();
    fillAndSubmit("fan@example.com", "clave-sintetica-1", "otra-clave-sintetica");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Las contraseñas no coinciden.",
    );
    expect(supabaseFakes.signUpCalls).toHaveLength(0);
  });

  it("campos vacíos: no llama signUp", async () => {
    renderSignup();
    fillAndSubmit("", "", "");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Completa todos los campos.",
    );
    expect(supabaseFakes.signUpCalls).toHaveLength(0);
  });
});

describe("/signup — registro", () => {
  it("registro válido: signUp una sola vez con SOLO email y password (sin metadata ni roles) y muestra 'revisa tu correo'", async () => {
    renderSignup();
    fillAndSubmit("fan@example.com", "clave-sintetica-1");

    // AUTH-1: "Check your inbox" con el email usado y el aviso de Spam/Junk.
    expect(await screen.findByText("Check your inbox")).toBeInTheDocument();
    expect(
      screen.getByText(/We sent a confirmation link to fan@example\.com\./),
    ).toBeTruthy();
    expect(screen.getByText(/Check your Spam or Junk folder\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: /resend/i })).toBeInTheDocument();
    // Solo email + password; el único option es el retorno del enlace (/login). Sin `data` (roles/metadata).
    expect(supabaseFakes.signUpCalls).toEqual([
      {
        email: "fan@example.com",
        password: "clave-sintetica-1",
        options: { emailRedirectTo: `${window.location.origin}/login` },
      },
    ]);
    expect(JSON.stringify(supabaseFakes.signUpCalls)).not.toContain('"data"');
    expect(screen.queryByLabelText("Email")).toBeNull();
    // No asume sesión ni navega a ningún sitio (ni /admin ni /).
    expect(screen.getByTestId("location")).toHaveTextContent("/signup");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("mientras está pendiente: deshabilita el envío y no permite doble submit", async () => {
    let resolveSignUp!: (value: SignUpResult) => void;
    supabaseFakes.signUpImpl = () =>
      new Promise((resolve) => {
        resolveSignUp = resolve;
      });
    renderSignup();

    fillAndSubmit();
    expect(screen.getByRole("button", { name: /creando cuenta/i })).toBeDisabled();
    submitForm();
    submitForm();

    expect(supabaseFakes.signUpCalls).toHaveLength(1);

    await act(async () => {
      resolveSignUp({ error: null });
    });
    expect(await screen.findByText("Check your inbox")).toBeInTheDocument();
    expect(supabaseFakes.signUpCalls).toHaveLength(1);
  });

  it("un intento fallido libera el bloqueo: el segundo intento legítimo sí se envía", async () => {
    supabaseFakes.signUpImpl = async () => ({ error: new Error("fallo-interno") });
    renderSignup();
    fillAndSubmit();
    await screen.findByRole("alert");

    supabaseFakes.signUpImpl = undefined;
    submitForm();

    expect(await screen.findByText("Check your inbox")).toBeInTheDocument();
    expect(supabaseFakes.signUpCalls).toHaveLength(2);
  });

  it("desmontar con signUp pendiente: al resolver no hay setState ni errores React", async () => {
    let resolveSignUp!: (value: SignUpResult) => void;
    supabaseFakes.signUpImpl = () =>
      new Promise((resolve) => {
        resolveSignUp = resolve;
      });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderSignup();
    fillAndSubmit();
    unmount();

    await act(async () => {
      resolveSignUp({ error: new Error("tardio") });
    });

    expect(document.body.innerHTML).toBe("<div></div>");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("bajo React StrictMode el registro sigue funcionando (una sola llamada)", async () => {
    render(<StrictMode>{signupTree()}</StrictMode>);
    fillAndSubmit();

    expect(await screen.findByText("Check your inbox")).toBeInTheDocument();
    expect(supabaseFakes.signUpCalls).toHaveLength(1);
  });
});

describe("/signup — errores de Supabase", () => {
  it("contraseña rechazada por política: mensaje público sin el detalle del proveedor", async () => {
    supabaseFakes.signUpImpl = async () => ({
      error: Object.assign(
        new Error("Password should contain detalle-interno-politica"),
        {
          code: "weak_password",
        },
      ),
    });
    renderSignup();
    fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "La contraseña no cumple los requisitos de seguridad.",
    );
    expect(document.body.innerHTML).not.toContain("detalle-interno-politica");
  });

  it("email ya registrado: mensaje genérico que no revela si la cuenta existe", async () => {
    supabaseFakes.signUpImpl = async () => ({
      error: new Error("User already registered (detalle-interno-proveedor)"),
    });
    renderSignup();
    fillAndSubmit();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No se pudo crear la cuenta. Inténtalo de nuevo.");
    expect(alert).not.toHaveTextContent(/registrad|existe|already/i);
    expect(document.body.innerHTML).not.toContain("detalle-interno-proveedor");
  });

  it("excepción inesperada: mensaje genérico, sin detalles internos", async () => {
    supabaseFakes.signUpImpl = async () => {
      throw new Error("db-connection-refused-10.0.0.7");
    };
    renderSignup();
    fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudo crear la cuenta. Inténtalo de nuevo.",
    );
    expect(document.body.innerHTML).not.toContain("db-connection-refused");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("/signup — AUTH-1: pendiente de confirmación", () => {
  it("signUp con session:null: el email mostrado es el normalizado y no queda ninguna contraseña en pantalla", async () => {
    renderSignup();
    fillAndSubmit("  fan@example.com  ", "clave-sintetica-1");

    expect(await screen.findByText(/fan@example\.com\./)).toBeTruthy();
    expect(document.body.textContent).not.toContain("clave-sintetica-1");
    expect(document.querySelector("input[type=password]")).toBeNull();
  });

  it("pendiente → autenticado: al llegar la sesión (otra pestaña confirmó) continúa en /account sin recargar", async () => {
    const view = renderSignup();
    fillAndSubmit();
    expect(await screen.findByText("Check your inbox")).toBeInTheDocument();

    authFakes.session = { user: { email: "fan@example.com" } };
    view.rerender(signupTree());

    expect(screen.getByText("Account stub")).toBeInTheDocument();
    expect(screen.queryByText("Check your inbox")).toBeNull();
  });

  it("sin pendiente, una sesión previa sigue yendo a / (comportamiento existente)", () => {
    authFakes.session = { user: { email: "fan@example.com" } };
    renderSignup();
    expect(screen.getByText("Home stub")).toBeInTheDocument();
  });

  it("error normal de signUp sigue mostrando el mensaje genérico y NO el estado pendiente", async () => {
    supabaseFakes.signUpImpl = async () => ({ error: new Error("boom") });
    renderSignup();
    fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudo crear la cuenta. Inténtalo de nuevo.",
    );
    expect(screen.queryByText("Check your inbox")).toBeNull();
  });
});
