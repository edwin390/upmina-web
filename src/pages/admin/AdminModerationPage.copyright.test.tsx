import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testQueryClient } from "@/test/query-client";

const authFakes = vi.hoisted(() => ({
  session: null as null | { access_token: string; user: { id: string } },
}));
const sbFakes = vi.hoisted(() => ({ getSession: vi.fn() }));
const copyright = vi.hoisted(() => ({ page: vi.fn(), detail: vi.fn(), review: vi.fn() }));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: authFakes.session,
    user: authFakes.session?.user ?? null,
    loading: false,
    signOut: vi.fn(),
  }),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: sbFakes.getSession } },
}));
vi.mock("@/lib/copyright-client", () => ({
  fetchCopyrightClaimPage: copyright.page,
  fetchCopyrightClaim: copyright.detail,
  reviewCopyrightClaim: copyright.review,
}));

import { ModerationClientError } from "@/lib/moderation-client";
import AdminModerationPage from "./AdminModerationPage";

// La pestaña de copyright dentro de /admin/moderation (COPY-1 fase 2A): separada de los reportes ordinarios, con el mismo
// control de acceso y la misma gestión de MFA. No repite las pruebas del panel de reportes (AdminModerationPage.test.tsx).

const json = (status: number, body: unknown) => ({
  ok: status < 400,
  status,
  json: async () => body,
});
function stubFetch(capabilities: string[], recent = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).startsWith("/api/admin/access")
        ? json(200, {
            role: capabilities.length ? "moderator" : null,
            capabilities,
            mfa: { recent },
          })
        : json(500, { error: "x" }),
    ),
  );
}
function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname}</p>;
}
function renderPage() {
  return render(
    <QueryClientProvider client={testQueryClient}>
      <MemoryRouter initialEntries={["/admin/moderation"]}>
        <Routes>
          <Route path="/admin/moderation" element={<AdminModerationPage />} />
          <Route path="/admin/mfa" element={<Where />} />
          <Route path="/login" element={<Where />} />
          <Route path="/account" element={<p>Cuenta</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem("upmina:locale", "es");
  testQueryClient.clear();
  authFakes.session = { access_token: "tok", user: { id: "mod-1" } };
  sbFakes.getSession.mockReset();
  sbFakes.getSession.mockResolvedValue({ data: { session: authFakes.session } });
  for (const m of Object.values(copyright)) m.mockReset();
  copyright.page.mockResolvedValue({ claims: [], nextCursor: null });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("pestaña de copyright en /admin/moderation", () => {
  it("muestra dos secciones separadas: reportes (por defecto) y copyright, sin tocar la cola de reportes", async () => {
    stubFetch(["moderation"]);
    renderPage();
    const nav = await screen.findByRole("navigation", {
      name: "Secciones de moderación",
    });
    const reports = within(nav).getByRole("button", { name: "Reportes de Community" });
    const claims = within(nav).getByRole("button", { name: "Copyright" });
    expect(reports.getAttribute("aria-pressed")).toBe("true");
    expect(claims.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Activos" })).toBeTruthy();
    expect(copyright.page).not.toHaveBeenCalled();

    fireEvent.click(claims);
    expect(
      await screen.findByRole("heading", { name: "Reclamaciones de copyright" }),
    ).toBeTruthy();
    expect(copyright.page).toHaveBeenCalledWith("open", null, expect.any(AbortSignal));
    expect(screen.queryByRole("button", { name: "Activos" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Copyright" }).getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Reportes de Community" }));
    expect(await screen.findByRole("button", { name: "Activos" })).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Reclamaciones de copyright" }),
    ).toBeNull();
  });

  it("un error de MFA de la cola de copyright lleva al flujo de verificación existente", async () => {
    stubFetch(["moderation"]);
    copyright.page.mockRejectedValue(
      new ModerationClientError("No autorizado", 403, "step_up_required"),
    );
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Copyright" }));
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe("/admin/mfa"),
    );
  });

  it("sin la capacidad de moderación no hay pestañas ni se consulta el servidor de copyright", async () => {
    stubFetch([]);
    renderPage();
    expect(
      await screen.findByText("No tienes acceso al panel de moderación."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copyright" })).toBeNull();
    expect(copyright.page).not.toHaveBeenCalled();
  });

  it("sin MFA reciente se redirige a verificar antes de mostrar nada de copyright", async () => {
    stubFetch(["moderation"], false);
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe("/admin/mfa"),
    );
    expect(copyright.page).not.toHaveBeenCalled();
  });
});
