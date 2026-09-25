import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";
import AdminDashboardPage from "./AdminDashboardPage";

// Fija el contrato de /admin (Fase 9G-3), máquina de estados sobre GET /api/admin/access:
//   sin sesión → /login?returnTo=/admin
//   role != admin → acceso denegado, SIN MFA
//   admin + mfa.recent=false → /admin/mfa?returnTo=/admin
//   admin + mfa.recent=true → GET /api/admin/me → panel
// El frontend nunca decide por su cuenta: solo presenta lo que responde el servidor. No repite las
// pruebas de los endpoints (admin-handlers.test.ts / admin-auth.test.ts): aquí importa cómo la UI
// reacciona a lo que traen, que un 403 genérico NUNCA lleva a MFA y que no hay bucles.

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
  getSession: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: supabaseFakes.getSession,
    },
  },
}));

const ALL_CAPS = ["moderation", "technical", "social_admin", "team_admin"];
const CAPS: Record<string, string[]> = {
  admin: ALL_CAPS,
  moderator: ["moderation"],
  developer: ["moderation", "technical"],
};

type Handler = (call: number) => unknown;

function access(role: string | null, recent: boolean) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      role,
      capabilities: role ? CAPS[role] : [],
      mfa: { recent },
    }),
  };
}

const okMe = (body: unknown = { role: "admin", capabilities: ALL_CAPS }) => ({
  ok: true,
  status: 200,
  json: async () => body,
});
const status = (code: number, body: unknown = {}) => ({
  ok: false,
  status: code,
  json: async () => body,
});
const STEP_UP = () => status(403, { error: "No autorizado", code: "step_up_required" });
const FORBIDDEN = () => status(403, { error: "No autorizado" });

const socialOk = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    connections: { instagram: { status: "connected" }, tiktok: { status: "connected" } },
  }),
});
const emptyInvitations = () => ({
  ok: true,
  status: 200,
  json: async () => ({ invitations: [] }),
});
const emptyMembers = () => ({
  ok: true,
  status: 200,
  json: async () => ({ members: [] }),
});

const calls: Record<string, number> = {};

/** Enruta fetch por URL; cada handler recibe el nº de llamada (1, 2, …) a ese endpoint. */
function routeFetch(handlers: Record<string, Handler>) {
  for (const key of Object.keys(calls)) delete calls[key];
  (fetch as Mock).mockImplementation(async (url: string) => {
    calls[url] = (calls[url] ?? 0) + 1;
    const handler = handlers[url];
    if (!handler) throw new Error(`fetch inesperado a ${url}`);
    return handler(calls[url]);
  });
}

const withSections = {
  "/api/admin/social-status": () => socialOk(),
  "/api/admin/team-invitations": () => emptyInvitations(),
  "/api/admin/team-members": () => emptyMembers(),
};

function urls(): string[] {
  return (fetch as Mock).mock.calls.map((c) => String(c[0]));
}

function Probe({ id }: { id: string }) {
  const location = useLocation();
  const fromMfa = Boolean((location.state as { fromMfa?: unknown } | null)?.fromMfa);
  return (
    <p data-testid={id}>
      {location.pathname + location.search}
      {fromMfa ? " [fromMfa]" : ""}
    </p>
  );
}

