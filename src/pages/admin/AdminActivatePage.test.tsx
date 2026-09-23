import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import AdminActivatePage from "./AdminActivatePage";

// AdminActivatePage captura y limpia el fragmento #token=<secreto> una vez POR MONTAJE
// del componente (guardado en un useRef, ver el comentario en AdminActivatePage.tsx), no
// a nivel de módulo. Por eso cada test solo necesita fijar window.location.hash ANTES de
// renderizar: un `render()` nuevo crea una instancia nueva del componente (ref limpio),
// exactamente como ocurriría al entrar de verdad a la ruta.

const authFakes = vi.hoisted(() => ({
  session: null as null | { access_token: string; user: { id: string } },
  loading: false,
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: authFakes.session,
    user: authFakes.session?.user ?? null,
    loading: authFakes.loading,
    signOut: vi.fn(),
  }),
}));

const supabaseFakes = vi.hoisted(() => ({
  getAuthenticatorAssuranceLevel: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: supabaseFakes.getAuthenticatorAssuranceLevel,
      },
      async getSession() {
        return { data: { session: authFakes.session } };
      },
    },
  },
}));

const TEST_TOKEN = "synthetic-activation-token-not-real";

function setHash(hash: string) {
  window.history.replaceState(null, "", "/admin/activate" + hash);
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/activate"]}>
      <Routes>
        <Route path="/admin/activate" element={<AdminActivatePage />} />
        <Route path="/admin/login" element={<p>Login stub</p>} />
        <Route path="/admin/mfa" element={<p>MFA stub</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  authFakes.session = null;
  authFakes.loading = false;
  supabaseFakes.getAuthenticatorAssuranceLevel.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("captura y limpieza del token", () => {
  it("captura el token del hash y lo elimina inmediatamente con history.replaceState", () => {
    setHash(`#token=${TEST_TOKEN}`);
    renderPage();
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TEST_TOKEN);
    expect(window.location.pathname).toBe("/admin/activate");
  });

  it("el token no vuelve a aparecer en la URL tras renderizar", async () => {
    setHash(`#token=${TEST_TOKEN}`);
    renderPage();
    await screen.findByRole("heading", { name: "Activar acceso" });
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TEST_TOKEN);
  });

  it("el token no se escribe en localStorage ni sessionStorage", async () => {
    const localSpy = vi.spyOn(Storage.prototype, "setItem");
    setHash(`#token=${TEST_TOKEN}`);
    renderPage();
    await screen.findByRole("heading", { name: "Activar acceso" });
    expect(localSpy).not.toHaveBeenCalled();
  });

  it("sin #token en la URL: no llama a getAuthenticatorAssuranceLevel ni a fetch, y muestra enlace inválido", async () => {
    authFakes.session = { access_token: "at", user: { id: "u1" } };
    setHash("");
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no es válido|incompleto/i,
    );
    expect(supabaseFakes.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bajo React.StrictMode el token sigue disponible para el flujo de activación (doble invocación no lo pierde)", async () => {
    authFakes.session = { access_token: "at-strict", user: { id: "u1" } };
    supabaseFakes.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal2" },
      error: null,
    });
    (fetch as Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ role: "admin" }),
    });

    setHash(`#token=${TEST_TOKEN}`);
    render(
      <React.StrictMode>
        <MemoryRouter initialEntries={["/admin/activate"]}>
          <Routes>
            <Route path="/admin/activate" element={<AdminActivatePage />} />
          </Routes>
        </MemoryRouter>
      </React.StrictMode>,
    );

    expect(window.location.hash).toBe("");

    const button = await screen.findByRole("button", { name: /activar acceso/i });
    fireEvent.click(button);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [, init] = (fetch as Mock).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ token: TEST_TOKEN });
    expect(await screen.findByText(/Administrador/)).toBeInTheDocument();
  });

  it("una entrada posterior con un token distinto (TOKEN_A → TOKEN_B) nunca reutiliza el token anterior", async () => {
    authFakes.session = { access_token: "at-aal2", user: { id: "u1" } };
    supabaseFakes.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal2" },
      error: null,
    });
    (fetch as Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ role: "admin" }),
    });

    // 1) Primera entrada real a /admin/activate con TOKEN_A: se captura y se limpia.
    setHash("#token=TOKEN_A");
    const firstVisit = renderPage();
    await screen.findByRole("button", { name: /activar acceso/i });
    expect(window.location.hash).toBe("");

    // 2) Se abandona /admin/activate (desmontaje real: p. ej. se navegó a otra ruta de
    // la SPA). El módulo YA fue evaluado antes por este mismo proceso, pero eso no debe
    // importar: la captura está atada al montaje del componente, no al módulo.
    firstVisit.unmount();

    // 3) Segunda entrada, dentro de la misma vida de la SPA (sin recargar la página ni
    // reevaluar el módulo), con un token DISTINTO en el hash.
    setHash("#token=TOKEN_B");
    renderPage();
    const secondButton = await screen.findByRole("button", { name: /activar acceso/i });
    expect(window.location.hash).toBe("");

    // 4) La activación de esta segunda entrada debe usar TOKEN_B, nunca TOKEN_A.
    fireEvent.click(secondButton);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [, init] = (fetch as Mock).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ token: "TOKEN_B" });
    expect(body.token).not.toBe("TOKEN_A");
  });
});

