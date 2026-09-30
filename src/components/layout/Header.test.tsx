import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";

// Estado de sesión en la navegación (Bloque 6B; renombrado "Cuenta" -> "Perfil" y destino
// dinámico en 9J-2B.1). Se usa el AuthProvider REAL y solo se mockea @/lib/supabase, para
// demostrar que Header responde al contexto global sin crear otro listener y sin consultar nada
// más (ni /api/admin/me, ni roles). useOwnProfile() se mockea aparte (es SOLO para decidir el
// destino de "Perfil" — su propia lógica de lectura ya está cubierta por useOwnProfile.test.ts).

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

const ownProfileFakes = vi.hoisted(() => ({
  profile: null as {
    username: string;
    displayName: string | null;
    bio: string | null;
  } | null,
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

vi.mock("@/hooks/useOwnProfile", () => ({
  useOwnProfile: () => ({
    profile: ownProfileFakes.profile,
    isLoading: false,
    hasSession: true,
    isError: false,
    invalidate: async () => {},
  }),
}));

import { AuthProvider } from "@/lib/auth-context";
import Header from "./Header";

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function renderHeader() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <Header onLogoDoubleClick={() => {}} />
          <LocationProbe />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const LOGIN = /iniciar sesión/i;
const PERFIL = /^perfil$/i;

beforeEach(() => {
  authFakes.session = null;
  authFakes.sessionGate = null;
  authFakes.onAuthStateChangeCalls = 0;
  authFakes.emit = undefined;
  ownProfileFakes.profile = null;
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Header — estado de sesión (Bloque 6B)", () => {
  it("loading: no muestra 'Iniciar sesión' ni 'Perfil' hasta resolver la sesión (ni en desktop ni en el menú móvil)", async () => {
    let release!: () => void;
    authFakes.sessionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    authFakes.session = fakeSession();

    renderHeader();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Abrir menú" }));

    expect(screen.queryByText(LOGIN)).toBeNull();
    expect(screen.queryByText(PERFIL)).toBeNull();

    await act(async () => {
      release();
    });

    expect(screen.getAllByText(PERFIL).length).toBeGreaterThan(0);
    expect(screen.queryByText(LOGIN)).toBeNull();
  });

  it("visitante: 'Iniciar sesión' es un enlace SPA a /login y no aparece 'Perfil'", async () => {
    renderHeader();
    await act(async () => {});

    expect(screen.getByRole("link", { name: LOGIN })).toHaveAttribute("href", "/login");
    expect(screen.queryByText(PERFIL)).toBeNull();
  });

  it("visitante: hacer click en 'Iniciar sesión' navega a /login sin recargar", async () => {
    renderHeader();
    await act(async () => {});

    fireEvent.click(screen.getByRole("link", { name: LOGIN }));

    expect(screen.getByTestId("location")).toHaveTextContent("/login");
  });

  it("sesión autenticada SIN username configurado: 'Perfil' apunta a /account (hay que configurar el perfil primero)", async () => {
    authFakes.session = fakeSession();
    ownProfileFakes.profile = null;
    renderHeader();
    await act(async () => {});

    expect(screen.getByRole("link", { name: PERFIL })).toHaveAttribute(
      "href",
      "/account",
    );
    expect(screen.queryByText(LOGIN)).toBeNull();
  });

  it("sesión autenticada CON username configurado: 'Perfil' apunta a /@username", async () => {
    authFakes.session = fakeSession();
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    renderHeader();
    await act(async () => {});

    expect(screen.getByRole("link", { name: PERFIL })).toHaveAttribute(
      "href",
      "/@edwin1",
    );
  });

  it("sesión autenticada: hacer click en 'Perfil' navega a /account cuando no hay username", async () => {
    authFakes.session = fakeSession();
    renderHeader();
    await act(async () => {});

    fireEvent.click(screen.getByRole("link", { name: PERFIL }));

    expect(screen.getByTestId("location")).toHaveTextContent("/account");
  });

  it("cambio de sesión: responde al contexto global con un único listener", async () => {
    renderHeader();
    await act(async () => {});
    expect(screen.getByText(LOGIN)).toBeInTheDocument();

    act(() => authFakes.emit?.(fakeSession()));
    expect(screen.getByText(PERFIL)).toBeInTheDocument();

    act(() => authFakes.emit?.(null));
    expect(screen.getByText(LOGIN)).toBeInTheDocument();

    expect(authFakes.onAuthStateChangeCalls).toBe(1);
  });

  it("menú móvil: mismo estado dentro de #mobile-nav (enlace a /login para visitante, a /account para autenticado sin username)", async () => {
    renderHeader();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Abrir menú" }));

    const mobileNav = document.getElementById("mobile-nav") as HTMLElement;
    expect(within(mobileNav).getByRole("link", { name: LOGIN })).toHaveAttribute(
      "href",
      "/login",
    );

    act(() => authFakes.emit?.(fakeSession()));
    expect(within(mobileNav).getByRole("link", { name: PERFIL })).toHaveAttribute(
      "href",
      "/account",
    );
    expect(within(mobileNav).queryByText(LOGIN)).toBeNull();
  });

  it("menú móvil autenticado: pulsar 'Perfil' navega y cierra el menú", async () => {
    authFakes.session = fakeSession();
    renderHeader();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Abrir menú" }));
    const mobileNav = document.getElementById("mobile-nav") as HTMLElement;

    fireEvent.click(within(mobileNav).getByRole("link", { name: PERFIL }));

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
