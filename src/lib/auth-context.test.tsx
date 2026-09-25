import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Session } from "@supabase/supabase-js";

// Fija el contrato de AuthProvider/useAuth (Bloque 3A): restaura la sesión al montar,
// reacciona a onAuthStateChange, limpia la suscripción al desmontar y expone signOut.
// Deliberadamente NO prueba autorización (ADMIN/MODERATOR/AAL): este contexto solo
// resuelve identidad de Supabase Auth, nunca un rol (eso es responsabilidad exclusiva
// del backend, ver src/lib/admin-auth.ts).

function fakeSession(email = "fan@example.com"): Session {
  return {
    access_token: "token-sintetico-de-prueba",
    refresh_token: "refresh-sintetico-de-prueba",
    expires_in: 3600,
    token_type: "bearer",
    user: { id: "user-1", email } as Session["user"],
  } as Session;
}

const authFakes = vi.hoisted(() => ({
  session: null as Session | null,
  getSessionCalls: 0,
  onAuthStateChangeCalls: 0,
  unsubscribeCalls: 0,
  signOutCalls: 0,
  emitAuthChange: undefined as
    ((session: Session | null, event?: string) => void) | undefined,
}));

function resetAuthFakes() {
  authFakes.session = null;
  authFakes.getSessionCalls = 0;
  authFakes.onAuthStateChangeCalls = 0;
  authFakes.unsubscribeCalls = 0;
  authFakes.signOutCalls = 0;
  authFakes.emitAuthChange = undefined;
}

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      async getSession() {
        authFakes.getSessionCalls++;
        return { data: { session: authFakes.session } };
      },
      onAuthStateChange(callback: (event: string, session: Session | null) => void) {
        authFakes.onAuthStateChangeCalls++;
        authFakes.emitAuthChange = (session, event = "SIGNED_IN") =>
          callback(event, session);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                authFakes.unsubscribeCalls++;
              },
            },
          },
        };
      },
      async signOut() {
        authFakes.signOutCalls++;
      },
    },
  },
}));

import { AuthProvider, useAuth } from "./auth-context";
import {
  bindPendingInvitationToUser,
  capturePendingInvitation,
  clearPendingInvitation,
  hasPendingInvitation,
  readPendingInvitation,
} from "./pending-invitation";

function Probe() {
  const { session, user, loading, signOut } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="user-email">{user?.email ?? "ninguno"}</span>
      <span data-testid="session">{session ? "con-sesion" : "sin-sesion"}</span>
      <button onClick={() => void signOut()}>Salir</button>
    </div>
  );
}

beforeEach(() => {
  resetAuthFakes();
  clearPendingInvitation();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AuthProvider / useAuth", () => {
  it("useAuth fuera de AuthProvider lanza (evita usarlo sin contexto por accidente)", () => {
    function Bare() {
      useAuth();
      return null;
    }
    // Silencia el error esperado que React imprime en consola al lanzar en render.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Bare />)).toThrow(
      /useAuth debe usarse dentro de <AuthProvider>/,
    );
    spy.mockRestore();
  });

  it("estado inicial: loading=true hasta que getSession() resuelve, luego sin sesión", async () => {
    authFakes.session = null;
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await act(async () => {});

    expect(authFakes.getSessionCalls).toBe(1);
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(screen.getByTestId("session").textContent).toBe("sin-sesion");
    expect(screen.getByTestId("user-email").textContent).toBe("ninguno");
  });

  it("restaura la sesión existente al montar (recarga de página)", async () => {
    authFakes.session = fakeSession("admin@example.com");
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await act(async () => {});

    expect(screen.getByTestId("session").textContent).toBe("con-sesion");
    expect(screen.getByTestId("user-email").textContent).toBe("admin@example.com");
  });

  it("reacciona a un cambio de auth posterior (onAuthStateChange) sin volver a llamar a getSession()", async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await act(async () => {});
    expect(screen.getByTestId("session").textContent).toBe("sin-sesion");
    expect(authFakes.getSessionCalls).toBe(1);

    act(() => {
      authFakes.emitAuthChange?.(fakeSession("nuevo@example.com"));
    });

    expect(screen.getByTestId("session").textContent).toBe("con-sesion");
    expect(screen.getByTestId("user-email").textContent).toBe("nuevo@example.com");
    expect(authFakes.getSessionCalls).toBe(1);
  });

  it("un único listener: onAuthStateChange se suscribe exactamente una vez por montaje", async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await act(async () => {});

    expect(authFakes.onAuthStateChangeCalls).toBe(1);
  });

  it("cleanup: desmontar cancela la suscripción (unsubscribe)", async () => {
    const { unmount } = render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await act(async () => {});

    expect(authFakes.unsubscribeCalls).toBe(0);
    unmount();
    expect(authFakes.unsubscribeCalls).toBe(1);
  });

  it("desmontar antes de que cargue supabase-js (import diferido) no deja ninguna suscripción", async () => {
    const { unmount } = render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    unmount();
    await act(async () => {});

    expect(authFakes.onAuthStateChangeCalls).toBe(0);
    expect(authFakes.getSessionCalls).toBe(0);
  });

  it("signOut() llama a supabase.auth.signOut()", async () => {
    authFakes.session = fakeSession();
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await act(async () => {});

    screen.getByText("Salir").click();
    await act(async () => {});

    expect(authFakes.signOutCalls).toBe(1);
  });
});