function renderPage(entry: string | { pathname: string; state: unknown } = "/admin") {
  return render(
    <QueryClientProvider client={testQueryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/admin" element={<AdminDashboardPage />} />
          <Route path="/login" element={<Probe id="login" />} />
          <Route path="/admin/mfa" element={<Probe id="mfa" />} />
          <Route path="/account" element={<p>Account stub</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function signIn(userId = "u1", token = "at-sintetico") {
  authFakes.session = { access_token: token, user: { id: userId } };
}

const PANEL_TEXT = "Sesión administrativa verificada.";

beforeEach(() => {
  testQueryClient.clear();
  authFakes.session = null;
  authFakes.loading = false;
  authFakes.signOut.mockReset();
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

describe("/admin — sesión", () => {
  it("mientras se resuelve la sesión (loading) → sin contenido admin y sin llamadas", () => {
    authFakes.loading = true;
    renderPage();

    expect(screen.getByRole("status")).toHaveTextContent(/comprobando tu sesión/i);
    expect(screen.queryByText(PANEL_TEXT)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sin sesión → /login?returnTo=/admin, sin ninguna llamada a la API", async () => {
    renderPage();

    expect(await screen.findByTestId("login")).toHaveTextContent(
      "/login?returnTo=/admin",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByText(PANEL_TEXT)).toBeNull();
  });

  it("sesión local que el servidor rechaza (401) → NO redirige a /login (evita el bucle): ofrece cerrar sesión", async () => {
    signIn();
    routeFetch({ "/api/admin/access": () => status(401) });
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /tu sesión ya no es válida/i,
    );
    expect(screen.queryByTestId("login")).toBeNull();
    expect(screen.queryByTestId("mfa")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /cerrar sesión/i }));
    expect(authFakes.signOut).toHaveBeenCalledTimes(1);
    expect(urls()).toEqual(["/api/admin/access"]);
  });
});

describe("/admin — autorización ANTES que MFA", () => {
  it.each([
    ["USER (role null, sin MFA reciente)", null, false],
    ["USER con aal2 y MFA reciente (MFA no concede rol)", null, true],
    ["MODERATOR sin MFA reciente", "moderator", false],
    ["MODERATOR con MFA reciente", "moderator", true],
    ["DEVELOPER sin MFA reciente", "developer", false],
    ["DEVELOPER con MFA reciente", "developer", true],
  ])("%s → acceso denegado, SIN MFA, sin /me", async (_n, role, recent) => {
    signIn();
    routeFetch({ "/api/admin/access": () => access(role, recent) });
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no tienes acceso al panel de administración/i,
    );
    expect(screen.queryByTestId("mfa")).toBeNull();
    expect(screen.queryByText(PANEL_TEXT)).toBeNull();
    expect(screen.queryByText(/verificación en dos pasos/i)).toBeNull();
    expect(urls()).toEqual(["/api/admin/access"]); // nunca /me ni secciones
    fireEvent.click(screen.getByRole("link", { name: /ir a mi cuenta/i }));
    expect(await screen.findByText("Account stub")).toBeInTheDocument();
  });

  it("ADMIN sin MFA reciente → /admin/mfa?returnTo=/admin (sin llamar a /me)", async () => {
    signIn();
    routeFetch({ "/api/admin/access": () => access("admin", false) });
    renderPage();

    expect(await screen.findByTestId("mfa")).toHaveTextContent(
      "/admin/mfa?returnTo=/admin",
    );
    expect(urls()).toEqual(["/api/admin/access"]);
    expect(screen.queryByText(PANEL_TEXT)).toBeNull();
  });

  it("ADMIN con MFA reciente → /me y panel", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": () => access("admin", true),
      "/api/admin/me": () => okMe(),
      ...withSections,
    });
    renderPage();

    expect(await screen.findByText(PANEL_TEXT)).toBeInTheDocument();
    expect(urls().slice(0, 2)).toEqual(["/api/admin/access", "/api/admin/me"]);
    expect(screen.queryByTestId("mfa")).toBeNull();
  });

  it("aal2 no sustituye a mfa.recent: el frontend solo mira lo que responde /access", async () => {
    signIn();
    // Aunque la sesión local "sea aal2" (no se consulta), recent=false manda a MFA.
    routeFetch({ "/api/admin/access": () => access("admin", false) });
    renderPage();

    expect(await screen.findByTestId("mfa")).toBeInTheDocument();
    expect(screen.queryByText(PANEL_TEXT)).toBeNull();
  });
});

