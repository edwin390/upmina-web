import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SignupPage from "./SignupPage";

const calls = vi.hoisted(() => [] as unknown[]);
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: null,
    user: null,
    loading: false,
    signOut: async () => {},
    refreshSession: async () => {},
  }),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      async signUp(args: unknown) {
        calls.push(args);
        return { data: { session: null }, error: null };
      },
    },
  },
}));

function fill() {
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "a@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Contraseña"), {
    target: { value: "Sintetica-123456" },
  });
  fireEvent.change(screen.getByLabelText("Confirmar contraseña"), {
    target: { value: "Sintetica-123456" },
  });
}
const submit = () => screen.getByRole("button", { name: "Crear cuenta" });

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("registro con aceptación legal", () => {
  it("desactivado (por defecto): sin casillas ni metadata", async () => {
    render(
      <MemoryRouter>
        <SignupPage />
      </MemoryRouter>,
    );
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    fill();
    fireEvent.click(submit());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(
      (calls[0] as { options: Record<string, unknown> }).options.data,
    ).toBeUndefined();
  });

  it("activado: el botón exige las tres y envía solo las versiones", async () => {
    vi.stubEnv("VITE_SIGNUP_LEGAL_CONSENT", "true");
    render(
      <MemoryRouter>
        <SignupPage />
      </MemoryRouter>,
    );
    fill();
    expect(submit()).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Aceptar todo"));
    expect(submit()).toBeEnabled();
    fireEvent.click(submit());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0] as { options: { data: unknown } }).options.data).toEqual({
      legal_acceptance: { terms: "v0.1", privacy: "v0.1", community_rules: "v0.1" },
    });
  });
});
