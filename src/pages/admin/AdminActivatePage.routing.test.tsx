import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AdminAuthLayout from "./AdminAuthLayout";
import AdminActivatePage from "./AdminActivatePage";

// Fija que /admin/activate se sirve dentro del mismo AdminAuthLayout (AuthProvider real,
// no mockeado) que /admin/login, /admin/signup y /admin/mfa, exactamente como en
// App.tsx. A diferencia de AdminActivatePage.test.tsx (que mockea @/lib/auth-context
// para controlar cada estado), aquí se ejercita el AuthProvider de verdad: solo se
// mockea @/lib/supabase, para demostrar que el routing + contexto reales funcionan
// juntos y que, sin sesión, no se ejecuta ninguna operación de MFA ni de activación.
//
// AdminActivatePage captura el token del hash una vez por MONTAJE del componente (ver el
// comentario en AdminActivatePage.tsx), así que basta con fijar el hash antes de
// renderizar: no hace falta reimportar el módulo.

const supabaseFakes = vi.hoisted(() => ({
  calls: { getAAL: 0, fetch: 0 },
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
          supabaseFakes.calls.getAAL++;
          return { data: { currentLevel: "aal1" }, error: null };
        },
      },
    },
  },
}));

vi.stubGlobal(
  "fetch",
  vi.fn(() => {
    supabaseFakes.calls.fetch++;
    return Promise.reject(new Error("no debería llamarse"));
  }),
);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("/admin/activate dentro del área AuthProvider (routing real)", () => {
  it("se sirve bajo AdminAuthLayout y, sin sesión, no ejecuta ninguna operación de MFA ni de activación", async () => {
    window.history.replaceState(
      null,
      "",
      "/admin/activate#token=synthetic-routing-token",
    );

    render(
      <MemoryRouter initialEntries={["/admin/activate"]}>
        <Routes>
          <Route element={<AdminAuthLayout />}>
            <Route path="/admin/activate" element={<AdminActivatePage />} />
            <Route path="/admin/login" element={<p>Login stub</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("link", { name: /iniciar sesión/i }),
    ).toBeInTheDocument();
    expect(supabaseFakes.calls.getAAL).toBe(0);
    expect(supabaseFakes.calls.fetch).toBe(0);
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain("synthetic-routing-token");
  });
});