describe("/admin — respuesta de acceso inválida o en curso", () => {
  it.each([
    ["JSON no objeto", () => ({ ok: true, status: 200, json: async () => "admin" })],
    [
      "rol desconocido",
      () => ({
        ok: true,
        status: 200,
        json: async () => ({ role: "root", capabilities: [], mfa: { recent: true } }),
      }),
    ],
    [
      "sin campo mfa",
      () => ({
        ok: true,
        status: 200,
        json: async () => ({ role: "admin", capabilities: [] }),
      }),
    ],
    [
      "mfa.recent no booleano",
      () => ({
        ok: true,
        status: 200,
        json: async () => ({ role: "admin", capabilities: [], mfa: { recent: "yes" } }),
      }),
    ],
    [
      "USER con capacidades",
      () => ({
        ok: true,
        status: 200,
        json: async () => ({
          role: null,
          capabilities: ["team_admin"],
          mfa: { recent: true },
        }),
      }),
    ],
    ["500", () => status(500)],
    [
      "JSON ilegible",
      () => ({ ok: true, status: 200, json: async () => Promise.reject(new Error("x")) }),
    ],
  ])(
    "%s → falla cerrado: error con reintento, sin panel, sin MFA ni /me",
    async (_n, impl) => {
      signIn();
      routeFetch({ "/api/admin/access": impl });
      renderPage();

      expect(await screen.findByRole("alert")).toHaveTextContent(
        /no se pudo comprobar tu acceso/i,
      );
      expect(screen.getByRole("button", { name: /reintentar/i })).toBeInTheDocument();
      expect(screen.queryByText(PANEL_TEXT)).toBeNull();
      expect(screen.queryByTestId("mfa")).toBeNull();
      expect(urls()).toEqual(["/api/admin/access"]);
    },
  );

  it("fallo de red → falla cerrado; reintentar vuelve a consultar y puede recuperar", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": (n) => {
        if (n === 1) throw new TypeError("red");
        return access("admin", true);
      },
      "/api/admin/me": () => okMe(),
      ...withSections,
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /reintentar/i }));
    expect(await screen.findByText(PANEL_TEXT)).toBeInTheDocument();
  });

  it("mientras /access está en curso no hay panel, ni MFA, ni destello privilegiado", async () => {
    signIn();
    let release: (v: unknown) => void = () => undefined;
    (fetch as Mock).mockImplementation(
      (url: string) =>
        new Promise((resolve) => {
          if (url === "/api/admin/access") release = resolve;
          else resolve(okMe());
        }),
    );
    renderPage();

    expect(screen.getByRole("status")).toHaveTextContent(/comprobando tu sesión/i);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(PANEL_TEXT)).toBeNull();
    expect(screen.queryByTestId("mfa")).toBeNull();
    await act(async () => {
      release(access(null, false));
    });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("el token de la request es el Bearer VIGENTE de la sesión y nunca se renderiza", async () => {
    signIn("u1", "token-vigente-sintetico");
    routeFetch({
      "/api/admin/access": () => access("admin", true),
      "/api/admin/me": () => okMe(),
      ...withSections,
    });
    renderPage();

    expect(await screen.findByText(PANEL_TEXT)).toBeInTheDocument();
    for (const call of (fetch as Mock).mock.calls.slice(0, 2)) {
      expect(call[1].headers.Authorization).toBe("Bearer token-vigente-sintetico");
    }
    expect(document.body.textContent).not.toContain("token-vigente-sintetico");
  });
});

