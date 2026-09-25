import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { testQueryClient } from "@/test/query-client";
import {
  bindPendingInvitationToUser,
  capturePendingInvitation,
  clearPendingInvitation,
  hasPendingInvitation,
  readPendingInvitation,
} from "@/lib/pending-invitation";
import AdminActivatePage from "./AdminActivatePage";

// Flujo de invitación (Fase 9G-4): captura del #token en MEMORIA → login normal → bind al usuario →
// MFA reciente (según /access) → clic EXPLÍCITO en "Activar acceso" → POST /activate → destino por
// rol. El token se lee (no se consume) antes del POST para poder reintentar; solo se borra con
// éxito o rechazo terminal. Todos los tokens y sesiones son sintéticos.

const authFakes = vi.hoisted(() => ({
  session: null as null | { access_token: string; user: { id: string } },
  loading: false,
  signOut: vi.fn(),
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: authFakes.session,
    user: authFakes.session?.user ?? null,
    loading: authFakes.loading,
    signOut: authFakes.signOut,
  }),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      async getSession() {
        return { data: { session: authFakes.session } };
      },
    },
  },
}));

const TOKEN = "SyntheticInvitationTokenNotReal_0123456789ab";
const TOKEN_2 = "SyntheticSecondInvitationNotReal_9876543210zz";

const json = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const access = (role: string | null, recent: boolean) =>
  json(200, { role, capabilities: [], mfa: { recent } });
const STEP_UP = () => json(403, { error: "No autorizado", code: "step_up_required" });

const state = {
  access: (() => access(null, true)) as () => unknown,
  activate: (() => json(200, { role: "admin" })) as (n: number) => unknown,
  activateCalls: 0,
  accessCalls: 0,
};

const navLog: string[] = [];
const navKeys = new Set<string>();

function Probe({ id }: { id: string }) {
  const location = useLocation();
  const line = `${id}:${location.pathname}${location.search}`;
  navLog.push(line);
  navKeys.add(`${id}:${location.key}`);
  const fromMfa = Boolean((location.state as { fromMfa?: unknown } | null)?.fromMfa);
  return (
    <p data-testid={id}>
      {location.pathname + location.search}
      {fromMfa ? " [fromMfa]" : ""}
    </p>
  );
}

/** Login normal simulado: autentica y vuelve al returnTo (como LoginPage con parseSafeReturnTo). */
function LoginStub() {
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = new URLSearchParams(location.search).get("returnTo") ?? "/";
  return (
    <div>
      <Probe id="login" />
      <button
        onClick={() => {
          authFakes.session = { access_token: "at-A", user: { id: "A" } };
          navigate(returnTo);
        }}
      >
        entrar-A
      </button>
    </div>
  );
}

/** MFA simulado: el servidor pasa a recent=true y se vuelve al returnTo con fromMfa. */
function MfaStub() {
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = new URLSearchParams(location.search).get("returnTo") ?? "/account";
  return (
    <div>
      <Probe id="mfa" />
      <button
        onClick={() => {
          state.access = () => access(null, true);
          navigate(returnTo, { replace: true, state: { fromMfa: true } });
        }}
      >
        verificar-mfa
      </button>
    </div>
  );
}