describe("sin sesión", () => {
  it("no llama al endpoint y ofrece iniciar sesión", async () => {
    authFakes.session = null;
    setHash(`#token=${TEST_TOKEN}`);
    renderPage();

    expect(
      await screen.findByRole("link", { name: /iniciar sesión/i }),
    ).toBeInTheDocument();
    expect(supabaseFakes.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("sesión aal1 (sin aal2)", () => {
  it("no llama al endpoint y ofrece ir a /admin/mfa", async () => {
    authFakes.session = { access_token: "at", user: { id: "u1" } };
    supabaseFakes.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal1" },
      error: null,
    });
    setHash(`#token=${TEST_TOKEN}`);
    renderPage();

    expect(
      await screen.findByRole("link", { name: /verificación en dos pasos/i }),
    ).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("sesión aal2", () => {
  async function renderReady() {
    authFakes.session = { access_token: "at-aal2", user: { id: "u1" } };
    supabaseFakes.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal2" },
      error: null,
    });
    setHash(`#token=${TEST_TOKEN}`);
    renderPage();
    return screen.findByRole("button", { name: /activar acceso/i });
  }

  it("no llama al endpoint automáticamente al cargar", async () => {
    await renderReady();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("la activación requiere una acción explícita (clic en el botón)", async () => {
    (fetch as Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ role: "moderator" }),
    });
    const button = await renderReady();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  it("envía POST con Authorization Bearer, Content-Type application/json y body exclusivamente { token }", async () => {
    (fetch as Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ role: "admin" }),
    });
    const button = await renderReady();
    fireEvent.click(button);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, init] = (fetch as Mock).mock.calls[0];
    expect(url).toBe("/api/admin/activate");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer at-aal2",
      "Content-Type": "application/json",
    });

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ token: TEST_TOKEN });
    expect(Object.keys(body)).toEqual(["token"]);
    expect(body).not.toHaveProperty("userId");
    expect(body).not.toHaveProperty("role");
    expect(body).not.toHaveProperty("email");
    expect(body).not.toHaveProperty("aal");
    expect(body).not.toHaveProperty("invitation_type");
  });

  it("200 con role admin muestra confirmación de administrador", async () => {
    (fetch as Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ role: "admin" }),
    });
    const button = await renderReady();
    fireEvent.click(button);
    expect(await screen.findByText(/Administrador/)).toBeInTheDocument();
  });

  it("200 con role moderator muestra confirmación de moderador", async () => {
    (fetch as Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ role: "moderator" }),
    });
    const button = await renderReady();
    fireEvent.click(button);
    expect(await screen.findByText(/Moderador/)).toBeInTheDocument();
  });

  it("400 muestra un mensaje seguro sin reflejar el token", async () => {
    (fetch as Mock).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "invitation_expired" }),
    });
    const button = await renderReady();
    fireEvent.click(button);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/no es válida|expiró|utilizada/i);
    expect(alert.textContent).not.toContain(TEST_TOKEN);
  });

  it("401 muestra un mensaje seguro y ofrece volver a iniciar sesión", async () => {
    (fetch as Mock).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "unauthorized" }),
    });
    const button = await renderReady();
    fireEvent.click(button);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/sesión/i);
    expect(
      await screen.findByRole("link", { name: /iniciar sesión/i }),
    ).toBeInTheDocument();
  });

  it("403 muestra un mensaje seguro y ofrece ir a /admin/mfa", async () => {
    (fetch as Mock).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "forbidden" }),
    });
    const button = await renderReady();
    fireEvent.click(button);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/verificación en dos pasos/i);
    expect(
      await screen.findByRole("link", { name: /verificación en dos pasos/i }),
    ).toBeInTheDocument();
  });

  it("500 muestra un mensaje seguro genérico", async () => {
    (fetch as Mock).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "internal" }),
    });
    const button = await renderReady();
    fireEvent.click(button);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/error interno/i);
  });

  it("un fallo de red muestra un mensaje seguro, no el error crudo", async () => {
    (fetch as Mock).mockRejectedValue(new TypeError("Failed to fetch"));
    const button = await renderReady();
    fireEvent.click(button);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/no se pudo conectar/i);
    expect(alert.textContent).not.toContain("Failed to fetch");
  });

  it("el token nunca se refleja en la UI ni en mensajes de error", async () => {
    (fetch as Mock).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "invitation_not_found" }),
    });
    const button = await renderReady();
    fireEvent.click(button);
    await screen.findByRole("alert");
    expect(document.body.textContent).not.toContain(TEST_TOKEN);
  });
});

describe("sin consulta cliente a admin_roles", () => {
  it("el código fuente de AdminActivatePage nunca consulta admin_roles ni usa supabase.from", () => {
    const source = readFileSync(
      join(process.cwd(), "src/pages/admin/AdminActivatePage.tsx"),
      "utf-8",
    );
    expect(source).not.toMatch(/\.from\(\s*["']admin_roles["']\s*\)/);
    expect(source).not.toMatch(/supabase\s*\.\s*from/);
  });
});