describe("/admin — /api/admin/me (guard estricto)", () => {
  it("403 genérico → NO MFA: se revalida el acceso y se muestra el error, sin bucle", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": () => access("admin", true),
      "/api/admin/me": () => FORBIDDEN(),
    });
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no se pudo autorizar esta sesión/i,
    );
    expect(screen.queryByTestId("mfa")).toBeNull();
    // Se revalida el acceso una vez (invalidación), pero /me NO se reintenta en bucle.
    await waitFor(() => expect(calls["/api/admin/access"]).toBe(2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(calls["/api/admin/me"]).toBe(1);
    expect(calls["/api/admin/access"]).toBe(2);
  });

  it("403 genérico y el servidor confirma que el rol ya no existe → acceso denegado, sin MFA", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": (n) => (n === 1 ? access("admin", true) : access(null, true)),
      "/api/admin/me": () => FORBIDDEN(),
    });
    renderPage();

    expect(
      await screen.findByText(/no tienes acceso|ya no está disponible/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("mfa")).toBeNull();
    expect(screen.queryByText(PANEL_TEXT)).toBeNull();
  });

  it("step_up_required en /me (MFA venció) → el servidor dice recent=false → /admin/mfa", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": (n) =>
        n === 1 ? access("admin", true) : access("admin", false),
      "/api/admin/me": () => STEP_UP(),
    });
    renderPage();

    expect(await screen.findByTestId("mfa")).toHaveTextContent(
      "/admin/mfa?returnTo=/admin",
    );
    expect(calls["/api/admin/me"]).toBe(1);
  });

  it.each([
    ["role no admin en el 200", { role: "moderator", capabilities: ["moderation"] }],
    ["cuerpo inesperado", "texto"],
    ["cuerpo vacío", null],
  ])("200 con %s → falla cerrado, sin panel", async (_n, body) => {
    signIn();
    routeFetch({
      "/api/admin/access": () => access("admin", true),
      "/api/admin/me": () => okMe(body),
    });
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(/no se pudo autorizar/i);
    expect(screen.queryByText(PANEL_TEXT)).toBeNull();
  });

  it("500 y fallo de red en /me → falla cerrado, sin MFA", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": () => access("admin", true),
      "/api/admin/me": () => status(500),
    });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(/no se pudo autorizar/i);
    expect(screen.queryByTestId("mfa")).toBeNull();
    cleanup();

    testQueryClient.clear();
    routeFetch({
      "/api/admin/access": () => access("admin", true),
      "/api/admin/me": () => {
        throw new TypeError("red");
      },
    });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(/no se pudo autorizar/i);
    expect(screen.queryByTestId("mfa")).toBeNull();
  });
});

describe("/admin — volver de un MFA (anti-bucle)", () => {
  const fromMfa = { pathname: "/admin", state: { fromMfa: true } };

  it("vuelve del MFA y el servidor YA lo reconoce → panel", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": () => access("admin", true),
      "/api/admin/me": () => okMe(),
      ...withSections,
    });
    renderPage(fromMfa);

    expect(await screen.findByText(PANEL_TEXT)).toBeInTheDocument();
    expect(screen.queryByTestId("mfa")).toBeNull();
  });

  it("vuelve del MFA pero el servidor aún dice recent=false → NO redirige otra vez: error con reintento manual", async () => {
    signIn();
    routeFetch({ "/api/admin/access": () => access("admin", false) });
    renderPage(fromMfa);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no pudimos confirmar tu verificación/i,
    );
    expect(screen.queryByTestId("mfa")).toBeNull();
    // No hay redirección automática ni peticiones en bucle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(calls["/api/admin/access"]).toBe(1);
    expect(screen.getByRole("button", { name: /reintentar/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /verificar de nuevo/i })).toHaveAttribute(
      "href",
      "/admin/mfa?returnTo=/admin",
    );
  });

  it("el reintento manual recupera el panel cuando el servidor ya lo reconoce", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": (n) => access("admin", n >= 2),
      "/api/admin/me": () => okMe(),
      ...withSections,
    });
    renderPage(fromMfa);

    fireEvent.click(await screen.findByRole("button", { name: /reintentar/i }));
    expect(await screen.findByText(PANEL_TEXT)).toBeInTheDocument();
  });

  it("'Verificar de nuevo' lleva a MFA solo por acción explícita de la persona", async () => {
    signIn();
    routeFetch({ "/api/admin/access": () => access("admin", false) });
    renderPage(fromMfa);

    fireEvent.click(await screen.findByRole("link", { name: /verificar de nuevo/i }));
    expect(await screen.findByTestId("mfa")).toHaveTextContent(
      "/admin/mfa?returnTo=/admin",
    );
  });
});