function tree(entry: string | { pathname: string; state: unknown } = "/admin/activate") {
  return (
    <QueryClientProvider client={testQueryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/admin/activate" element={<AdminActivatePage />} />
          <Route path="/login" element={<LoginStub />} />
          <Route path="/admin/mfa" element={<MfaStub />} />
          <Route path="/admin" element={<Probe id="admin" />} />
          <Route path="/account" element={<Probe id="account" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function setHash(hash: string) {
  window.history.replaceState(null, "", "/admin/activate" + hash);
}

function signIn(userId = "A") {
  authFakes.session = { access_token: `at-${userId}`, user: { id: userId } };
}

const activateButton = () => screen.findByRole("button", { name: "Activar acceso" });
const unavailable = () => screen.findByText(/ya no está disponible en esta sesión/i);

function postedBodies(): unknown[] {
  return (fetch as Mock).mock.calls
    .filter(([url]) => url === "/api/admin/activate")
    .map(([, init]) => JSON.parse((init as { body: string }).body));
}

beforeEach(() => {
  testQueryClient.clear();
  clearPendingInvitation();
  navLog.length = 0;
  navKeys.clear();
  authFakes.session = null;
  authFakes.loading = false;
  authFakes.signOut.mockReset();
  state.access = () => access(null, true);
  state.activate = () => json(200, { role: "admin" });
  state.activateCalls = 0;
  state.accessCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/admin/access") {
        state.accessCalls++;
        return state.access();
      }
      if (url === "/api/admin/activate") {
        state.activateCalls++;
        return state.activate(state.activateCalls);
      }
      throw new Error(`fetch inesperado a ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  clearPendingInvitation();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("captura y limpieza del token", () => {
  it("captura el token del hash y limpia el fragmento sin crear otra entrada de historial", async () => {
    window.history.replaceState({ usr: null, key: "k", idx: 3 }, "", "/admin/activate#x");
    setHash(`#token=${TOKEN}`);
    const lengthBefore = window.history.length;
    render(tree());
    await screen.findByTestId("login");

    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.location.pathname).toBe("/admin/activate");
    expect(window.history.length).toBe(lengthBefore);
    expect(hasPendingInvitation()).toBe(true);
  });

  it("conserva el state de history que usa React Router al limpiar el hash", async () => {
    window.history.replaceState(
      { usr: null, key: "k", idx: 3 },
      "",
      `/admin/activate#token=${TOKEN}`,
    );
    render(tree());
    await screen.findByTestId("login");

    expect(window.history.state).toEqual({ usr: null, key: "k", idx: 3 });
  });

  it("el token capturado no vuelve a la URL ni se escribe en storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    setHash(`#token=${TOKEN}`);
    render(tree());
    await screen.findByTestId("login");

    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.location.href).not.toContain(TOKEN);
  });

  it("token con formato inválido → estado seguro, sin sesión ni peticiones", async () => {
    setHash("#token=inv%C3%A1lido con espacios");
    render(tree());

    expect(await unavailable()).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(hasPendingInvitation()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("un enlace inválido es el último abierto: no se sigue usando un token anterior", async () => {
    capturePendingInvitation(TOKEN);
    setHash("#foo=bar");
    signIn();
    render(tree());

    expect(await unavailable()).toBeInTheDocument();
    expect(hasPendingInvitation()).toBe(false);
    expect(screen.queryByRole("button", { name: "Activar acceso" })).toBeNull();
  });

  it("sin token (ni hash ni memoria) → estado seguro con la instrucción de reabrir el enlace", async () => {
    signIn();
    render(tree());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Este enlace de invitación ya no está disponible en esta sesión. Vuelve a abrir el enlace original.",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("refresco completo: la memoria se pierde y la página pide reabrir el enlace (sin storage ni hash)", async () => {
    setHash(`#token=${TOKEN}`);
    const first = render(tree());
    await screen.findByTestId("login");
    first.unmount();

    // Un refresco completo reinicia el módulo: aquí equivale a vaciar la memoria.
    clearPendingInvitation();
    signIn();
    render(tree());

    expect(await unavailable()).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bajo React.StrictMode el token sigue disponible (la doble invocación no lo pierde)", async () => {
    signIn();
    setHash(`#token=${TOKEN}`);
    render(<React.StrictMode>{tree()}</React.StrictMode>);

    expect(await activateButton()).toBeInTheDocument();
    fireEvent.click(await activateButton());
    await waitFor(() => expect(postedBodies()).toEqual([{ token: TOKEN }]));
  });

  it("T1 sin asociar → abrir T2: T2 reemplaza a T1 y es el que se envía", async () => {
    signIn();
    capturePendingInvitation(TOKEN);
    setHash(`#token=${TOKEN_2}`);
    render(tree());

    fireEvent.click(await activateButton());
    await waitFor(() => expect(postedBodies()).toEqual([{ token: TOKEN_2 }]));
  });

  it("T1 asociado a A → abrir T2: T2 queda sin asociar y A lo vuelve a asociar antes de usarlo", async () => {
    signIn("A");
    capturePendingInvitation(TOKEN);
    bindPendingInvitationToUser("A");
    setHash(`#token=${TOKEN_2}`);
    render(tree());

    fireEvent.click(await activateButton());
    await waitFor(() => expect(postedBodies()).toEqual([{ token: TOKEN_2 }]));
    expect(postedBodies()).not.toContainEqual({ token: TOKEN });
  });
});

describe("sin sesión → login normal", () => {
  it("navega a /login?returnTo=/admin/activate sin token en la URL y lo conserva solo en memoria", async () => {
    setHash(`#token=${TOKEN}`);
    render(tree());

    expect(await screen.findByTestId("login")).toHaveTextContent(
      "/login?returnTo=/admin/activate",
    );
    expect(navLog.join("\n")).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
    expect(readPendingInvitation(null)).toBe(TOKEN);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("mientras la sesión carga no redirige ni consulta nada", () => {
    authFakes.loading = true;
    setHash(`#token=${TOKEN}`);
    render(tree());

    expect(screen.getByRole("status")).toHaveTextContent(/comprobando tu sesión/i);
    expect(screen.queryByTestId("login")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("recorrido completo: enlace → login → MFA → activar", () => {
  it("el token sobrevive a login y MFA, no se activa solo al volver, y solo se envía tras el clic", async () => {
    state.access = () => access(null, false);
    setHash(`#token=${TOKEN}`);
    render(tree());

    // 1) sin sesión → login normal
    fireEvent.click(await screen.findByRole("button", { name: "entrar-A" }));

    // 2) vuelve a /admin/activate, se asocia a A y, sin MFA reciente, va a MFA
    expect(await screen.findByTestId("mfa")).toHaveTextContent(
      "/admin/mfa?returnTo=/admin/activate",
    );
    expect(readPendingInvitation("A")).toBe(TOKEN);
    expect(state.activateCalls).toBe(0);

    // 3) MFA verificado → vuelve a /admin/activate con fromMfa
    fireEvent.click(screen.getByRole("button", { name: "verificar-mfa" }));
    const button = await activateButton();

    // NO se activa automáticamente al volver del MFA.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(state.activateCalls).toBe(0);
    expect(readPendingInvitation("A")).toBe(TOKEN);

    // 4) clic explícito → POST y destino
    fireEvent.click(button);
    expect(await screen.findByTestId("admin")).toHaveTextContent("/admin");
    expect(postedBodies()).toEqual([{ token: TOKEN }]);
    expect(navLog.join("\n")).not.toContain(TOKEN);
    expect(hasPendingInvitation()).toBe(false);
  });
});

describe("asociación al usuario", () => {
  it("token sin asociar + usuario A autenticado → se asocia a A (sin consumirlo)", async () => {
    signIn("A");
    setHash(`#token=${TOKEN}`);
    render(tree());
    await activateButton();

    expect(readPendingInvitation("A")).toBe(TOKEN);
    expect(readPendingInvitation("B")).toBeNull();
  });

  it("token asociado a A + A → permitido", async () => {
    signIn("A");
    capturePendingInvitation(TOKEN);
    bindPendingInvitationToUser("A");
    render(tree());

    expect(await activateButton()).toBeInTheDocument();
  });

  it("token asociado a A + usuario B → falla cerrado y el token se destruye", async () => {
    signIn("B");
    capturePendingInvitation(TOKEN);
    bindPendingInvitationToUser("A");
    render(tree());

    expect(await unavailable()).toBeInTheDocument();
    expect(hasPendingInvitation()).toBe(false);
    expect(screen.queryByRole("button", { name: "Activar acceso" })).toBeNull();
    expect(state.activateCalls).toBe(0);
  });

  it("cambio de usuario A → B con la página montada: B no puede usar el token de A", async () => {
    signIn("A");
    setHash(`#token=${TOKEN}`);
    const view = render(tree());
    await activateButton();

    signIn("B");
    view.rerender(tree());

    expect(await unavailable()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activar acceso" })).toBeNull();
    expect(hasPendingInvitation()).toBe(false);
  });
});

describe("MFA antes de activar (según /access, no aal2)", () => {
  it("sin MFA reciente → /admin/mfa?returnTo=/admin/activate (también con una cuenta SIN rol)", async () => {
    signIn();
    state.access = () => access(null, false);
    setHash(`#token=${TOKEN}`);
    render(tree());

    expect(await screen.findByTestId("mfa")).toHaveTextContent(
      "/admin/mfa?returnTo=/admin/activate",
    );
    expect(navLog.join("\n")).not.toContain(TOKEN);
    expect(state.activateCalls).toBe(0);
  });

  it("con MFA reciente no se repite el MFA y se muestra el botón explícito", async () => {
    signIn();
    setHash(`#token=${TOKEN}`);
    render(tree());

    expect(await activateButton()).toBeInTheDocument();
    expect(screen.queryByTestId("mfa")).toBeNull();
    expect(state.activateCalls).toBe(0);
  });

  it("vuelve del MFA pero el servidor aún dice recent=false → NO redirige otra vez (sin bucle)", async () => {
    signIn();
    capturePendingInvitation(TOKEN);
    state.access = () => access(null, false);
    render(tree({ pathname: "/admin/activate", state: { fromMfa: true } }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no pudimos confirmar tu verificación/i,
    );
    expect(screen.queryByTestId("mfa")).toBeNull();
    expect(screen.getByRole("link", { name: /verificar de nuevo/i })).toHaveAttribute(
      "href",
      "/admin/mfa?returnTo=/admin/activate",
    );
    expect(state.accessCalls).toBe(1);
  });

  it("/access 401 → sesión inválida sin navegar ni activar; el token no se filtra", async () => {
    signIn();
    state.access = () => json(401);
    setHash(`#token=${TOKEN}`);
    render(tree());

    expect(await screen.findByRole("alert")).toHaveTextContent(/sesión ya no es válida/i);
    expect(screen.queryByTestId("mfa")).toBeNull();
    expect(screen.queryByRole("button", { name: "Activar acceso" })).toBeNull();
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("/access 500 → error con reintento, sin navegar ni activar", async () => {
    signIn();
    state.access = () => json(500);
    setHash(`#token=${TOKEN}`);
    render(tree());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no se pudo comprobar tu estado/i,
    );
    expect(screen.getByRole("button", { name: /reintentar/i })).toBeInTheDocument();
    expect(screen.queryByTestId("mfa")).toBeNull();
    expect(state.activateCalls).toBe(0);
  });
});

describe("activación explícita", () => {
  async function ready() {
    signIn();
    setHash(`#token=${TOKEN}`);
    render(tree());
    return activateButton();
  }

  it("no llama a /activate al cargar; el POST lleva Bearer, JSON y body EXCLUSIVAMENTE { token }", async () => {
    const button = await ready();
    expect(state.activateCalls).toBe(0);

    fireEvent.click(button);
    await screen.findByTestId("admin");

    const [, init] = (fetch as Mock).mock.calls.find(
      ([url]) => url === "/api/admin/activate",
    )!;
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer at-A");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ token: TOKEN });
  });

  it("éxito admin: borra el token, revalida /access (sin inyectar rol) y va a /admin", async () => {
    const button = await ready();
    const before = state.accessCalls;
    fireEvent.click(button);

    expect(await screen.findByTestId("admin")).toHaveTextContent("/admin");
    expect(hasPendingInvitation()).toBe(false);
    expect(state.accessCalls).toBeGreaterThan(before);
  });

  it("éxito moderator: borra el token y va a /account (sin panel ni placeholder)", async () => {
    state.activate = () => json(200, { role: "moderator" });
    fireEvent.click(await ready());

    expect(await screen.findByTestId("account")).toHaveTextContent("/account");
    expect(hasPendingInvitation()).toBe(false);
    expect(screen.queryByText(/panel/i)).toBeNull();
  });

  it("éxito con un rol inesperado (developer/desconocido) → /account y token borrado (el backend ya lo consumió)", async () => {
    state.activate = () => json(200, { role: "developer" });
    fireEvent.click(await ready());

    expect(await screen.findByTestId("account")).toHaveTextContent("/account");
    expect(hasPendingInvitation()).toBe(false);
  });

  it("400 (rechazo terminal): borra el token, muestra un error seguro y no ofrece reintento", async () => {
    state.activate = () => json(400, { error: "No se pudo activar la invitación" });
    fireEvent.click(await ready());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "La invitación no es válida, expiró o ya fue utilizada.",
    );
    expect(hasPendingInvitation()).toBe(false);
    expect(screen.queryByRole("button", { name: "Activar acceso" })).toBeNull();
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("500: conserva el token y permite reintentar sin reabrir el enlace", async () => {
    state.activate = (n) =>
      n === 1 ? json(500, { error: "Error interno" }) : json(200, { role: "admin" });
    const button = await ready();
    fireEvent.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent(/error interno/i);
    expect(readPendingInvitation("A")).toBe(TOKEN);

    fireEvent.click(await activateButton());
    expect(await screen.findByTestId("admin")).toBeInTheDocument();
    expect(postedBodies()).toEqual([{ token: TOKEN }, { token: TOKEN }]);
    expect(hasPendingInvitation()).toBe(false);
  });

  it("fallo de red: conserva el token y permite reintentar", async () => {
    let n = 0;
    (fetch as Mock).mockImplementation(async (url: string) => {
      if (url === "/api/admin/access") return access(null, true);
      n++;
      if (n === 1) throw new TypeError("Failed to fetch");
      return json(200, { role: "moderator" });
    });
    fireEvent.click(await ready());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/no se pudo conectar/i);
    expect(alert.textContent).not.toContain("Failed to fetch");
    expect(readPendingInvitation("A")).toBe(TOKEN);

    fireEvent.click(await activateButton());
    expect(await screen.findByTestId("account")).toBeInTheDocument();
  });

  it("401: conserva el token, ofrece iniciar sesión con returnTo seguro y no lo filtra", async () => {
    state.activate = () => json(401, { error: "No autenticado" });
    fireEvent.click(await ready());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/sesión expiró o no es válida/i);
    expect(screen.getByRole("link", { name: /iniciar sesión/i })).toHaveAttribute(
      "href",
      "/login?returnTo=/admin/activate",
    );
    expect(readPendingInvitation("A")).toBe(TOKEN);
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("403 genérico (sin code): conserva el token, error genérico y NUNCA MFA", async () => {
    state.activate = () => json(403, { error: "No autorizado" });
    fireEvent.click(await ready());

    expect(await screen.findByRole("alert")).toHaveTextContent(/error interno/i);
    expect(screen.queryByTestId("mfa")).toBeNull();
    expect(readPendingInvitation("A")).toBe(TOKEN);
  });

  it("step_up_required: conserva el token → MFA → vuelve → NO se activa solo → otro clic explícito", async () => {
    state.activate = (n) => (n === 1 ? STEP_UP() : json(200, { role: "admin" }));
    const button = await ready();
    // El MFA vence justo antes de activar: /access aún decía recent=true; tras el rechazo dice false.
    state.access = () => access(null, false);
    fireEvent.click(button);

    expect(await screen.findByTestId("mfa")).toHaveTextContent(
      "/admin/mfa?returnTo=/admin/activate",
    );
    expect(readPendingInvitation("A")).toBe(TOKEN);
    expect(state.activateCalls).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "verificar-mfa" }));
    const again = await activateButton();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(state.activateCalls).toBe(1); // sin POST automático

    fireEvent.click(again);
    expect(await screen.findByTestId("admin")).toBeInTheDocument();
    expect(postedBodies()).toEqual([{ token: TOKEN }, { token: TOKEN }]);
  });

  it("guarda anti-bucle no pegada: tras volver del MFA con recent=true, un step_up_required posterior SÍ inicia otro MFA", async () => {
    signIn();
    capturePendingInvitation(TOKEN);
    state.activate = () => STEP_UP();
    render(tree({ pathname: "/admin/activate", state: { fromMfa: true } }));
    const button = await activateButton();

    state.access = () => access(null, false);
    fireEvent.click(button);

    expect(await screen.findByTestId("mfa")).toHaveTextContent(
      "/admin/mfa?returnTo=/admin/activate",
    );
    expect(readPendingInvitation("A")).toBe(TOKEN);
  });

  it("doble clic: una sola petición mientras hay una en curso", async () => {
    let release: (v: unknown) => void = () => undefined;
    state.activate = () => new Promise((resolve) => (release = resolve)) as never;
    (fetch as Mock).mockImplementation(async (url: string) => {
      if (url === "/api/admin/access") return access(null, true);
      state.activateCalls++;
      return new Promise((resolve) => (release = resolve));
    });
    const button = await ready();

    // Varios clics dentro del MISMO lote de React: `disabled` aún no se aplicó al DOM.
    act(() => {
      button.click();
      button.click();
      button.click();
    });
    await waitFor(() => expect(state.activateCalls).toBe(1));
    await act(async () => {
      release(json(200, { role: "admin" }));
    });

    expect(await screen.findByTestId("admin")).toBeInTheDocument();
    expect(state.activateCalls).toBe(1);
  });

  it("si el token caducó en memoria entre medias, no hay POST y se pide reabrir el enlace", async () => {
    const button = await ready();
    clearPendingInvitation();

    fireEvent.click(button);

    expect(await unavailable()).toBeInTheDocument();
    expect(state.activateCalls).toBe(0);
  });
});

describe("el token no se filtra", () => {
  it("no aparece en consola, URL, navegación, DOM, storage ni en peticiones que no sean el body del POST", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    state.activate = (n) => (n === 1 ? json(500) : json(400));
    signIn();
    setHash(`#token=${TOKEN}`);
    render(tree());

    fireEvent.click(await activateButton());
    await screen.findByRole("alert");
    fireEvent.click(await activateButton());
    await screen.findByText(/no es válida, expiró/i);

    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
    }
    expect(window.location.href).not.toContain(TOKEN);
    expect(navLog.join("\n")).not.toContain(TOKEN);
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(setItem).not.toHaveBeenCalled();
    for (const [url, init] of (fetch as Mock).mock.calls) {
      expect(String(url)).not.toContain(TOKEN);
      const headers = JSON.stringify((init as { headers?: unknown })?.headers ?? {});
      expect(headers).not.toContain(TOKEN);
      if (url !== "/api/admin/activate") {
        expect(JSON.stringify(init ?? {})).not.toContain(TOKEN);
      }
    }
    expect(
      JSON.stringify(
        testQueryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.queryKey),
      ),
    ).not.toContain(TOKEN);
  });

  it("el código fuente nunca consulta admin_roles, usa storage ni lee el token de la query", () => {
    const source = readFileSync(
      join(process.cwd(), "src/pages/admin/AdminActivatePage.tsx"),
      "utf-8",
    );
    expect(source).not.toMatch(/\.from\(\s*["']admin_roles["']\s*\)/);
    expect(source).not.toMatch(/supabase\s*\.\s*from/);
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(source).not.toMatch(/useSearchParams|location\.search\.get/);
    expect(source).not.toMatch(/consumePendingInvitation/);
  });
});

describe("revisión final 9G-4", () => {
  it("StrictMode + enlace inválido con T1 en memoria: T1 se destruye y nada se guarda", async () => {
    signIn();
    capturePendingInvitation(TOKEN);
    setHash("#token=inv%C3%A1lido");
    render(<React.StrictMode>{tree()}</React.StrictMode>);

    expect(await unavailable()).toBeInTheDocument();
    expect(hasPendingInvitation()).toBe(false);
    expect(screen.queryByRole("button", { name: "Activar acceso" })).toBeNull();
  });

  it("navegar a /admin/activate SIN hash nuevo conserva el token en memoria (retorno de login/MFA)", async () => {
    signIn();
    capturePendingInvitation(TOKEN);
    window.history.replaceState(null, "", "/admin/activate");
    render(tree());

    fireEvent.click(await activateButton());
    await waitFor(() => expect(postedBodies()).toEqual([{ token: TOKEN }]));
  });

  it("StrictMode: capturar, asociar y activar produce UNA sola petición y UNA navegación", async () => {
    signIn();
    setHash(`#token=${TOKEN}`);
    render(<React.StrictMode>{tree()}</React.StrictMode>);

    fireEvent.click(await activateButton());
    await screen.findByTestId("admin");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(state.activateCalls).toBe(1);
    expect([...navKeys].filter((k) => k.startsWith("admin:"))).toHaveLength(1);
  });

  it("la sesión cambia de A a B entre el render y el clic: NO se envía el token de A con el Bearer de B", async () => {
    signIn("A");
    setHash(`#token=${TOKEN}`);
    render(tree());
    const button = await activateButton();

    signIn("B"); // sin re-render: el manejador del botón aún es el de A
    fireEvent.click(button);

    // Falla cerrado (sesión inválida o enlace no disponible, según el orden de render).
    await screen.findByRole("alert");
    expect(state.activateCalls).toBe(0);
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it.each([
    ["code en mayúsculas", { code: "STEP_UP_REQUIRED" }],
    ["code nulo", { code: null }],
    ["code numérico", { code: 123 }],
    ["code con espacio final", { code: "step_up_required " }],
    ["cuerpo sin JSON", undefined],
  ])(
    "403 hostil (%s): conserva el token, error genérico y NUNCA MFA",
    async (_n, body) => {
      signIn();
      setHash(`#token=${TOKEN}`);
      state.activate = () => ({
        ok: false,
        status: 403,
        json: async () => {
          if (body === undefined) throw new SyntaxError("no json");
          return body;
        },
      });
      render(tree());
      fireEvent.click(await activateButton());

      expect(await screen.findByRole("alert")).toHaveTextContent(/error interno/i);
      expect(screen.queryByTestId("mfa")).toBeNull();
      expect(readPendingInvitation("A")).toBe(TOKEN);
    },
  );

  it("500 con code step_up_required en el cuerpo NO inicia MFA (solo cuenta el 403 exacto)", async () => {
    signIn();
    setHash(`#token=${TOKEN}`);
    state.activate = () => json(500, { code: "step_up_required" });
    render(tree());
    fireEvent.click(await activateButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(/error interno/i);
    expect(screen.queryByTestId("mfa")).toBeNull();
    expect(readPendingInvitation("A")).toBe(TOKEN);
  });

  it("2xx con cuerpo ilegible: el backend ya consumió el token → se borra y se va a /account", async () => {
    signIn();
    setHash(`#token=${TOKEN}`);
    state.activate = () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("no json");
      },
    });
    render(tree());
    fireEvent.click(await activateButton());

    expect(await screen.findByTestId("account")).toBeInTheDocument();
    expect(hasPendingInvitation()).toBe(false);
  });

  it("no se inyecta ningún rol en la caché de acceso tras el éxito", async () => {
    signIn();
    setHash(`#token=${TOKEN}`);
    render(tree());
    fireEvent.click(await activateButton());
    await screen.findByTestId("admin");

    const cached = testQueryClient.getQueryData(["admin-access", "A"]) as
      { role: string | null } | undefined;
    // Solo puede contener lo que respondió el servidor (aquí: sin rol), nunca un rol inyectado.
    expect(cached?.role ?? null).toBeNull();
  });
});
