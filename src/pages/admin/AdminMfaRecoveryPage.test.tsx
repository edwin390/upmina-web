import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  capturePendingRecoveryCode,
  clearPendingRecoveryCode,
  readPendingRecoveryCode,
} from "@/lib/pending-recovery-code";
import AdminMfaRecoveryPage from "./AdminMfaRecoveryPage";

// «Perdí mi autenticador» (MFA fase 2). Solo presentación: el servidor decide. Datos SINTÉTICOS.

const TOKEN = "jwt-sintetico-de-prueba";
const CHALLENGE = "A".repeat(43);

const auth = vi.hoisted(() => ({
  session: null as null | { access_token: string },
  signOut: vi.fn(),
  user: { id: "user-1", email: "eds@example.test" } as null | {
    id: string;
    email: string | null;
  },
  signIn: vi.fn(),
  onSignIn: null as null | (() => void),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: auth.session } }),
      getUser: async () => ({ data: { user: auth.user }, error: null }),
      signInWithPassword: (creds: unknown) => auth.signIn(creds),
      // Cualquier uso de MFA durante la confirmación de contraseña sería un fallo del flujo.
      mfa: new Proxy(
        {},
        {
          get: () => () => {
            throw new Error("no se debe tocar MFA");
          },
        },
      ),
    },
  },
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ signOut: auth.signOut }) }));

const fetchMock = vi.fn();
const res = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const base = {
  hasApprover: true,
  mailConfigured: true,
  recentLogin: true,
  role: "moderator",
  aal: "aal1",
};
let state: Record<string, unknown>;
const posts = () =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([, init]) => JSON.parse(init.body));

