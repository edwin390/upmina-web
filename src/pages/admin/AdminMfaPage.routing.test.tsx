import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// Fija que /admin/mfa se sirve dentro del mismo AdminAuthLayout (AuthProvider real, no
// mockeado) que /admin/login y /admin/signup, exactamente como en App.tsx. A diferencia
// de AdminMfaPage.test.tsx (que mockea @/lib/auth-context para controlar cada estado),
// aquí se ejercita el AuthProvider de verdad: solo se mockea @/lib/supabase (con la
// misma superficie que usan AuthProvider y AdminMfaPage), para demostrar que el routing
// + contexto reales funcionan juntos y que, sin sesión, no se ejecuta ninguna operación
// MFA.

const supabaseFakes = vi.hoisted(() => ({
  mfaCalls: { getAAL: 0, listFactors: 0 },
}));

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
          supabaseFakes.mfaCalls.getAAL++;
          return { data: { currentLevel: "aal1" }, error: null };
        },
        async listFactors() {
          supabaseFakes.mfaCalls.listFactors++;
          return { data: { all: [], totp: [] }, error: null };
        },
      },
    },
  },
}));

import AdminAuthLayout from "./AdminAuthLayout";
import AdminMfaPage from "./AdminMfaPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("/admin/mfa dentro del área AuthProvider (routing real)", () => {
  it("se sirve bajo AdminAuthLayout y, sin sesión, no ejecuta ninguna operación MFA", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/mfa"]}>
        <Routes>
          <Route element={<AdminAuthLayout />}>
            <Route path="/admin/mfa" element={<AdminMfaPage />} />
            <Route path="/admin/login" element={<p>Login stub</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("link", { name: /iniciar sesión/i }),
    ).toBeInTheDocument();
    expect(supabaseFakes.mfaCalls.getAAL).toBe(0);
    expect(supabaseFakes.mfaCalls.listFactors).toBe(0);
  });
});