// Ciclo de vida del token de invitación pendiente (9G-4), solo memoria: el logout lo destruye, un
// cambio de usuario destruye el asociado a la cuenta anterior y el login normal NO borra un token
// todavía sin asociar (es el que hace falta para autenticarse y volver a /admin/activate).
describe("AuthProvider — limpieza del token de invitación pendiente", () => {
  const TOKEN = "SyntheticInvitationTokenNotReal_0123456789ab";

  function userSession(id: string): Session {
    const base = fakeSession(`${id}@example.com`);
    return { ...base, user: { ...base.user, id } } as Session;
  }

  async function mountProvider() {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await act(async () => {});
  }

  it("SIGNED_OUT destruye el token, también el asociado a una cuenta", async () => {
    await mountProvider();
    capturePendingInvitation(TOKEN);
    bindPendingInvitationToUser("A");

    await act(async () => authFakes.emitAuthChange?.(null, "SIGNED_OUT"));

    expect(hasPendingInvitation()).toBe(false);
  });

  it("SIGNED_OUT destruye también un token todavía sin asociar", async () => {
    await mountProvider();
    capturePendingInvitation(TOKEN);

    await act(async () => authFakes.emitAuthChange?.(null, "SIGNED_OUT"));

    expect(hasPendingInvitation()).toBe(false);
  });

  it("el login normal (SIGNED_IN) NO borra un token sin asociar", async () => {
    await mountProvider();
    capturePendingInvitation(TOKEN);

    await act(async () => authFakes.emitAuthChange?.(userSession("A"), "SIGNED_IN"));

    expect(hasPendingInvitation()).toBe(true);
    expect(bindPendingInvitationToUser("A")).toBe(true);
    expect(readPendingInvitation("A")).toBe(TOKEN);
  });

  it("el estado inicial sin sesión (INITIAL_SESSION null) tampoco borra un token sin asociar", async () => {
    await mountProvider();
    capturePendingInvitation(TOKEN);

    await act(async () => authFakes.emitAuthChange?.(null, "INITIAL_SESSION"));

    expect(hasPendingInvitation()).toBe(true);
  });

  it("cambio de usuario A → B: el token asociado a A no sobrevive para B", async () => {
    await mountProvider();
    capturePendingInvitation(TOKEN);
    bindPendingInvitationToUser("A");

    await act(async () => authFakes.emitAuthChange?.(userSession("B"), "SIGNED_IN"));

    expect(hasPendingInvitation()).toBe(false);
    expect(bindPendingInvitationToUser("B")).toBe(false);
    expect(readPendingInvitation("B")).toBeNull();
  });

  it("refresh de token del MISMO usuario conserva el token asociado", async () => {
    await mountProvider();
    capturePendingInvitation(TOKEN);
    bindPendingInvitationToUser("A");

    await act(async () =>
      authFakes.emitAuthChange?.(userSession("A"), "TOKEN_REFRESHED"),
    );

    expect(readPendingInvitation("A")).toBe(TOKEN);
  });

  it("un token asociado no se conserva si la sesión desaparece sin SIGNED_OUT (null)", async () => {
    await mountProvider();
    capturePendingInvitation(TOKEN);
    bindPendingInvitationToUser("A");

    await act(async () => authFakes.emitAuthChange?.(null, "INITIAL_SESSION"));

    expect(hasPendingInvitation()).toBe(false);
  });

  it("signOut() no cambia su alcance: sigue llamando a supabase.auth.signOut() sin argumentos", async () => {
    await mountProvider();
    await act(async () => {
      screen.getByRole("button", { name: "Salir" }).click();
    });
    await act(async () => {});
    expect(authFakes.signOutCalls).toBe(1);
  });
});
