import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testQueryClient } from "@/test/query-client";

const authFakes = vi.hoisted(() => ({ session: null as null | { access_token: string; user: { id: string } } }));
const sbFakes = vi.hoisted(() => ({ getSession: vi.fn() }));
const review = vi.hoisted(() => ({ page: vi.fn(), decide: vi.fn() }));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: authFakes.session, user: authFakes.session?.user ?? null, loading: false, signOut: vi.fn() }),
}));
vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: sbFakes.getSession } } }));
vi.mock("@/lib/content-review-client", () => ({
  fetchContentReviewPage: review.page,
  decideContentReview: review.decide,
}));

import { ModerationClientError } from "@/lib/moderation-client";
import AdminModerationPage from "./AdminModerationPage";

// Fase 3: «Revisión de contenido» como tercer apartado de /admin/moderation, junto a Reportes y Copyright. Mismo control de
// acceso y mismo manejo de MFA; no repite las pruebas del panel (ContentReviewPanel.test.tsx).

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
function stubFetch(capabilities: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).startsWith("/api/admin/access")
        ? json(200, { role: capabilities.length ? "moderator" : null, capabilities, mfa: { recent: true } })
        : json(500, { error: "x" }),
    ),
  );
}
function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
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
  review.page.mockReset();
  review.decide.mockReset();
  review.page.mockResolvedValue({ items: [], nextCursor: null, counts: { held: 0, edits: 0 } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("apartado «Revisión de contenido» en /admin/moderation", () => {
  it("aparece como tercera sección y no toca la cola de reportes ni la de copyright", async () => {
    stubFetch(["moderation"]);
    renderPage();
    const nav = await screen.findByRole("navigation", { name: "Secciones de moderación" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["Reportes de Community", "Copyright", "Revisión de contenido"]);
    expect(review.page).not.toHaveBeenCalled();
    fireEvent.click(within(nav).getByRole("button", { name: "Revisión de contenido" }));
    expect(await screen.findByRole("heading", { name: "Revisión de contenido", level: 2 })).toBeTruthy();
    expect(review.page).toHaveBeenCalledWith("held", null, expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: /Publicaciones retenidas/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ediciones pendientes/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Activos" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reportes de Community" }));
    expect(await screen.findByRole("button", { name: "Activos" })).toBeTruthy();
  });

  it("sin capacidad de moderación no se llega a la cola", async () => {
    stubFetch([]);
    renderPage();
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Secciones de moderación" })).toBeNull());
    expect(review.page).not.toHaveBeenCalled();
  });

  it("un error de MFA de la cola lleva al flujo de verificación existente", async () => {
    stubFetch(["moderation"]);
    review.page.mockRejectedValue(new ModerationClientError("No autorizado", 403, "step_up_required"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Revisión de contenido" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/admin/mfa"));
  });
});
