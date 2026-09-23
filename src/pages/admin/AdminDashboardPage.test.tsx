import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AdminDashboardPage from "./AdminDashboardPage";

// Fija el contrato de seguridad de /admin (Bloque 5C): la única autoridad para mostrar
// el shell administrativo es una respuesta 200 real de GET /api/admin/me (ver
// src/lib/admin-handlers.ts). No repite las pruebas de handleAdminMe en sí (ya cubiertas
// por admin-handlers.test.ts): aquí solo importa cómo el frontend reacciona a lo que esa
// respuesta trae, y que nunca decide autorización por sí mismo (email/metadata/
// localStorage/existencia de sesión).

const authFakes = vi.hoisted(() => ({
  session: null as null | { access_token: string; user: { id: string } },
  loading: false,
  signOut: vi.fn(),
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: authFakes.session,
    user: authFakes.session?.user ?? null,
    loading: authFakes.loading,
    signOut: authFakes.signOut,
  }),
}));

const supabaseFakes = vi.hoisted(() => ({
  getAuthenticatorAssuranceLevel: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: supabaseFakes.getAuthenticatorAssuranceLevel,
      },
      getSession: supabaseFakes.getSession,
    },
  },
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route path="/admin" element={<AdminDashboardPage />} />
        <Route path="/admin/login" element={<p>Login stub</p>} />
        <Route path="/admin/mfa" element={<p>MFA stub</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function okMeResponse() {
  return { ok: true, status: 200, json: async () => ({ role: "admin" }) };
}

beforeEach(() => {
  authFakes.session = null;
  authFakes.loading = false;
  authFakes.signOut.mockReset();
  supabaseFakes.getAuthenticatorAssuranceLevel.mockReset();
  supabaseFakes.getSession.mockReset();
  supabaseFakes.getSession.mockImplementation(async () => ({
    data: { session: authFakes.session },
  }));
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AdminDashboardPage — estados de acceso", () => {
  it("mientras se resuelve la sesión (loading) → no muestra contenido admin", () => {
    authFakes.loading = true;
    renderPage();

    expect(screen.getByRole("status")).toHaveTextContent(/comprobando tu sesión/i);
    expect(
      screen.queryByText("Sesión administrativa verificada."),
    ).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sin sesión → CTA a /admin/login, nunca llama a /api/admin/me", async () => {
    authFakes.session = null;
    renderPage();

    expect(
      await screen.findByRole("link", { name: /iniciar sesión/i }),
    ).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      screen.queryByText("Sesión administrativa verificada."),
    ).not.toBeInTheDocument();
  });

  it("sesión + /api/admin/me → 401: se trata como sesión inválida, CTA a login, sin shell", async () => {
    authFakes.session = { access_token: "at-1", user: { id: "u1" } };
    (fetch as Mock).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "No autenticado" }),
    });

    renderPage();

    expect(
      await screen.findByRole("link", { name: /iniciar sesión/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Sesión administrativa verificada."),
    ).not.toBeInTheDocument();
  });

  it("sesión + /api/admin/me → 403 sin poder determinar MFA (AAL ya es aal2) → mensaje genérico, sin CTA de MFA, sin shell", async () => {
    authFakes.session = { access_token: "at-2", user: { id: "u1" } };
    (fetch as Mock).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "No autorizado" }),
    });
    supabaseFakes.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal2" },
      error: null,
    });

    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no se pudo autorizar esta sesión/i,
    );
    expect(
      screen.queryByRole("link", { name: /verificación en dos pasos/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Sesión administrativa verificada."),
    ).not.toBeInTheDocument();
  });

  it("sesión + /api/admin/me → 403 con AAL determinable como aal1 → CTA a /admin/mfa", async () => {
    authFakes.session = { access_token: "at-3", user: { id: "u1" } };
    (fetch as Mock).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "No autorizado" }),
    });
    supabaseFakes.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal1" },
      error: null,
    });

    renderPage();

    expect(
      await screen.findByRole("link", { name: /verificación en dos pasos/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Sesión administrativa verificada."),
    ).not.toBeInTheDocument();
  });

  it("sesión + /api/admin/me → 200 {role:'admin'} → muestra el shell", async () => {
    authFakes.session = { access_token: "at-4", user: { id: "u1" } };
    (fetch as Mock).mockResolvedValue(okMeResponse());

    renderPage();

    expect(
      await screen.findByText("Sesión administrativa verificada."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Panel de administración" }),
    ).toBeInTheDocument();
  });

  it("sesión + /api/admin/me → 200 con body inesperado (sin role admin) → fail closed, sin shell", async () => {
    authFakes.session = { access_token: "at-5", user: { id: "u1" } };
    (fetch as Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ algo: "inesperado" }),
    });

    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no se pudo autorizar esta sesión/i,
    );
    expect(
      screen.queryByText("Sesión administrativa verificada."),
    ).not.toBeInTheDocument();
  });

  it("sesión + fetch lanza (fallo de red) → fail closed, sin shell, sin CTA de MFA", async () => {
    authFakes.session = { access_token: "at-6", user: { id: "u1" } };
    (fetch as Mock).mockRejectedValue(new Error("network down"));

    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no se pudo autorizar esta sesión/i,
    );
    expect(
      screen.queryByRole("link", { name: /verificación en dos pasos/i }),
    ).not.toBeInTheDocument();
    expect(supabaseFakes.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
  });

  it("sesión + /api/admin/me → 500 → fail closed, sin intentar determinar MFA", async () => {
    authFakes.session = { access_token: "at-7", user: { id: "u1" } };
    (fetch as Mock).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "Error interno" }),
    });

    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no se pudo autorizar esta sesión/i,
    );
    expect(supabaseFakes.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
    expect(
      screen.queryByText("Sesión administrativa verificada."),
    ).not.toBeInTheDocument();
  });

  it("cerrar sesión desde el shell elimina el acceso inmediatamente (sin sesión → CTA login)", async () => {
    authFakes.session = { access_token: "at-8", user: { id: "u1" } };
    (fetch as Mock).mockResolvedValue(okMeResponse());

    const { rerender } = renderPage();
    await screen.findByText("Sesión administrativa verificada.");

    // Simula el efecto real de signOut(): AuthProvider actualizaría session a null.
    authFakes.session = null;
    rerender(
      <MemoryRouter initialEntries={["/admin"]}>
        <Routes>
          <Route path="/admin" element={<AdminDashboardPage />} />
          <Route path="/admin/login" element={<p>Login stub</p>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("link", { name: /iniciar sesión/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Sesión administrativa verificada."),
    ).not.toBeInTheDocument();
  });

  it("usa el Bearer real de la sesión para la request, y nunca lo renderiza/loggea", async () => {
    authFakes.session = {
      access_token: "un-token-secreto-de-prueba",
      user: { id: "u1" },
    };
    (fetch as Mock).mockResolvedValue(okMeResponse());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    renderPage();
    await screen.findByText("Sesión administrativa verificada.");

    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/me",
      expect.objectContaining({
        headers: { Authorization: "Bearer un-token-secreto-de-prueba" },
      }),
    );
    expect(document.body.innerHTML).not.toContain("un-token-secreto-de-prueba");
    for (const call of [...logSpy.mock.calls, ...errorSpy.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain("un-token-secreto-de-prueba");
    }
  });
});

describe("AdminDashboardPage — no decide autorización por su cuenta", () => {
  it("la mera existencia de sesión sin respuesta 200 de /api/admin/me nunca muestra el shell", async () => {
    authFakes.session = { access_token: "at-9", user: { id: "u1" } };
    (fetch as Mock).mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    supabaseFakes.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal2" },
      error: null,
    });

    renderPage();

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByText("Sesión administrativa verificada."),
    ).not.toBeInTheDocument();
  });
});

