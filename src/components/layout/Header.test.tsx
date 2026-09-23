import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
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

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function renderHeader() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <Header onLogoDoubleClick={() => {}} />
        <LocationProbe />
      </AuthProvider>
    </MemoryRouter>,
  );
}

const LOGIN = /iniciar sesión/i;
const ACCOUNT = /^cuenta$/i;

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

  it("visitante: 'Iniciar sesión' es un enlace SPA a /login y no aparece 'Cuenta'", async () => {
    renderHeader();
    await act(async () => {});

    expect(screen.getByRole("link", { name: LOGIN })).toHaveAttribute("href", "/login");
    expect(screen.queryByText(ACCOUNT)).toBeNull();
  });

  it("visitante: hacer click en 'Iniciar sesión' navega a /login sin recargar", async () => {
    renderHeader();
    await act(async () => {});

    fireEvent.click(screen.getByRole("link", { name: LOGIN }));

    expect(screen.getByTestId("location")).toHaveTextContent("/login");
  });

  it("sesión autenticada: 'Cuenta' es un enlace SPA a /account y no aparece 'Iniciar sesión'", async () => {
    authFakes.session = fakeSession();
    renderHeader();
    await act(async () => {});

    expect(screen.getByRole("link", { name: ACCOUNT })).toHaveAttribute(
      "href",
      "/account",
    );
    expect(screen.queryByText(LOGIN)).toBeNull();
  });

  it("sesión autenticada: hacer click en 'Cuenta' navega a /account", async () => {
    authFakes.session = fakeSession();
    renderHeader();
    await act(async () => {});

    fireEvent.click(screen.getByRole("link", { name: ACCOUNT }));

    expect(screen.getByTestId("location")).toHaveTextContent("/account");
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

  it("menú móvil: mismo estado dentro de #mobile-nav (enlace a /login para visitante, a /account para autenticado)", async () => {
    renderHeader();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Abrir menú" }));

    const mobileNav = document.getElementById("mobile-nav") as HTMLElement;
    expect(within(mobileNav).getByRole("link", { name: LOGIN })).toHaveAttribute(
      "href",
      "/login",
    );

    act(() => authFakes.emit?.(fakeSession()));
    expect(within(mobileNav).getByRole("link", { name: ACCOUNT })).toHaveAttribute(
      "href",
      "/account",
    );
    expect(within(mobileNav).queryByText(LOGIN)).toBeNull();
  });

  it("menú móvil autenticado: pulsar 'Cuenta' navega a /account y cierra el menú", async () => {
    authFakes.session = fakeSession();
    renderHeader();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Abrir menú" }));
    const mobileNav = document.getElementById("mobile-nav") as HTMLElement;

    fireEvent.click(within(mobileNav).getByRole("link", { name: ACCOUNT }));

    expect(screen.getByTestId("location")).toHaveTextContent("/account");
    expect(document.getElementById("mobile-nav")).toBeNull();
  });

  it("menú móvil: pulsar 'Iniciar sesión' navega a /login y cierra el menú", async () => {
    renderHeader();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Abrir menú" }));
    const mobileNav = document.getElementById("mobile-nav") as HTMLElement;

    fireEvent.click(within(mobileNav).getByRole("link", { name: LOGIN }));

    expect(screen.getByTestId("location")).toHaveTextContent("/login");
    expect(document.getElementById("mobile-nav")).toBeNull();
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