function setup(
  initial: Record<string, unknown>,
  post: (op: string) => unknown = () => res(200, { status: "ok" }),
) {
  state = { ...base, ...initial };
  fetchMock.mockImplementation(
    async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") return post(JSON.parse(init.body as string).op);
      return res(200, { ...state }); // copia: cada respuesta es un objeto nuevo (como el JSON real)
    },
  );
  return render(
    <MemoryRouter>
      <AdminMfaRecoveryPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  auth.session = { access_token: TOKEN };
  auth.signOut.mockReset();
  auth.user = { id: "user-1", email: "eds@example.test" };
  auth.signIn.mockReset();
  auth.onSignIn = null;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/admin/mfa/recovery");
  clearPendingRecoveryCode();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminMfaRecoveryPage", () => {
  it("sin solicitud: explica el proceso y solicita sin enviar ningún identificador", async () => {
    setup({ status: "none" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Solicitar restablecimiento" }),
    );
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ op: "request" });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(screen.getByText(/Tu rol no cambia/)).toBeInTheDocument();
  });

  it("el único administrador ve la recuperación excepcional y no puede solicitar", async () => {
    setup({ status: "none", hasApprover: false, role: "admin" });
    expect(
      await screen.findByText(/ni un Developer que pueda aprobarlo/),
    ).toBeInTheDocument();
    expect(screen.getByText(/propietario del proyecto/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Solicitar restablecimiento" }),
    ).toBeDisabled();
  });

  it("sin correo configurado no se puede solicitar", async () => {
    setup({ status: "none", mailConfigured: false });
    expect(await screen.findByText(/no está disponible todavía/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Solicitar restablecimiento" }),
    ).toBeDisabled();
  });

  it("si el servidor rechaza por credenciales no recientes se pide la contraseña en la misma página", async () => {
    setup({ status: "none" }, () => res(403, { code: "recent_login_required" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Solicitar restablecimiento" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Confirma tu contraseña actual para continuar.",
    );
  });

  it("si el correo no pudo enviarse lo dice (no afirma un envío)", async () => {
    setup({ status: "none" }, () =>
      res(200, { status: "pending_email", mail: { status: "failed" } }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Solicitar restablecimiento" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no se pudo enviar el correo/,
    );
  });

  it("pending_email: el código del fragmento se precarga, se limpia de la URL y la verificación envía solo el token", async () => {
    window.history.replaceState(null, "", `/admin/mfa/recovery#c=${CHALLENGE}`);
    setup({ status: "pending_email", challengeSends: 1 });
    const input = (await screen.findByLabelText("Código del correo")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(CHALLENGE));
    expect(window.location.hash).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Verificar correo" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ op: "verify", token: CHALLENGE });
  });

  it("pending_email: reenviar y cancelar usan operaciones sin parámetros de cuenta", async () => {
    setup({ status: "pending_email" });
    fireEvent.click(await screen.findByRole("button", { name: "Reenviar correo" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar solicitud" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()).toEqual([{ op: "resend" }, { op: "cancel" }]);
  });

  it("un código incorrecto muestra el error del servidor sin revelar más", async () => {
    setup({ status: "pending_email" }, () => res(400, { code: "invalid_code" }));
    fireEvent.change(await screen.findByLabelText("Código del correo"), {
      target: { value: "zzz" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verificar correo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("El código no es válido.");
  });

  it("pending_approval: espera y deja claro que aún no se eliminó nada", async () => {
    setup({ status: "pending_approval" });
    expect(
      await screen.findByText(/Aún no se ha eliminado ningún autenticador/),
    ).toBeInTheDocument();
  });

  it.each([
    ["notice_pending", /confirmación de entrega/],
    ["notice_failed", /No se pudo entregar el aviso/],
    ["waiting", /espera de seguridad/],
  ])("aprobada con readiness %s: no ofrece ejecutar", async (readiness, text) => {
    setup({ status: "approved", readiness, readyAt: "2026-10-12T10:15:00Z" });
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Invalidar mi autenticador actual" }),
    ).toBeNull();
  });

  it("aprobada y lista: pide confirmación explícita antes de ejecutar y envía solo {op}", async () => {
    setup({ status: "approved", readiness: "ready" }, () =>
      res(200, { status: "factors_deleted" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Invalidar mi autenticador actual" }),
    );
    expect(posts()).toHaveLength(0); // aún no
    fireEvent.click(
      screen.getByRole("button", { name: "Sí, invalidar mi autenticador" }),
    );
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ op: "execute" });
  });

  it("un fallo parcial de la invalidación se comunica y se puede reintentar", async () => {
    setup({ status: "executing", readiness: "not_approved" }, () =>
      res(200, { status: "executing", error_class: "auth_delete_failed" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Invalidar mi autenticador actual" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Sí, invalidar mi autenticador" }),
    );
    expect(
      await screen.findByText(/No se pudo invalidar el autenticador todavía/),
    ).toBeInTheDocument();
  });

  it("factors_deleted: instrucciones claras, enlace a una pestaña NUEVA y sin botón de confirmación manual", async () => {
    setup({ status: "factors_deleted" });
    const link = await screen.findByRole("link", {
      name: "Configurar autenticador nuevo",
    });
    expect(link).toHaveAttribute("href", "/admin/mfa");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.queryByRole("button", { name: /Ya lo configuré/ })).toBeNull();
    expect(screen.getByText(/no tienes que pulsar nada más/)).toBeInTheDocument();
    expect(
      screen.getByText(/Aún no se detecta un autenticador nuevo verificado/),
    ).toBeInTheDocument();
    expect(posts()).toHaveLength(0); // ninguna escritura desde la interfaz
  });

  // ---- Confirmación de la contraseña dentro del flujo (sin cerrar sesión ni ir al login) ----
  describe("credenciales recientes", () => {
    it("con sesión reciente NO se pide la contraseña y se puede solicitar", async () => {
      setup({ status: "none", recentLogin: true });
      await screen.findByRole("button", { name: "Solicitar restablecimiento" });
      expect(screen.queryByLabelText("Contraseña actual")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Solicitar restablecimiento" }),
      ).toBeEnabled();
    });

    it.each([
      ["none", "Solicitar restablecimiento"],
      ["pending_email", "Verificar correo"],
      ["pending_email", "Reenviar correo"],
    ])(
      "sin sesión reciente (%s) aparece el formulario y «%s» queda bloqueado",
      async (status, label) => {
        setup({ status, recentLogin: false });
        expect(await screen.findByLabelText("Contraseña actual")).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: "Confirmar y continuar" }),
        ).toBeDisabled(); // vacío
        expect(screen.getByRole("button", { name: label })).toBeDisabled();
        expect(posts()).toHaveLength(0);
      },
    );

    it("aprobada y lista pero sin sesión reciente: no se puede invalidar hasta confirmar", async () => {
      setup({ status: "approved", readiness: "ready", recentLogin: false });
      expect(
        await screen.findByRole("button", { name: "Invalidar mi autenticador actual" }),
      ).toBeDisabled();
    });

    it("contraseña correcta: reautentica con el correo de la SESIÓN, recarga el estado, desbloquea y limpia la contraseña", async () => {
      setup({ status: "none", recentLogin: false });
      auth.signIn.mockImplementation(async () => {
        state = { ...state, recentLogin: true }; // el servidor ve ahora el JWT nuevo
        return { data: { user: { id: "user-1" } }, error: null };
      });
      const input = (await screen.findByLabelText(
        "Contraseña actual",
      )) as HTMLInputElement;
      expect(input.type).toBe("password");
      fireEvent.change(input, { target: { value: "contraseña-sintetica" } });
      fireEvent.click(screen.getByRole("button", { name: "Confirmar y continuar" }));
      expect(await screen.findByRole("status")).toHaveTextContent(
        "Contraseña confirmada",
      );
      expect(auth.signIn).toHaveBeenCalledTimes(1);
      expect(auth.signIn).toHaveBeenCalledWith({
        email: "eds@example.test",
        password: "contraseña-sintetica",
      });
      await waitFor(() =>
        expect(screen.queryByLabelText("Contraseña actual")).toBeNull(),
      );
      expect(
        screen.getByRole("button", { name: "Solicitar restablecimiento" }),
      ).toBeEnabled();
      expect(screen.queryByDisplayValue("contraseña-sintetica")).toBeNull();
      expect(auth.signOut).not.toHaveBeenCalled(); // no se cierra la sesión
    });

    it("la contraseña NUNCA se envía a nuestros endpoints ni queda en el DOM", async () => {
      setup({ status: "none", recentLogin: false });
      auth.signIn.mockImplementation(async () => {
        state = { ...state, recentLogin: true };
        return { data: { user: { id: "user-1" } }, error: null };
      });
      fireEvent.change(await screen.findByLabelText("Contraseña actual"), {
        target: { value: "secreto-sintetico-123" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Confirmar y continuar" }));
      await screen.findByRole("status");
      expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("secreto-sintetico-123");
      expect(document.body.innerHTML).not.toContain("secreto-sintetico-123");
    });

    it("contraseña incorrecta: error genérico, sigue bloqueado, el campo se vacía y no se llama a nuestra API", async () => {
      setup({ status: "none", recentLogin: false });
      auth.signIn.mockResolvedValue({
        data: { user: null },
        error: {
          status: 400,
          code: "invalid_credentials",
          message: "Invalid login credentials",
        },
      });
      const input = (await screen.findByLabelText(
        "Contraseña actual",
      )) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "mala" } });
      fireEvent.click(screen.getByRole("button", { name: "Confirmar y continuar" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "No se pudo confirmar. Revisa tu contraseña",
      );
      expect(document.body.textContent).not.toMatch(/Invalid login|invalid_credentials/);
      expect(input.value).toBe("");
      expect(
        screen.getByRole("button", { name: "Solicitar restablecimiento" }),
      ).toBeDisabled();
      expect(posts()).toHaveLength(0);
    });

    it("demasiados intentos (429) → mensaje específico", async () => {
      setup({ status: "none", recentLogin: false });
      auth.signIn.mockResolvedValue({
        data: { user: null },
        error: { status: 429, code: "over_request_rate_limit" },
      });
      fireEvent.change(await screen.findByLabelText("Contraseña actual"), {
        target: { value: "x" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Confirmar y continuar" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Demasiados intentos");
    });

    it("si el servidor sigue sin reconocer la confirmación se dice, sin bucles", async () => {
      setup({ status: "none", recentLogin: false });
      auth.signIn.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
      fireEvent.change(await screen.findByLabelText("Contraseña actual"), {
        target: { value: "x" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Confirmar y continuar" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "El servidor no reconoció la confirmación",
      );
      expect(auth.signIn).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("Contraseña actual")).toBeInTheDocument();
    });

    it("sesión sin correo / usuario distinto → no se intenta ningún inicio de sesión ni se acepta otra cuenta", async () => {
      setup({ status: "none", recentLogin: false });
      auth.user = { id: "user-1", email: null };
      fireEvent.change(await screen.findByLabelText("Contraseña actual"), {
        target: { value: "x" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Confirmar y continuar" }));
      expect(
        await screen.findByRole("link", { name: "Iniciar sesión" }),
      ).toBeInTheDocument();
      expect(auth.signIn).not.toHaveBeenCalled();
      cleanup();
      setup({ status: "none", recentLogin: false });
      await screen.findByLabelText("Contraseña actual");
      auth.user = { id: "user-1", email: "eds@example.test" };
      auth.signIn.mockResolvedValue({
        data: { user: { id: "otra-cuenta" } },
        error: null,
      });
      fireEvent.change(screen.getByLabelText("Contraseña actual"), {
        target: { value: "x" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Confirmar y continuar" }));
      await waitFor(() => expect(auth.signIn).toHaveBeenCalledTimes(1));
      expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo confirmar");
    });

    it("no se exige ni se toca el TOTP durante la confirmación", async () => {
      setup({ status: "none", recentLogin: false });
      auth.signIn.mockImplementation(async () => {
        state = { ...state, recentLogin: true };
        return { data: { user: { id: "user-1" } }, error: null };
      });
      fireEvent.change(await screen.findByLabelText("Contraseña actual"), {
        target: { value: "x" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Confirmar y continuar" }));
      expect(await screen.findByRole("status")).toHaveTextContent(
        "Contraseña confirmada",
      ); // el Proxy de mfa lanzaría si se usara
      expect(
        screen.queryByLabelText(/código del autenticador|código de verificación/i),
      ).toBeNull();
    });
  });

  it("completed y estados cerrados", async () => {
    const first = setup({ status: "completed" });
    expect(await screen.findByText(/Tu autenticador se restableció/)).toBeInTheDocument();
    first.unmount();
    setup({ status: "denied", deniedReason: "No reconozco la solicitud" });
    expect(await screen.findByText(/No reconozco la solicitud/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Solicitar restablecimiento" }),
    ).toBeEnabled();
  });

  it("sin rol (403): mensaje controlado y opción explícita de cambiar de cuenta", async () => {
    fetchMock.mockResolvedValue(res(403, { error: "No autorizado" }));
    render(
      <MemoryRouter>
        <AdminMfaRecoveryPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /solo para miembros del equipo/,
    );
    expect(screen.getByRole("button", { name: "Cambiar de cuenta" })).toBeInTheDocument();
  });
});

// ---- Refresco automático del estado (cada 15 s) ----
describe("AdminMfaRecoveryPage — refresco automático", () => {
  const POLL = 15000;
  let visibility: "visible" | "hidden" = "visible";
  const setVisibility = (v: "visible" | "hidden") => {
    visibility = v;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  const gets = () => fetchMock.mock.calls.filter(([, init]) => !init?.method).length;
  const tick = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  beforeEach(() => {
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });

  async function mount(initial: Record<string, unknown>) {
    const view = setup(initial);
    await tick(0);
    return view;
  }

  it.each(["none", "completed", "denied", "cancelled", "expired"])(
    "sin solicitud activa (%s): no hay botón «Actualizar estado» ni consultas automáticas",
    async (status) => {
      await mount({ status });
      expect(screen.queryByRole("button", { name: /Actualizar estado/ })).toBeNull();
      await tick(POLL * 4);
      expect(gets()).toBe(1); // solo la carga inicial
    },
  );

  it("con solicitud activa muestra el botón y hace UN solo intervalo de 15 s", async () => {
    await mount({ status: "pending_approval" });
    expect(screen.getByRole("button", { name: "Actualizar estado" })).toBeInTheDocument();
    expect(gets()).toBe(1);
    await tick(POLL - 1);
    expect(gets()).toBe(1);
    await tick(1);
    expect(gets()).toBe(2);
    await tick(POLL);
    expect(gets()).toBe(3);
    expect(vi.getTimerCount()).toBe(1); // sin temporizadores duplicados
  });

  it("el botón manual consulta al instante y NO reinicia el intervalo", async () => {
    await mount({ status: "pending_approval" });
    await tick(10000);
    fireEvent.click(screen.getByRole("button", { name: "Actualizar estado" }));
    await tick(0);
    expect(gets()).toBe(2); // inmediata
    await tick(5000); // t = 15 s desde el montaje: el intervalo original sigue su curso
    expect(gets()).toBe(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("actualizaciones de estado y re-renderizados no reinician ni duplican el intervalo", async () => {
    await mount({ status: "pending_approval" });
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Actualizar estado" }));
      await tick(0);
    }
    expect(vi.getTimerCount()).toBe(1);
    await tick(POLL);
    expect(gets()).toBe(5); // 1 inicial + 3 manuales + 1 automática
  });

  it("pestaña oculta: pausa; al volver consulta enseguida y reanuda", async () => {
    await mount({ status: "pending_approval" });
    setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    await tick(POLL * 3);
    expect(gets()).toBe(1);
    setVisibility("visible");
    await tick(0);
    expect(gets()).toBe(2); // consulta inmediata al volver
    expect(vi.getTimerCount()).toBe(1);
    await tick(POLL);
    expect(gets()).toBe(3);
  });

  it("un estado terminal detiene el refresco y retira el botón", async () => {
    await mount({ status: "pending_approval" });
    state = { ...state, status: "cancelled" };
    await tick(POLL);
    expect(screen.getByText(/Tu solicitud anterior se cerró/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Actualizar estado/ })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const before = gets();
    await tick(POLL * 4);
    expect(gets()).toBe(before);
  });

  it("al desmontar se limpian el intervalo y el listener de visibilidad", async () => {
    const view = await mount({ status: "approved", readiness: "waiting" });
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    const before = gets();
    await tick(POLL * 3);
    setVisibility("hidden");
    setVisibility("visible");
    await tick(POLL);
    expect(gets()).toBe(before);
  });

  it("el refresco solo hace GET del estado: ninguna escritura ni reenvío", async () => {
    await mount({ status: "pending_email" });
    await tick(POLL * 3);
    setVisibility("hidden");
    setVisibility("visible");
    await tick(POLL);
    expect(posts()).toHaveLength(0);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("/api/admin/mfa-recovery");
      expect(init?.method).toBeUndefined();
      expect(init?.body).toBeUndefined();
    }
  });

  it("una respuesta antigua NO sobrescribe a una más reciente", async () => {
    let releaseOld!: (v: unknown) => void;
    let gets_ = 0;
    state = { ...base, status: "pending_approval" };
    fetchMock.mockImplementation(
      async (_u: string, init?: { method?: string; body?: string }) => {
        if (init?.method === "POST") return res(200, { status: "cancelled" });
        gets_ += 1;
        if (gets_ === 2) return new Promise((r) => (releaseOld = r)); // consulta automática lenta (estado viejo)
        return res(200, gets_ >= 3 ? { ...base, status: "cancelled" } : state);
      },
    );
    render(
      <MemoryRouter>
        <AdminMfaRecoveryPage />
      </MemoryRouter>,
    );
    await tick(0);
    await tick(POLL); // la consulta automática queda pendiente
    expect(gets_).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar solicitud" })); // POST + recarga (más reciente)
    await tick(0);
    expect(screen.getByText(/Tu solicitud anterior se cerró/)).toBeInTheDocument();
    await act(async () => {
      releaseOld(res(200, { ...base, status: "pending_approval" })); // llega tarde, con el estado viejo
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/Tu solicitud anterior se cerró/)).toBeInTheDocument();
    expect(screen.queryByText(/Esperando la aprobación/)).toBeNull();
  });

  it("no solapa consultas: con una automática pendiente no se lanza otra", async () => {
    let release!: (v: unknown) => void;
    let n = 0;
    state = { ...base, status: "pending_approval" };
    fetchMock.mockImplementation(async () => {
      n += 1;
      return n === 2 ? new Promise((r) => (release = r)) : res(200, state);
    });
    render(
      <MemoryRouter>
        <AdminMfaRecoveryPage />
      </MemoryRouter>,
    );
    await tick(0);
    await tick(POLL);
    expect(n).toBe(2);
    await tick(POLL * 3); // la primera sigue pendiente
    expect(n).toBe(2);
    expect(screen.getByRole("button", { name: "Actualizar estado" })).toBeDisabled();
    await act(async () => {
      release(res(200, state));
      await vi.advanceTimersByTimeAsync(0);
    });
    await tick(POLL);
    expect(n).toBe(3);
  });

  it("un fallo transitorio del refresco automático no sustituye la pantalla por un error", async () => {
    await mount({ status: "pending_approval" });
    fetchMock.mockImplementation(async () => res(500, {}));
    await tick(POLL);
    expect(screen.queryByText(/No se pudo cargar el estado/)).toBeNull();
    expect(
      screen.getByText(/Esperando la aprobación de un administrador/),
    ).toBeInTheDocument();
    fetchMock.mockImplementation(async () =>
      res(200, { ...state, status: "approved", readiness: "waiting" }),
    );
    await tick(POLL);
    expect(screen.getByText(/Un administrador aprobó tu solicitud/)).toBeInTheDocument();
  });

  it("factors_deleted: al verificarse el TOTP nuevo el servidor completa y la página lo muestra sola, sin pulsar nada", async () => {
    await mount({ status: "factors_deleted" });
    expect(screen.queryByText(/Tu autenticador se restableció/)).toBeNull();
    state = { ...state, status: "completed" }; // el servidor reconcilió en la consulta de estado
    await tick(POLL);
    expect(screen.getByText(/Tu autenticador se restableció/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirmar/i })).toBeNull();
    expect(vi.getTimerCount()).toBe(0); // el refresco se detiene al completarse
    expect(posts()).toHaveLength(0);
  });

  it("la confirmación de contraseña sigue funcionando junto al refresco", async () => {
    await mount({ status: "pending_email", recentLogin: false });
    auth.signIn.mockImplementation(async () => {
      state = { ...state, recentLogin: true };
      return { data: { user: { id: "user-1" } }, error: null };
    });
    fireEvent.change(screen.getByLabelText("Contraseña actual"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar y continuar" }));
    await tick(0);
    expect(screen.getByRole("status")).toHaveTextContent("Contraseña confirmada");
    expect(screen.queryByLabelText("Contraseña actual")).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
  });
});

// ---- Continuidad tras iniciar sesión (MFA fase 2) ----
describe("AdminMfaRecoveryPage — continuidad con el inicio de sesión", () => {
  const LOGIN = "/login?returnTo=/admin/mfa/recovery";
  const renderApp = (initial = "/admin/mfa/recovery") =>
    render(
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/admin/mfa/recovery" element={<AdminMfaRecoveryPage />} />
          <Route path="/login" element={<p>LOGIN PAGE</p>} />
        </Routes>
      </MemoryRouter>,
    );

  it("sin sesión: ofrece iniciar sesión y volver aquí; no consulta la API ni muestra errores", async () => {
    auth.session = null;
    renderApp();
    const link = await screen.findByRole("link", { name: "Iniciar sesión" });
    expect(link).toHaveAttribute("href", LOGIN);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enlace del correo abierto SIN sesión: el código no viaja en la URL, se conserva en memoria y reaparece al volver tras el login", async () => {
    auth.session = null;
    window.history.replaceState(null, "", `/admin/mfa/recovery#c=${CHALLENGE}`);
    const first = renderApp();
    const link = await screen.findByRole("link", { name: "Iniciar sesión" });
    expect(link.getAttribute("href")).toBe(LOGIN);
    expect(link.getAttribute("href")).not.toContain(CHALLENGE);
    expect(window.location.hash).toBe(""); // el fragmento se retira de la URL
    expect(readPendingRecoveryCode()).toBe(CHALLENGE);
    expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain(
      CHALLENGE,
    );
    first.unmount();

    // …la persona inicia sesión y vuelve a la página (navegación de la SPA)
    auth.session = { access_token: TOKEN };
    setup({ status: "pending_email" });
    const input = (await screen.findByLabelText("Código del correo")) as HTMLInputElement;
    expect(input.value).toBe(CHALLENGE);
    expect(posts()).toHaveLength(0); // no se verifica sola: la persona pulsa
    fireEvent.click(screen.getByRole("button", { name: "Verificar correo" }));
    await waitFor(() => expect(posts()).toEqual([{ op: "verify", token: CHALLENGE }]));
  });

  it("al verificar con éxito el código pendiente se descarta", async () => {
    capturePendingRecoveryCode(CHALLENGE);
    setup({ status: "pending_email" }, () => res(200, { status: "pending_approval" }));
    await screen.findByLabelText("Código del correo");
    fireEvent.click(screen.getByRole("button", { name: "Verificar correo" }));
    await waitFor(() => expect(readPendingRecoveryCode()).toBeNull());
  });

  it.each(["cancelled", "expired", "denied", "pending_approval"])(
    "si la solicitud está «%s» al volver, se muestra ese estado y el código pendiente se descarta",
    async (status) => {
      capturePendingRecoveryCode(CHALLENGE);
      setup({ status });
      await waitFor(() => expect(readPendingRecoveryCode()).toBeNull());
      expect(screen.queryByLabelText("Código del correo")).toBeNull();
    },
  );

  it("cuenta SIN solicitud («none») con un código pendiente: se conserva, se avisa y se ofrece cambiar de cuenta", async () => {
    capturePendingRecoveryCode(CHALLENGE);
    auth.signOut.mockResolvedValue(undefined);
    state = { ...base, status: "none" };
    fetchMock.mockImplementation(async () => res(200, { ...state }));
    renderApp();
    const notice = await screen.findByText(/esta cuenta no tiene una solicitud en curso/);
    expect(notice).toBeInTheDocument();
    expect(readPendingRecoveryCode()).toBe(CHALLENGE); // NO se descarta: puede ser el enlace de otra cuenta
    fireEvent.click(screen.getByRole("button", { name: "Cambiar de cuenta" }));
    expect(await screen.findByText("LOGIN PAGE")).toBeInTheDocument();
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(readPendingRecoveryCode()).toBe(CHALLENGE); // llega intacto a la cuenta correcta
  });

  it("cuenta sin solicitud y SIN código pendiente: no aparece el aviso de cuenta equivocada", async () => {
    setup({ status: "none" });
    await screen.findByRole("button", { name: "Solicitar restablecimiento" });
    expect(screen.queryByText(/esta cuenta no tiene una solicitud en curso/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Cambiar de cuenta" })).toBeNull();
  });

  it("sesión caducada al consultar (401) → tarjeta de inicio de sesión, sin perder el código", async () => {
    capturePendingRecoveryCode(CHALLENGE);
    fetchMock.mockResolvedValue(res(401, { error: "No autenticado" }));
    renderApp();
    expect(await screen.findByRole("link", { name: "Iniciar sesión" })).toHaveAttribute(
      "href",
      LOGIN,
    );
    expect(readPendingRecoveryCode()).toBe(CHALLENGE);
  });

  it("sesión caducada A MITAD del flujo (la acción devuelve 401) → inicia sesión y continúa", async () => {
    capturePendingRecoveryCode(CHALLENGE);
    setup({ status: "pending_email" }, () => res(401, { error: "No autenticado" }));
    await screen.findByLabelText("Código del correo");
    fireEvent.click(screen.getByRole("button", { name: "Verificar correo" }));
    expect(await screen.findByRole("link", { name: "Iniciar sesión" })).toHaveAttribute(
      "href",
      LOGIN,
    );
    expect(readPendingRecoveryCode()).toBe(CHALLENGE); // se conserva para continuar
  });

  it("la sesión desaparece al confirmar la contraseña → inicia sesión (sin intentar nada)", async () => {
    setup({ status: "none", recentLogin: false });
    auth.user = { id: "user-1", email: null };
    fireEvent.change(await screen.findByLabelText("Contraseña actual"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar y continuar" }));
    expect(await screen.findByRole("link", { name: "Iniciar sesión" })).toHaveAttribute(
      "href",
      LOGIN,
    );
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it("cuenta equivocada: «Cambiar de cuenta» cierra la sesión y lleva al login conservando el código para la cuenta correcta", async () => {
    capturePendingRecoveryCode(CHALLENGE);
    setup({ status: "pending_email" }, () => res(404, { code: "no_request" }));
    auth.signOut.mockResolvedValue(undefined);
    // render con rutas para observar la navegación
    cleanup();
    state = { ...base, status: "pending_email" };
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Cambiar de cuenta" }));
    expect(await screen.findByText("LOGIN PAGE")).toBeInTheDocument();
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(readPendingRecoveryCode()).toBe(CHALLENGE);
  });

  it("el código de otra cuenta se rechaza en el servidor: el mensaje invita a cambiar de cuenta", async () => {
    capturePendingRecoveryCode(CHALLENGE);
    setup({ status: "pending_email" }, () => res(400, { code: "invalid_code" }));
    await screen.findByLabelText("Código del correo");
    fireEvent.click(screen.getByRole("button", { name: "Verificar correo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/cambia de cuenta/);
  });

  it("pegar el ENLACE completo del correo (abierto en otro dispositivo) extrae el código", async () => {
    setup({ status: "pending_email" });
    const input = (await screen.findByLabelText("Código del correo")) as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        value: `https://upmina-testing-backend.vercel.app/admin/mfa/recovery#c=${CHALLENGE}`,
      },
    });
    expect(input.value).toBe(CHALLENGE);
  });

  it("continuidad no omite controles: sin credenciales recientes sigue bloqueado hasta confirmar la contraseña", async () => {
    capturePendingRecoveryCode(CHALLENGE);
    setup({ status: "pending_email", recentLogin: false });
    await screen.findByLabelText("Contraseña actual");
    expect(screen.getByRole("button", { name: "Verificar correo" })).toBeDisabled();
    expect(posts()).toHaveLength(0);
  });
});

// ---- Fragmento #c= con la página YA montada, y código perdido tras recargar ----
describe("AdminMfaRecoveryPage — fragmento con la página abierta y ayuda por código perdido", () => {
  const OTHER = "B".repeat(43);
  const setHash = (value: string) => {
    // Cambio SOLO del fragmento en el mismo documento: el navegador dispara `hashchange`.
    window.location.hash = value;
  };
  const gets = () =>
    fetchMock.mock.calls.filter(([, init]) => !init?.method || init.method === "GET");

  it("si cambia solo el fragmento con la página montada: captura el código, lo retira de la URL y lo guarda solo en memoria", async () => {
    setup({ status: "pending_email" });
    const input = (await screen.findByLabelText("Código del correo")) as HTMLInputElement;
    expect(input.value).toBe("");

    await act(async () => {
      setHash(`#c=${CHALLENGE}`);
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(input.value).toBe(CHALLENGE));
    expect(window.location.hash).toBe(""); // retirado de la URL de inmediato
    expect(readPendingRecoveryCode()).toBe(CHALLENGE);
    expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain(
      CHALLENGE,
    );
    expect(document.cookie).not.toContain(CHALLENGE);
  });

  it("revalida el estado UNA vez por cambio de fragmento (sin duplicar consultas) y no hace ninguna operación", async () => {
    setup({ status: "pending_email" });
    await screen.findByLabelText("Código del correo");
    const before = gets().length;
    await act(async () => {
      setHash(`#c=${CHALLENGE}`);
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(gets()).toHaveLength(before + 1));
    // el hash ya se retiró: un segundo evento sin fragmento no procesa nada
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(gets()).toHaveLength(before + 1);
    expect(posts()).toHaveLength(0); // capturar el código nunca verifica nada por sí solo
  });

  it("un segundo enlace posterior sustituye al primero; un fragmento inválido se ignora", async () => {
    setup({ status: "pending_email" });
    const input = (await screen.findByLabelText("Código del correo")) as HTMLInputElement;
    await act(async () => {
      setHash(`#c=${CHALLENGE}`);
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(input.value).toBe(CHALLENGE));
    await act(async () => {
      setHash(`#c=${OTHER}`);
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(input.value).toBe(OTHER));
    expect(readPendingRecoveryCode()).toBe(OTHER);

    await act(async () => {
      setHash("#c=corto");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(input.value).toBe(OTHER); // inválido: no cambia nada
    expect(readPendingRecoveryCode()).toBe(OTHER);
  });

  it("con la página en la tarjeta de inicio de sesión también se captura el código (sin sesión)", async () => {
    auth.session = null;
    render(
      <MemoryRouter>
        <AdminMfaRecoveryPage />
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: "Iniciar sesión" });
    await act(async () => {
      setHash(`#c=${CHALLENGE}`);
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(readPendingRecoveryCode()).toBe(CHALLENGE));
    expect(window.location.hash).toBe("");
  });

  it("el escuchador se retira al desmontar: un cambio de fragmento posterior no hace nada", async () => {
    const view = setup({ status: "pending_email" });
    await screen.findByLabelText("Código del correo");
    view.unmount();
    const before = fetchMock.mock.calls.length;
    await act(async () => {
      setHash(`#c=${CHALLENGE}`);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchMock.mock.calls.length).toBe(before);
    expect(readPendingRecoveryCode()).toBeNull();
  });

  it("ayuda por código perdido en la tarjeta de inicio de sesión: reabrir el enlace o pegar el enlace completo", async () => {
    auth.session = null;
    render(
      <MemoryRouter>
        <AdminMfaRecoveryPage />
      </MemoryRouter>,
    );
    const help = await screen.findByTestId("recovery-code-help");
    expect(help).toHaveTextContent(/solo se conserva en esta pestaña/);
    expect(help).toHaveTextContent(/vuelve a abrir el enlace del correo/);
    expect(help).toHaveTextContent(/pega aquí el enlace completo/);
  });

  it("ayuda por código perdido en el paso de verificación, junto al aviso de cuenta equivocada", async () => {
    setup({ status: "pending_email" });
    await screen.findByLabelText("Código del correo");
    const help = screen.getByTestId("recovery-code-help");
    expect(help).toHaveTextContent(/Si recargas la página/);
    expect(help).toHaveTextContent(/vuelve a abrir el enlace del correo/);
    expect(help).toHaveTextContent(/pega aquí el enlace completo/);
    expect(help).toHaveTextContent(/Cambia de cuenta/);
    // el texto de ayuda no incorpora ningún código real
    expect(help.textContent).not.toContain(CHALLENGE);
  });
});

// ---- Limpieza de la URL: también para códigos con formato inválido, sin tocar fragmentos ajenos ----
describe("AdminMfaRecoveryPage — fragmento #c= inválido o ajeno", () => {
  const SHORT = "A".repeat(39);
  const LONG = "A".repeat(44);
  const VALID = "C".repeat(43);
  const NOTICE = /no contiene un código de verificación válido/;
  const setHash = async (value: string) => {
    await act(async () => {
      window.location.hash = value;
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  const gets = () =>
    fetchMock.mock.calls.filter(([, init]) => !init?.method || init.method === "GET");
  const nothingPersisted = (secret: string) => {
    expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain(secret);
    expect(document.cookie).not.toContain(secret);
    expect(window.location.href).not.toContain(secret);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(secret);
    expect(readPendingRecoveryCode()).not.toBe(secret);
  };

  it.each([
    ["39 caracteres", SHORT],
    ["44 caracteres", LONG],
    ["vacío «#c=»", ""],
  ])(
    "AL CARGAR con un código inválido (%s): se retira de la URL, se avisa y no se procesa",
    async (_n, bad) => {
      window.history.replaceState(null, "", `/admin/mfa/recovery#c=${bad}`);
      setup({ status: "pending_email" });
      expect(await screen.findByTestId("invalid-link-notice")).toHaveTextContent(NOTICE);
      expect(window.location.hash).toBe(""); // retirado ANTES de validar
      expect(readPendingRecoveryCode()).toBeNull(); // un código inválido no se guarda
      expect((screen.getByLabelText("Código del correo") as HTMLInputElement).value).toBe(
        "",
      );
      expect(posts()).toHaveLength(0); // ni una operación contra el backend
      if (bad) nothingPersisted(bad);
    },
  );

  it("AL CARGAR con un código válido: se consume, no hay aviso de enlace inválido y se conserva solo en memoria", async () => {
    window.history.replaceState(null, "", `/admin/mfa/recovery#c=${VALID}`);
    setup({ status: "pending_email" });
    const input = (await screen.findByLabelText("Código del correo")) as HTMLInputElement;
    expect(input.value).toBe(VALID);
    expect(window.location.hash).toBe("");
    expect(readPendingRecoveryCode()).toBe(VALID);
    expect(screen.queryByTestId("invalid-link-notice")).toBeNull();
    expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain(VALID);
    expect(document.cookie).not.toContain(VALID);
    expect(posts()).toHaveLength(0);
  });

  it("CON LA PÁGINA MONTADA y un código inválido: se retira, se avisa y NO se consulta el backend", async () => {
    setup({ status: "pending_email" });
    await screen.findByLabelText("Código del correo");
    const before = fetchMock.mock.calls.length;
    for (const bad of [SHORT, LONG, ""]) {
      await setHash(`#c=${bad}`);
      expect(window.location.hash).toBe("");
      expect(await screen.findByTestId("invalid-link-notice")).toHaveTextContent(NOTICE);
      if (bad) nothingPersisted(bad);
    }
    expect(fetchMock.mock.calls.length).toBe(before); // ni revalidación ni operaciones
    expect(readPendingRecoveryCode()).toBeNull();
    expect((screen.getByLabelText("Código del correo") as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("un enlace inválido NO pisa un código válido ya conservado; uno válido posterior limpia el aviso", async () => {
    setup({ status: "pending_email" });
    const input = (await screen.findByLabelText("Código del correo")) as HTMLInputElement;
    await setHash(`#c=${VALID}`);
    await waitFor(() => expect(input.value).toBe(VALID));
    await setHash(`#c=${SHORT}`);
    expect(await screen.findByTestId("invalid-link-notice")).toBeInTheDocument();
    expect(input.value).toBe(VALID);
    expect(readPendingRecoveryCode()).toBe(VALID);
    await setHash(`#c=${"D".repeat(43)}`);
    await waitFor(() => expect(input.value).toBe("D".repeat(43)));
    expect(screen.queryByTestId("invalid-link-notice")).toBeNull();
  });

  it("fragmentos AJENOS a la recuperación no se tocan ni disparan nada (al cargar y con la página montada)", async () => {
    window.history.replaceState(null, "", "/admin/mfa/recovery#seccion");
    setup({ status: "pending_email" });
    await screen.findByLabelText("Código del correo");
    expect(window.location.hash).toBe("#seccion");
    const before = fetchMock.mock.calls.length;
    await setHash("#x=1&y=2");
    expect(window.location.hash).toBe("#x=1&y=2");
    await setHash(`#C=${VALID}`); // otra clave: no es de la recuperación
    expect(window.location.hash).toBe(`#C=${VALID}`);
    expect(screen.queryByTestId("invalid-link-notice")).toBeNull();
    expect(readPendingRecoveryCode()).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it("solo se retira el parámetro c: un fragmento con otros parámetros conserva el resto", async () => {
    setup({ status: "pending_email" });
    const input = (await screen.findByLabelText("Código del correo")) as HTMLInputElement;
    await setHash(`#a=1&c=${VALID}`);
    await waitFor(() => expect(input.value).toBe(VALID));
    expect(window.location.hash).toBe("#a=1");
    await setHash(`#c=${SHORT}&b=2`);
    expect(await screen.findByTestId("invalid-link-notice")).toBeInTheDocument();
    expect(window.location.hash).toBe("#b=2");
    expect(input.value).toBe(VALID);
  });

  it("varios cambios seguidos de fragmento: cada uno se consume una sola vez (una revalidación por código válido)", async () => {
    setup({ status: "pending_email" });
    await screen.findByLabelText("Código del correo");
    const before = gets().length;
    await setHash(`#c=${VALID}`);
    await setHash(`#c=${SHORT}`);
    await setHash(`#c=${"E".repeat(43)}`);
    await waitFor(() => expect(gets().length).toBe(before + 2)); // solo los dos válidos revalidan
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent("hashchange")); // sin fragmento: nada que procesar
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(gets().length).toBe(before + 2);
    expect(posts()).toHaveLength(0);
  });

  it("el aviso de enlace inválido aparece también en la tarjeta de inicio de sesión (sin sesión)", async () => {
    auth.session = null;
    window.history.replaceState(null, "", `/admin/mfa/recovery#c=${SHORT}`);
    render(
      <MemoryRouter>
        <AdminMfaRecoveryPage />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("invalid-link-notice")).toHaveTextContent(NOTICE);
    expect(screen.getByRole("link", { name: "Iniciar sesión" })).toHaveAttribute(
      "href",
      "/login?returnTo=/admin/mfa/recovery",
    );
    expect(window.location.hash).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    nothingPersisted(SHORT);
  });

  it("cambio de cuenta con un código VÁLIDO recibido tras montar: se conserva y llega intacto al login", async () => {
    auth.signOut.mockResolvedValue(undefined);
    state = { ...base, status: "pending_email" };
    fetchMock.mockImplementation(async () => res(200, { ...state }));
    render(
      <MemoryRouter initialEntries={["/admin/mfa/recovery"]}>
        <Routes>
          <Route path="/admin/mfa/recovery" element={<AdminMfaRecoveryPage />} />
          <Route path="/login" element={<p>LOGIN PAGE</p>} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByLabelText("Código del correo");
    await setHash(`#c=${VALID}`);
    await waitFor(() => expect(readPendingRecoveryCode()).toBe(VALID));
    fireEvent.click(screen.getByRole("button", { name: "Cambiar de cuenta" }));
    expect(await screen.findByText("LOGIN PAGE")).toBeInTheDocument();
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(readPendingRecoveryCode()).toBe(VALID);
  });

  it("el código inválido no viaja a ninguna parte aunque se pulse «Verificar correo»", async () => {
    window.history.replaceState(null, "", `/admin/mfa/recovery#c=${SHORT}`);
    setup({ status: "pending_email" });
    await screen.findByTestId("invalid-link-notice");
    const verify = screen.getByRole("button", { name: "Verificar correo" });
    expect(verify).toBeDisabled(); // no hay código que enviar
    fireEvent.click(verify);
    expect(posts()).toHaveLength(0);
    nothingPersisted(SHORT);
  });
});
