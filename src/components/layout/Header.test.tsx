import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";

// Estado de sesión en la navegación (Bloque 6B). Se usa el AuthProvider REAL y solo se
// mockea @/lib/supabase, para demostrar que Header responde al contexto global sin
// crear otro listener y sin consultar nada más (ni /api/admin/me, ni roles).

const EMAIL = "persona-sintetica@example.com";
const USER_ID = "user-id-sintetico-0001";

function fakeSession(): Session {
  return {
    access_token: "token-sintetico-de-prueba",
    refresh_token: "refresh-sintetico-de-prueba",
    expires_in: 3600,
    token_type: "bearer",
    user: { id: USER_ID, email: EMAIL } as Session["user"],
  } as Session;
}

const authFakes = vi.hoisted(() => ({
  session: null as unknown,
  sessionGate: null as null | Promise<void>,
  onAuthStateChangeCalls: 0,
  emit: undefined as ((session: unknown) => void) | undefined,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      async getSession() {
        if (authFakes.sessionGate) await authFakes.sessionGate;
        return { data: { session: authFakes.session } };
      },
      onAuthStateChange(callback: (event: string, session: unknown) => void) {
        authFakes.onAuthStateChangeCalls++;
        authFakes.emit = (session) => callback("SIGNED_IN", session);
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  },
}));

import { AuthProvider } from "@/lib/auth-context";
import Header from "./Header";

function renderHeader() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <Header onLogoDoubleClick={() => {}} />
      </AuthProvider>
    </MemoryRouter>,
  );
}

const LOGIN = /iniciar sesión/i;
const ACCOUNT = /^cuenta$/i;

// Sin /login ni /account todavía, ninguna de las dos etiquetas debe exponerse como
// control interactivo (button/link).
function expectNotInteractive() {
  for (const name of [LOGIN, ACCOUNT]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByRole("link", { name })).toBeNull();
  }
}

beforeEach(() => {
  authFakes.session = null;
  authFakes.sessionGate = null;
  authFakes.onAuthStateChangeCalls = 0;
  authFakes.emit = undefined;
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Header — estado de sesión (Bloque 6B)", () => {
  it("loading: no muestra 'Iniciar sesión' ni 'Cuenta' hasta resolver la sesión (ni en desktop ni en el menú móvil)", async () => {
    let release!: () => void;
    authFakes.sessionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    authFakes.session = fakeSession();

    renderHeader();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Abrir menú" }));

    expect(screen.queryByText(LOGIN)).toBeNull();
    expect(screen.queryByText(ACCOUNT)).toBeNull();

    await act(async () => {
      release();
    });

    expect(screen.getAllByText(ACCOUNT).length).toBeGreaterThan(0);
    expect(screen.queryByText(LOGIN)).toBeNull();
  });

  it("visitante: muestra 'Iniciar sesión' y no 'Cuenta', sin control interactivo", async () => {
    renderHeader();
    await act(async () => {});

    expect(screen.getByText(LOGIN)).toBeInTheDocument();
    expect(screen.queryByText(ACCOUNT)).toBeNull();
    expectNotInteractive();
  });

  it("sesión autenticada: muestra 'Cuenta' y no 'Iniciar sesión', sin control interactivo", async () => {
    authFakes.session = fakeSession();
    renderHeader();
    await act(async () => {});

    expect(screen.getByText(ACCOUNT)).toBeInTheDocument();
    expect(screen.queryByText(LOGIN)).toBeNull();
    expectNotInteractive();
  });

  it("es un elemento no interactivo: span sin tabindex, sin role y fuera de button/a", async () => {
    renderHeader();
    await act(async () => {});

    const el = screen.getByText(LOGIN);
    expect(el.tagName).toBe("SPAN");
    expect(el).not.toHaveAttribute("tabindex");
    expect(el).not.toHaveAttribute("role");
    expect(el.closest("button, a")).toBeNull();
  });

  it("cambio de sesión: responde al contexto global con un único listener", async () => {
    renderHeader();
    await act(async () => {});
    expect(screen.getByText(LOGIN)).toBeInTheDocument();

    act(() => authFakes.emit?.(fakeSession()));
    expect(screen.getByText(ACCOUNT)).toBeInTheDocument();

    act(() => authFakes.emit?.(null));
    expect(screen.getByText(LOGIN)).toBeInTheDocument();

    expect(authFakes.onAuthStateChangeCalls).toBe(1);
  });

  it("menú móvil: muestra el mismo estado dentro de #mobile-nav, sin control interactivo", async () => {
    renderHeader();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Abrir menú" }));

    const mobileNav = document.getElementById("mobile-nav") as HTMLElement;
    expect(within(mobileNav).getByText(LOGIN)).toBeInTheDocument();

    act(() => authFakes.emit?.(fakeSession()));
    expect(within(mobileNav).getByText(ACCOUNT)).toBeInTheDocument();
    expect(within(mobileNav).queryByText(LOGIN)).toBeNull();
    expectNotInteractive();
  });

  it("no llama a /api/admin/me ni a ninguna request, con o sin sesión", async () => {
    authFakes.session = fakeSession();
    renderHeader();
    await act(async () => {});
    act(() => authFakes.emit?.(null));

    expect(fetch).not.toHaveBeenCalled();
  });

  it("no muestra email, user_id ni datos de la sesión", async () => {
    authFakes.session = fakeSession();
    renderHeader();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Abrir menú" }));

    const html = document.body.innerHTML;
    expect(html).not.toContain(EMAIL);
    expect(html).not.toContain(USER_ID);
    expect(html).not.toContain("token-sintetico-de-prueba");
  });
});