describe("/admin — secciones: 403 genérico vs step_up_required", () => {
  it("revocación: panel visible → la sección recibe 403 genérico → se revalida (role null) → el panel se retira, sin MFA", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": (n) => (n === 1 ? access("admin", true) : access(null, true)),
      "/api/admin/me": () => okMe(),
      "/api/admin/social-status": () => FORBIDDEN(),
      "/api/admin/team-invitations": () => emptyInvitations(),
      "/api/admin/team-members": () => emptyMembers(),
    });
    renderPage();

    // El panel llegó a mostrarse y la siguiente request privilegiada fue rechazada.
    expect(
      await screen.findByText("Tu acceso administrativo ya no está disponible."),
    ).toBeInTheDocument();
    expect(screen.queryByText(PANEL_TEXT)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Redes sociales" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Miembros del equipo" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Invitaciones del equipo" })).toBeNull();
    expect(screen.queryByRole("button", { name: /conectar/i })).toBeNull();
    // Sin MFA, y con salida a una superficie normal.
    expect(screen.queryByTestId("mfa")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: /ir a mi cuenta/i }));
    expect(await screen.findByText("Account stub")).toBeInTheDocument();
  });

  it("revocación detectada en un listado del equipo (403 genérico) → mismo resultado", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": (n) => (n === 1 ? access("admin", true) : access(null, false)),
      "/api/admin/me": () => okMe(),
      "/api/admin/social-status": () => socialOk(),
      "/api/admin/team-invitations": () => FORBIDDEN(),
      "/api/admin/team-members": () => FORBIDDEN(),
    });
    renderPage();

    expect(
      await screen.findByText("Tu acceso administrativo ya no está disponible."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("mfa")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Miembros del equipo" })).toBeNull();
  });

  it("step_up_required en una sección (MFA vencido con el panel abierto) → MFA; NO se muestra el mensaje de revocación y NO se reproduce la petición", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": (n) =>
        n === 1 ? access("admin", true) : access("admin", false),
      "/api/admin/me": () => okMe(),
      "/api/admin/social-status": () => STEP_UP(),
      "/api/admin/team-invitations": () => emptyInvitations(),
      "/api/admin/team-members": () => emptyMembers(),
    });
    renderPage();

    expect(await screen.findByTestId("mfa")).toHaveTextContent(
      "/admin/mfa?returnTo=/admin",
    );
    expect(screen.queryByText(/ya no está disponible/i)).toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    // Ninguna petición se reproduce: la de la sección se hizo UNA vez; no hay mutaciones.
    expect(calls["/api/admin/social-status"]).toBe(1);
    expect(urls().some((u) => u.includes("connect"))).toBe(false);
    for (const call of (fetch as Mock).mock.calls) {
      expect(call[1]?.method ?? "GET").toBe("GET");
    }
  });

  it("step_up_required pero el servidor sigue diciendo recent=true → no se navega (sin bucle): la sección muestra su error", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": () => access("admin", true),
      "/api/admin/me": () => okMe(),
      "/api/admin/social-status": () => STEP_UP(),
      "/api/admin/team-invitations": () => emptyInvitations(),
      "/api/admin/team-members": () => emptyMembers(),
    });
    renderPage();

    expect(await screen.findByText(PANEL_TEXT)).toBeInTheDocument();
    await waitFor(() => expect(calls["/api/admin/access"]).toBeGreaterThanOrEqual(2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.queryByTestId("mfa")).toBeNull();
    expect(screen.getByText(PANEL_TEXT)).toBeInTheDocument();
  });

  it("tras volver de un MFA, un step_up_required POSTERIOR sí inicia un nuevo MFA (la guarda solo cubre el regreso inmediato)", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": (n) =>
        n <= 1 ? access("admin", true) : access("admin", false),
      "/api/admin/me": () => okMe(),
      "/api/admin/social-status": () => STEP_UP(),
      "/api/admin/team-invitations": () => emptyInvitations(),
      "/api/admin/team-members": () => emptyMembers(),
    });
    renderPage({ pathname: "/admin", state: { fromMfa: true } });

    expect(await screen.findByTestId("mfa")).toHaveTextContent(
      "/admin/mfa?returnTo=/admin",
    );
  });
});

