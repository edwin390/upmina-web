import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { testQueryClient } from "@/test/query-client";

// Fija que /admin se sirve dentro del mismo AdminAuthLayout (AuthProvider real, no
// mockeado) que /admin/login, /admin/signup, /admin/mfa y /admin/activate, exactamente
// como en App.tsx. A diferencia de AdminDashboardPage.test.tsx (que mockea
// @/lib/auth-context para controlar cada estado), aquí se ejercita el AuthProvider de
// verdad: solo se mockea @/lib/supabase, para demostrar que el routing + contexto reales
// funcionan juntos y que, sin sesión, nunca se llama a /api/admin/me.

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      async getSession() {
        return { data: { session: null } };
      },
      onAuthStateChange() {
        return { data: { subscription: { unsubscribe() {} } } };
      },
      mfa: {
        async getAuthenticatorAssuranceLevel() {
          return { data: { currentLevel: "aal1" }, error: null };
        },
      },
    },
  },
}));

import { AuthProvider } from "@/lib/auth-context";
import AdminAuthLayout from "./AdminAuthLayout";
import AdminDashboardPage from "./AdminDashboardPage";

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="login-location">{location.pathname + location.search}</p>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("/admin dentro del área AuthProvider (routing real)", () => {
  it("se sirve bajo AdminAuthLayout y, sin sesión, no llama a /api/admin/me", async () => {
    vi.stubGlobal("fetch", vi.fn());

    testQueryClient.clear();
    render(
      <QueryClientProvider client={testQueryClient}>
        <MemoryRouter initialEntries={["/admin"]}>
          <AuthProvider>
            <Routes>
              <Route element={<AdminAuthLayout />}>
                <Route path="/admin" element={<AdminDashboardPage />} />
              </Route>
              <Route path="/login" element={<LocationProbe />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Sin sesión: /admin redirige a /login con returnTo=/admin (destino de la allowlist).
    const probe = await screen.findByTestId("login-location");
    expect(probe).toHaveTextContent("/login?returnTo=/admin");
    expect(fetch).not.toHaveBeenCalled();
  });
});
