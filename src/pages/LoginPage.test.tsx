import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

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
    refreshSession: async () => {},
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

function loginTree(entry = "/login") {
  return (
    <MemoryRouter initialEntries={[entry]}>
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
        <Route path="/admin" element={<p>Admin stub</p>} />
        <Route path="/admin/activate" element={<p>Activate stub</p>} />
        <Route path="/account" element={<p>Account stub</p>} />
        <Route path="/community" element={<p>Comunidad stub</p>} />
        <Route path="/cosplay" element={<p>Cosplay stub</p>} />
      </Routes>
    </MemoryRouter>
  );
}

function renderLogin(entry = "/login") {
  return render(loginTree(entry));
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

  it("email_not_confirmed: muestra el estado pendiente con el email escrito, sin el texto bruto del proveedor ni la contraseña", async () => {
    localStorage.setItem("upmina:locale", "en");
    supabaseFakes.signInImpl = async () => ({
      error: Object.assign(new Error("Email not confirmed"), {
        code: "email_not_confirmed",
      }),
    });
    renderLogin();
    fillAndSubmit("fan@example.com", "clave-sintetica-1");

    expect(await screen.findByText("Check your inbox")).toBeInTheDocument();
    expect(screen.getByText(/fan@example\.com hasn't been confirmed yet\./)).toBeTruthy();
    expect(screen.getByText(/Spam or Junk/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /resend/i })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Email not confirmed");
    expect(document.body.textContent).not.toContain("clave-sintetica-1");
    expect(document.querySelector("input[type=password]")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    localStorage.clear();
  });

  it("email_not_confirmed (solo mensaje, sin code): también activa el estado pendiente", async () => {
    localStorage.setItem("upmina:locale", "en");
    supabaseFakes.signInImpl = async () => ({ error: new Error("Email not confirmed") });
    renderLogin();
    fillAndSubmit();

    expect(await screen.findByText("Check your inbox")).toBeInTheDocument();
    localStorage.clear();
  });

  it("pendiente: 'Use a different account' vuelve al formulario vacío de contraseña", async () => {
    localStorage.setItem("upmina:locale", "en");
    supabaseFakes.signInImpl = async () => ({
      error: Object.assign(new Error("x"), { code: "email_not_confirmed" }),
    });
    renderLogin();
    fillAndSubmit();
    fireEvent.click(
      await screen.findByRole("button", { name: "Use a different account" }),
    );

    expect(await screen.findByLabelText("Contraseña")).toHaveValue("");
    expect(screen.queryByText("Check your inbox")).toBeNull();
    localStorage.clear();
  });

  it("pendiente → autenticado: al llegar la sesión continúa en /account (sin returnTo)", async () => {
    localStorage.setItem("upmina:locale", "en");
    supabaseFakes.signInImpl = async () => ({
      error: Object.assign(new Error("x"), { code: "email_not_confirmed" }),
    });
    const view = renderLogin();
    fillAndSubmit();
    expect(await screen.findByText("Check your inbox")).toBeInTheDocument();

    authFakes.session = { user: { email: "fan@example.com" } };
    view.rerender(loginTree());

    expect(screen.getByText("Account stub")).toBeInTheDocument();
    localStorage.clear();
  });

  it("credenciales incorrectas sigue sin activar el estado pendiente (sin enumeración)", async () => {
    supabaseFakes.signInImpl = async () => ({
      error: new Error("Invalid login credentials"),
    });
    renderLogin();
    fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Email o contraseña incorrectos.",
    );
    expect(screen.queryByText("Check your inbox")).toBeNull();
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

// returnTo (Fase 9G-3): solo se honra un destino interno de la allowlist (parseSafeReturnTo) y se
// navega con React Router, jamás con window.location ni con el valor crudo.
describe("/login — returnTo seguro", () => {
  const enc = encodeURIComponent;

  it.each([
    ["/admin", "Admin stub"],
    ["/admin/activate", "Activate stub"],
    ["/account", "Account stub"],
    ["/community", "Comunidad stub"],
    ["/cosplay", "Cosplay stub"],
  ])("login correcto con returnTo=%s → navega ahí", async (path, stub) => {
    renderLogin(`/login?returnTo=${path}`);

    fillAndSubmit();

    expect(await screen.findByText(stub)).toBeInTheDocument();
    expect(supabaseFakes.signInCalls).toHaveLength(1);
  });

  it.each([
    ["externo", "https://evil.example"],
    ["http externo", "http://evil.example/admin"],
    ["protocol-relative", "//evil.example"],
    ["protocol-relative triple", "///evil.example"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,x"],
    ["file:", "file:///etc/passwd"],
    ["backslash", "/\\evil.example"],
    ["malformado (%)", "/admin%zz"],
    ["codificado", "/%2f%2fevil.example"],
    ["ruta desconocida", "/desconocida"],
    // /cosplay ya es un destino válido (Fase 9I-1): la cobertura vive en el it.each de arriba.
    ["con parámetros", "/admin?x=1"],
    ["con fragmento", "/admin#x"],
    ["con espacios", " /admin"],
    ["vacío", ""],
  ])("returnTo %s → se ignora: tras el login va a /", async (_n, raw) => {
    const before = window.location.href;
    renderLogin(`/login?returnTo=${enc(raw)}`);

    fillAndSubmit();

    expect(await screen.findByText("Home stub")).toBeInTheDocument();
    expect(screen.queryByText("Admin stub")).toBeNull();
    expect(window.location.href).toBe(before);
  });

  it("sin returnTo → /", async () => {
    renderLogin("/login");
    fillAndSubmit();
    expect(await screen.findByText("Home stub")).toBeInTheDocument();
  });

  it("sesión ya existente + returnTo válido → redirige a ese destino sin mostrar el formulario", () => {
    authFakes.session = { user: { email: "fan@example.com" } };
    renderLogin("/login?returnTo=/admin");

    expect(screen.getByText("Admin stub")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).toBeNull();
  });

  it("sesión ya existente + returnTo inválido → /, nunca fuera del sitio", () => {
    authFakes.session = { user: { email: "fan@example.com" } };
    renderLogin(`/login?returnTo=${enc("https://evil.example")}`);

    expect(screen.getByText("Home stub")).toBeInTheDocument();
  });

  it("el returnTo no concede nada: llegar a /admin solo lleva a la superficie, que decide por su cuenta", async () => {
    renderLogin("/login?returnTo=/admin");
    fillAndSubmit();
    await screen.findByText("Admin stub");
    // Login no consulta roles ni AAL: ninguna llamada de red.
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("/login — AUTH-1: retorno del enlace de confirmación", () => {
  const EXPIRED =
    "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";
  const SUCCESS =
    "#access_token=synthetic-token&refresh_token=synthetic-refresh&type=signup";
  function Probe({ onLocation }: { onLocation: (l: string) => void }) {
    const l = useLocation();
    onLocation(`${l.pathname}${l.search}|${l.hash}`);
    return null;
  }
  const treeWithProbe = (entry: string, onLocation: (l: string) => void) => (
    <MemoryRouter initialEntries={[entry]}>
      <Probe onLocation={onLocation} />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<p>Home stub</p>} />
        <Route path="/account" element={<p>Account stub</p>} />
        <Route path="/community" element={<p>Comunidad stub</p>} />
      </Routes>
    </MemoryRouter>
  );
  beforeEach(() => localStorage.setItem("upmina:locale", "en"));
  afterEach(() => localStorage.clear());

  it("enlace caducado: aviso controlado, formulario disponible, sin texto del proveedor ni llamadas", async () => {
    renderLogin(`/login${EXPIRED}`);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "This confirmation link has expired or was already used",
    );
    expect(alert).toHaveTextContent("request a new email");
    expect(document.body.textContent).not.toMatch(
      /Email link is invalid|access_denied|otp_expired/,
    );
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(supabaseFakes.signInCalls).toHaveLength(0);
  });

  it("enlace inválido (otro error): aviso 'no pudimos confirmar'", async () => {
    renderLogin("/login#error=access_denied&error_code=bad_jwt");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't confirm your email with that link",
    );
  });

  it("el fragmento de error se retira de la URL (sin bucles) y el aviso permanece", async () => {
    const seen: string[] = [];
    render(treeWithProbe(`/login?returnTo=%2Fcommunity${EXPIRED}`, (l) => seen.push(l)));
    await waitFor(() => expect(seen.at(-1)).toBe("/login?returnTo=%2Fcommunity|"));
    expect(screen.getByRole("alert")).toHaveTextContent("has expired");
    // Estable: tras limpiar la URL no hay más navegaciones.
    const count = seen.length;
    await act(async () => {});
    expect(seen.length).toBe(count);
  });

  it("tras el aviso, iniciar sesión con email sin verificar lleva al reenvío (flujo normal)", async () => {
    supabaseFakes.signInImpl = async () => ({
      error: Object.assign(new Error("x"), { code: "email_not_confirmed" }),
    });
    renderLogin(`/login${EXPIRED}`);
    await screen.findByRole("alert");
    fillAndSubmit();
    expect(await screen.findByText("Check your inbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resend/i })).toBeInTheDocument();
  });

  it("sin fragmento no hay aviso", () => {
    renderLogin("/login");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("confirmación correcta (sesión llegó por el enlace) sin returnTo → /account (alta de username de AUTH-2)", () => {
    authFakes.session = { user: { email: "fan@example.com" } };
    renderLogin(`/login${SUCCESS}`);
    expect(screen.getByText("Account stub")).toBeInTheDocument();
  });

  it("confirmación correcta con returnTo seguro → respeta el destino", () => {
    authFakes.session = { user: { email: "fan@example.com" } };
    renderLogin(`/login?returnTo=%2Fcommunity${SUCCESS}`);
    expect(screen.getByText("Comunidad stub")).toBeInTheDocument();
  });

  it("sesión previa sin fragmento sigue yendo a / (comportamiento existente)", () => {
    authFakes.session = { user: { email: "fan@example.com" } };
    renderLogin("/login");
    expect(screen.getByText("Home stub")).toBeInTheDocument();
  });
});