describe("/admin — contenido del panel (presentación por capacidades de /me)", () => {
  it("muestra Redes sociales y consulta el estado; el orden de llamadas es access → me → sección", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": () => access("admin", true),
      "/api/admin/me": () => okMe({ role: "admin", capabilities: [] }),
      "/api/admin/social-status": () => socialOk(),
    });
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Redes sociales" }),
    ).toBeInTheDocument();
    expect(await screen.findAllByText("Conectado")).not.toHaveLength(0);
    expect(urls().slice(0, 3)).toEqual([
      "/api/admin/access",
      "/api/admin/me",
      "/api/admin/social-status",
    ]);
  });

  it("team_admin en /me → Invitaciones y Miembros del equipo", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": () => access("admin", true),
      "/api/admin/me": () => okMe(),
      ...withSections,
    });
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Invitaciones del equipo" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Miembros del equipo" }),
    ).toBeInTheDocument();
  });

  it.each([
    ["sin team_admin", { role: "admin", capabilities: ["moderation", "social_admin"] }],
    ["capabilities vacío", { role: "admin", capabilities: [] }],
    ["sin campo capabilities", { role: "admin" }],
    ["capabilities con forma inesperada", { role: "admin", capabilities: "team_admin" }],
    ["team_admin no string", { role: "admin", capabilities: [{ team_admin: true }] }],
  ])("%s → las secciones de equipo NO se muestran ni se consultan", async (_n, body) => {
    signIn();
    routeFetch({
      "/api/admin/access": () => access("admin", true),
      "/api/admin/me": () => okMe(body),
      "/api/admin/social-status": () => socialOk(),
    });
    renderPage();

    expect(await screen.findByText(PANEL_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Invitaciones del equipo" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Miembros del equipo" })).toBeNull();
    expect(urls()).not.toContain("/api/admin/team-invitations");
    expect(urls()).not.toContain("/api/admin/team-members");
  });

  it("un error del estado social no rompe el panel ni se presenta como 'No conectado'", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": () => access("admin", true),
      "/api/admin/me": () => okMe({ role: "admin", capabilities: [] }),
      "/api/admin/social-status": () => status(500),
    });
    renderPage();

    expect(await screen.findByText(PANEL_TEXT)).toBeInTheDocument();
    expect(await screen.findByText(/no se pudo cargar/i)).toBeInTheDocument();
    expect(screen.queryByText("No conectado")).toBeNull();
  });

  it("cerrar sesión desde el panel llama a signOut", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": () => access("admin", true),
      "/api/admin/me": () => okMe({ role: "admin", capabilities: [] }),
      "/api/admin/social-status": () => socialOk(),
    });
    renderPage();

    await screen.findByText(PANEL_TEXT);
    fireEvent.click(screen.getByRole("button", { name: /cerrar sesión/i }));
    expect(authFakes.signOut).toHaveBeenCalledTimes(1);
  });
});

