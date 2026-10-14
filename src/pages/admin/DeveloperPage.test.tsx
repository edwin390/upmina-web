import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";
import DeveloperPage from "./DeveloperPage";

// /admin/developer (Developer Panel V1): máquina de estados sobre GET /api/admin/access. El frontend
// solo PRESENTA lo que dice el servidor:
//   sin sesión → /login?returnTo=/admin/developer
//   rol != developer (USER, MODERATOR, ADMIN) → acceso denegado, SIN MFA
//   developer + mfa.recent=false → /admin/mfa?returnTo=/admin/developer
//   developer + mfa.recent=true → panel con las dos secciones

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
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: authFakes.session } }) },
  },
}));

const ALL_ADMIN = [
  "moderation",
  "technical",
  "social_admin",
  "team_admin",
  "cosplay_admin",
];
const CAPS: Record<string, string[]> = {
  admin: ALL_ADMIN,
  moderator: ["moderation"],
  developer: ["moderation", "technical", "developer_panel"],
};
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const access = (role: string | null, recent: boolean) =>
  ok({ role, capabilities: role ? CAPS[role] : [], mfa: { recent } });

function routeFetch(handlers: Record<string, () => unknown>) {
  (fetch as Mock).mockImplementation(async (url: string) => {
    const handler = handlers[url];
    if (!handler) throw new Error(`fetch inesperado a ${url}`);
    return handler();
  });
}
const urls = () => (fetch as Mock).mock.calls.map((c) => String(c[0]));

function Probe({ id }: { id: string }) {
  const location = useLocation();
  return (
    <p data-testid={id}>
      {location.pathname + location.search}
      {(location.state as { fromMfa?: unknown } | null)?.fromMfa ? " [fromMfa]" : ""}
    </p>
  );
}
function renderPage(
  entry: string | { pathname: string; state: unknown } = "/admin/developer",
) {
  return render(
    <QueryClientProvider client={testQueryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/admin/developer" element={<DeveloperPage />} />
          <Route path="/login" element={<Probe id="login" />} />
          <Route path="/admin/mfa" element={<Probe id="mfa" />} />
          <Route path="/account" element={<p>Account stub</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const signIn = (id = "u1") => {
  authFakes.session = { access_token: "at-sintetico", user: { id } };
};
const SECTIONS = {
  "/api/admin/developer-mfa-cleanups": () => ok({ cleanups: [] }),
  "/api/admin/developer-mfa-recoveries": () => ok({ recoveries: [] }),
  "/api/admin/account-deletion-alerts": () => ok({ alerts: [] }),
};

beforeEach(() => {
  testQueryClient.clear();
  authFakes.session = null;
  authFakes.loading = false;
  authFakes.signOut.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("/admin/developer — acceso", () => {
  it("mientras se resuelve la sesión no muestra nada ni llama a la API", () => {
    authFakes.loading = true;
    routeFetch({});
    renderPage();
    expect(screen.getByRole("status")).toHaveTextContent("Comprobando tu sesión…");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sin sesión → /login con returnTo=/admin/developer (destino de la allowlist) y sin llamadas", async () => {
    routeFetch({});
    renderPage();
    expect(await screen.findByTestId("login")).toHaveTextContent(
      "/login?returnTo=/admin/developer",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["admin", "moderator"])(
    "%s → acceso denegado SIN MFA: Developer y Admin son roles independientes",
    async (role) => {
      signIn();
      routeFetch({ "/api/admin/access": () => access(role, true) });
      renderPage();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "No tienes acceso al panel Developer.",
      );
      expect(screen.queryByTestId("mfa")).toBeNull();
      expect(screen.queryByText("Limpiezas de MFA pendientes")).toBeNull();
      // sin acceso no se pide NINGUNA sección
      expect(urls()).toEqual(["/api/admin/access"]);
    },
  );

  it("un USER (sin rol) → acceso denegado y sin llamadas a las secciones", async () => {
    signIn();
    routeFetch({ "/api/admin/access": () => access(null, false) });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("No tienes acceso");
    expect(urls()).toEqual(["/api/admin/access"]);
  });

  it("developer sin la capacidad developer_panel (respuesta inconsistente) → denegado", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": () =>
        ok({
          role: "developer",
          capabilities: ["moderation", "technical"],
          mfa: { recent: true },
        }),
    });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("No tienes acceso");
    expect(urls()).toEqual(["/api/admin/access"]);
  });

  it("un Admin NO entra aunque una respuesta inconsistente le atribuyera developer_panel", async () => {
    signIn();
    routeFetch({
      "/api/admin/access": () =>
        ok({
          role: "admin",
          capabilities: [...ALL_ADMIN, "developer_panel"],
          mfa: { recent: true },
        }),
    });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("No tienes acceso");
    expect(urls()).toEqual(["/api/admin/access"]);
  });

  it("developer con MFA vencido → /admin/mfa?returnTo=/admin/developer (step-up) y sin secciones", async () => {
    signIn();
    routeFetch({ "/api/admin/access": () => access("developer", false) });
    renderPage();
    expect(await screen.findByTestId("mfa")).toHaveTextContent(
      "/admin/mfa?returnTo=/admin/developer",
    );
    expect(urls()).toEqual(["/api/admin/access"]);
  });

  it("al volver de /admin/mfa sin que el servidor lo reconozca NO redirige otra vez (anti-bucle)", async () => {
    signIn();
    routeFetch({ "/api/admin/access": () => access("developer", false) });
    renderPage({ pathname: "/admin/developer", state: { fromMfa: true } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No pudimos confirmar tu verificación en dos pasos reciente.",
    );
    expect(screen.queryByTestId("mfa")).toBeNull();
    expect(screen.getByRole("link", { name: "Verificar de nuevo" })).toBeInTheDocument();
  });

  it("developer con MFA reciente → panel con las TRES secciones", async () => {
    signIn();
    routeFetch({ "/api/admin/access": () => access("developer", true), ...SECTIONS });
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "Limpiezas de MFA pendientes" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Recuperaciones excepcionales" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Eliminaciones de cuenta pendientes" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Panel Developer",
    );
    await waitFor(() =>
      expect(urls().sort()).toEqual(
        [
          "/api/admin/access",
          "/api/admin/account-deletion-alerts",
          "/api/admin/developer-mfa-cleanups",
          "/api/admin/developer-mfa-recoveries",
        ].sort(),
      ),
    );
  });

  it("el servidor rechaza una sección con 403 → se revalida el acceso y se retira el panel", async () => {
    signIn();
    let accessCalls = 0;
    routeFetch({
      "/api/admin/access": () =>
        access(accessCalls++ === 0 ? "developer" : "moderator", true),
      "/api/admin/developer-mfa-cleanups": () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: "No autorizado" }),
      }),
      "/api/admin/developer-mfa-recoveries": () => ok({ recoveries: [] }),
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Tu acceso Developer ya no está disponible.",
      ),
    );
    expect(screen.queryByTestId("mfa")).toBeNull(); // un 403 genérico NUNCA lleva a MFA
  });

  it("el estado de una persona no lo hereda otra (se remonta al cambiar de usuario)", async () => {
    signIn("dev-1");
    routeFetch({ "/api/admin/access": () => access("developer", true), ...SECTIONS });
    const view = renderPage();
    await screen.findByRole("heading", { name: "Limpiezas de MFA pendientes" });
    view.unmount();
    testQueryClient.clear();
    signIn("admin-1");
    routeFetch({ "/api/admin/access": () => access("admin", true) });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("No tienes acceso");
    expect(screen.queryByText("Limpiezas de MFA pendientes")).toBeNull();
  });
});