// Carreras asíncronas (Bloque 5C.1): una operación perteneciente a un efecto invalidado
// (logout, cambio de sesión, unmount) nunca debe modificar el estado ni lanzar requests.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function pageTree() {
  return (
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route path="/admin" element={<AdminDashboardPage />} />
        <Route path="/admin/login" element={<p>Login stub</p>} />
      </Routes>
    </MemoryRouter>
  );
}

const VERIFIED = "Sesión administrativa verificada.";

describe("AdminDashboardPage — carreras asíncronas", () => {
  it("A: response.json() tardío tras logout → el shell NO aparece", async () => {
    authFakes.session = { access_token: "at-a", user: { id: "u1" } };
    const jsonGate = deferred<unknown>();
    (fetch as Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => jsonGate.promise,
    });

    const { rerender } = render(pageTree());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    authFakes.session = null;
    rerender(pageTree());
    expect(
      await screen.findByRole("link", { name: /iniciar sesión/i }),
    ).toBeInTheDocument();

    await act(async () => {
      jsonGate.resolve({ role: "admin" });
      await Promise.resolve();
    });

    expect(screen.queryByText(VERIFIED)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /iniciar sesión/i })).toBeInTheDocument();
  });

  it("B: getSession() tardío tras invalidación → no se lanza fetch ni aparece el shell", async () => {
    authFakes.session = { access_token: "at-b", user: { id: "u1" } };
    const sessionGate = deferred<{
      data: { session: { access_token: string } | null };
    }>();
    supabaseFakes.getSession.mockReturnValue(sessionGate.promise);
    (fetch as Mock).mockResolvedValue(okMeResponse());

    const { rerender } = render(pageTree());
    await waitFor(() => expect(supabaseFakes.getSession).toHaveBeenCalledTimes(1));

    authFakes.session = null;
    rerender(pageTree());
    expect(
      await screen.findByRole("link", { name: /iniciar sesión/i }),
    ).toBeInTheDocument();

    await act(async () => {
      sessionGate.resolve({ data: { session: { access_token: "at-b" } } });
      await Promise.resolve();
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByText(VERIFIED)).not.toBeInTheDocument();
  });

  it("C: getSession() rechaza → fail closed genérico, sin filtrar el error ni unhandled rejection", async () => {
    authFakes.session = { access_token: "at-c", user: { id: "u1" } };
    supabaseFakes.getSession.mockRejectedValue(new Error("detalle-interno-secreto"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      render(pageTree());

      expect(await screen.findByRole("alert")).toHaveTextContent(
        /no se pudo autorizar esta sesión/i,
      );
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByText(VERIFIED)).not.toBeInTheDocument();
      expect(document.body.innerHTML).not.toContain("detalle-interno-secreto");
      expect(fetch).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("D: AAL (MFA) tardío tras invalidación → no modifica la UI actual", async () => {
    authFakes.session = { access_token: "at-d", user: { id: "u1" } };
    (fetch as Mock).mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    const aalGate = deferred<{ data: { currentLevel: string }; error: null }>();
    supabaseFakes.getAuthenticatorAssuranceLevel.mockReturnValue(aalGate.promise);

    const { rerender } = render(pageTree());
    await waitFor(() =>
      expect(supabaseFakes.getAuthenticatorAssuranceLevel).toHaveBeenCalledTimes(1),
    );

    authFakes.session = null;
    rerender(pageTree());
    expect(
      await screen.findByRole("link", { name: /iniciar sesión/i }),
    ).toBeInTheDocument();

    await act(async () => {
      aalGate.resolve({ data: { currentLevel: "aal1" }, error: null });
      await Promise.resolve();
    });

    expect(screen.getByRole("link", { name: /iniciar sesión/i })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /verificación en dos pasos/i })).toBeNull();
  });

  it("E: unmount con operación pendiente → al resolver no hay setState ni errores React", async () => {
    authFakes.session = { access_token: "at-e", user: { id: "u1" } };
    const jsonGate = deferred<unknown>();
    (fetch as Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => jsonGate.promise,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(pageTree());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    unmount();

    await act(async () => {
      jsonGate.resolve({ role: "admin" });
      await Promise.resolve();
    });

    expect(document.body.innerHTML).not.toContain(VERIFIED);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