describe("/admin — carreras asíncronas", () => {
  it("logout mientras /me está en curso → el panel NO aparece", async () => {
    signIn();
    let releaseMe: (v: unknown) => void = () => undefined;
    (fetch as Mock).mockImplementation((url: string) => {
      if (url === "/api/admin/access") return Promise.resolve(access("admin", true));
      if (url === "/api/admin/me") return new Promise((resolve) => (releaseMe = resolve));
      return Promise.resolve(socialOk());
    });
    const view = renderPage();

    await waitFor(() => expect(urls()).toContain("/api/admin/me"));
    authFakes.session = null;
    view.rerender(
      <QueryClientProvider client={testQueryClient}>
        <MemoryRouter initialEntries={["/admin"]}>
          <Routes>
            <Route path="/admin" element={<AdminDashboardPage />} />
            <Route path="/login" element={<Probe id="login" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await act(async () => {
      releaseMe(okMe());
    });

    expect(screen.queryByText(PANEL_TEXT)).toBeNull();
  });

  it("getSession() rechaza al pedir /me → falla cerrado sin filtrar el error", async () => {
    signIn();
    let n = 0;
    supabaseFakes.getSession.mockImplementation(async () => {
      n++;
      if (n >= 2) throw new Error("detalle interno getSession");
      return { data: { session: authFakes.session } };
    });
    routeFetch({ "/api/admin/access": () => access("admin", true) });
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(/no se pudo autorizar/i);
    expect(document.body.textContent).not.toContain("detalle interno");
    expect(screen.queryByText(PANEL_TEXT)).toBeNull();
  });

  it("desmontar con operaciones pendientes no provoca errores de React", async () => {
    signIn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let release: (v: unknown) => void = () => undefined;
    (fetch as Mock).mockImplementation(() => new Promise((r) => (release = r)));
    const view = renderPage();
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    view.unmount();
    await act(async () => {
      release(access("admin", true));
    });

    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("/admin — no confía en el estado local", () => {
  it("un email o metadata 'admin' de la sesión local no muestra nada: solo cuenta /access", async () => {
    authFakes.session = {
      access_token: "at",
      user: { id: "u1", email: "admin@example.com", app_metadata: { role: "admin" } },
    } as never;
    routeFetch({ "/api/admin/access": () => access(null, true) });
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(/no tienes acceso/i);
    expect(screen.queryByText(PANEL_TEXT)).toBeNull();
  });

  it("nada del estado de acceso se guarda en localStorage/sessionStorage", async () => {
    signIn();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    routeFetch({
      "/api/admin/access": () => access("admin", true),
      "/api/admin/me": () => okMe({ role: "admin", capabilities: [] }),
      "/api/admin/social-status": () => socialOk(),
    });
    renderPage();

    await screen.findByText(PANEL_TEXT);
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("/admin — revisión final: guarda fromMfa no pegada", () => {
  it("volvió del MFA, el servidor dijo recent=true pero /me falló: un recent=false POSTERIOR sí inicia MFA (la guarda no queda pegada)", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": (n) => access("admin", n === 1),
      "/api/admin/me": () => status(500),
    });
    renderPage({ pathname: "/admin", state: { fromMfa: true } });

    fireEvent.click(await screen.findByRole("button", { name: /reintentar/i }));

    expect(await screen.findByTestId("mfa")).toHaveTextContent(
      "/admin/mfa?returnTo=/admin",
    );
  });

  it("fromMfa NO concede nada: sin role admin el estado sigue siendo sin acceso y /me no se pide", async () => {
    signIn();
    routeFetch({ "/api/admin/access": () => access(null, true) });
    renderPage({ pathname: "/admin", state: { fromMfa: true } });

    expect(await screen.findByRole("alert")).toHaveTextContent(/no tienes acceso/i);
    expect(urls()).not.toContain("/api/admin/me");
    expect(screen.queryByTestId("mfa")).toBeNull();
  });
});

describe("/admin — revisión final: cambio de usuario", () => {
  function tree() {
    return (
      <QueryClientProvider client={testQueryClient}>
        <MemoryRouter initialEntries={["/admin"]}>
          <Routes>
            <Route path="/admin" element={<AdminDashboardPage />} />
            <Route path="/login" element={<Probe id="login" />} />
            <Route path="/admin/mfa" element={<Probe id="mfa" />} />
            <Route path="/account" element={<p>Account stub</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  it("A admin con panel → sesión pasa a B (sin rol): B ve sin acceso (no la revocación de A) y nada del panel de A", async () => {
    signIn("uA");
    routeFetch({
      "/api/admin/access": () =>
        authFakes.session?.user.id === "uA" ? access("admin", true) : access(null, false),
      "/api/admin/me": () => okMe(),
      ...withSections,
    });
    const view = renderPage();
    await screen.findByText(PANEL_TEXT);

    signIn("uB");
    view.rerender(tree());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No tienes acceso al panel de administración.",
    );
    expect(screen.queryByText(PANEL_TEXT)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Miembros del equipo" })).toBeNull();
    expect(screen.queryByTestId("mfa")).toBeNull();
  });

  it("A admin con panel → B admin: el panel de A no se reutiliza mientras /me de B está pendiente (sin destello)", async () => {
    signIn("uA");
    let releaseMeB: (v: unknown) => void = () => undefined;
    let meCalls = 0;
    (fetch as Mock).mockImplementation((url: string) => {
      if (url === "/api/admin/access") return Promise.resolve(access("admin", true));
      if (url === "/api/admin/me") {
        meCalls++;
        return meCalls === 1
          ? Promise.resolve(okMe())
          : new Promise((resolve) => (releaseMeB = resolve));
      }
      if (url === "/api/admin/social-status") return Promise.resolve(socialOk());
      if (url === "/api/admin/team-invitations")
        return Promise.resolve(emptyInvitations());
      return Promise.resolve(emptyMembers());
    });
    const view = renderPage();
    await screen.findByText(PANEL_TEXT);

    signIn("uB");
    view.rerender(tree());

    await waitFor(() => expect(meCalls).toBe(2));
    expect(screen.queryByText(PANEL_TEXT)).toBeNull();
    await act(async () => {
      releaseMeB(okMe());
    });
    expect(await screen.findByText(PANEL_TEXT)).toBeInTheDocument();
  });
});

describe("/admin — revisión final: fallos privilegiados concurrentes", () => {
  it("A. tres secciones con 403 genérico casi a la vez → role null → panel retirado, sin MFA y sin bucle", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": (n) => (n === 1 ? access("admin", true) : access(null, true)),
      "/api/admin/me": () => okMe(),
      "/api/admin/social-status": () => FORBIDDEN(),
      "/api/admin/team-invitations": () => FORBIDDEN(),
      "/api/admin/team-members": () => FORBIDDEN(),
    });
    renderPage();

    expect(
      await screen.findByText("Tu acceso administrativo ya no está disponible."),
    ).toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(screen.queryByTestId("mfa")).toBeNull();
    const settled = calls["/api/admin/access"];
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(calls["/api/admin/access"]).toBe(settled);
    expect(calls["/api/admin/me"]).toBe(1);
  });

  it("B. tres secciones con step_up_required → UNA navegación coherente a MFA, sin replay", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": (n) =>
        n === 1 ? access("admin", true) : access("admin", false),
      "/api/admin/me": () => okMe(),
      "/api/admin/social-status": () => STEP_UP(),
      "/api/admin/team-invitations": () => STEP_UP(),
      "/api/admin/team-members": () => STEP_UP(),
    });
    renderPage();

    expect(await screen.findAllByTestId("mfa")).toHaveLength(1);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(screen.getAllByTestId("mfa")).toHaveLength(1);
    for (const key of [
      "/api/admin/social-status",
      "/api/admin/team-invitations",
      "/api/admin/team-members",
    ]) {
      expect(calls[key]).toBe(1);
    }
    for (const call of (fetch as Mock).mock.calls) {
      expect(call[1]?.method ?? "GET").toBe("GET");
    }
  });

  it("C. 403 genérico + step_up_required a la vez → manda /access (role null): denegado, NUNCA MFA", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": (n) => (n === 1 ? access("admin", true) : access(null, false)),
      "/api/admin/me": () => okMe(),
      "/api/admin/social-status": () => FORBIDDEN(),
      "/api/admin/team-invitations": () => STEP_UP(),
      "/api/admin/team-members": () => STEP_UP(),
    });
    renderPage();

    expect(
      await screen.findByText("Tu acceso administrativo ya no está disponible."),
    ).toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(screen.queryByTestId("mfa")).toBeNull();
  });
});
