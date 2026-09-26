import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import SocialConnectionsSection from "./SocialConnectionsSection";
import { PrivilegedFailureContext } from "@/hooks/privileged-failure";
import type { PrivilegedFailure } from "@/lib/privileged-response";

// Ciclo de vida y desconexión en /admin (Fase 9H-3). El backend decide todo lo privilegiado; aquí se
// fija cómo la UI presenta cada estado y, sobre todo, que la desconexión (destructiva) SOLO ocurre
// tras una confirmación explícita, nunca se repite sola tras un MFA, y un fallo jamás se presenta
// como "desconectado".

const TOKEN = "jwt-sintetico-de-prueba";
const SECRET_IG = "IGAA-token-secreto-que-nunca-debe-verse";
const SECRET_TT = "act.token-secreto-que-nunca-debe-verse";

const auth = vi.hoisted(() => ({ session: null as null | { access_token: string } }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: auth.session } }) },
  },
}));

type Status = "connected" | "expiring_soon" | "reauth_required" | "not_connected";
type Info = { status: Status; expiresAt?: string } & Record<string, unknown>;
const fetchMock = vi.fn();

const httpResponse = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  clone() {
    return httpResponse(status, body);
  },
});

let current: { instagram: Info; tiktok: Info };
const state = (instagram: Info, tiktok: Info) => {
  current = { instagram, tiktok };
};
let disconnectImpl: (body: string) => unknown;

function install() {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/admin/social-status") {
      return httpResponse(200, { connections: current });
    }
    if (url === "/api/admin/social-disconnect") {
      const result = disconnectImpl(String(init?.body));
      if (result instanceof Error) throw result;
      return result;
    }
    if (url === "/api/admin/social-connect") return httpResponse(200, {});
    throw new Error(`fetch inesperado a ${url}`);
  });
}

const disconnectCalls = () =>
  fetchMock.mock.calls.filter((c) => c[0] === "/api/admin/social-disconnect");
const statusCalls = () =>
  fetchMock.mock.calls.filter((c) => c[0] === "/api/admin/social-status");

const failures: PrivilegedFailure[] = [];
function renderSection() {
  return render(
    <PrivilegedFailureContext.Provider value={(f) => failures.push(f)}>
      <SocialConnectionsSection navigate={vi.fn()} />
    </PrivilegedFailureContext.Provider>,
  );
}

async function ready() {
  install();
  const view = renderSection();
  await screen.findByRole("heading", { name: "Instagram" });
  return view;
}

const card = (name: string) =>
  screen.getByRole("heading", { name }).closest("li") as HTMLElement;
const ask = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name: `Desconectar ${name}` }));
const confirmBtn = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`Confirmar desconexión de ${name}`) });

beforeEach(() => {
  auth.session = { access_token: TOKEN };
  fetchMock.mockReset();
  failures.length = 0;
  vi.stubGlobal("fetch", fetchMock);
  state({ status: "connected" }, { status: "not_connected" });
  disconnectImpl = () =>
    httpResponse(200, {
      provider: "instagram",
      status: "not_connected",
      was_connected: true,
    });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("presentación del ciclo de vida", () => {
  it("connected → 'Conectado', fecha de vigencia, Desconectar y ningún botón de conectar", async () => {
    state(
      { status: "connected", expiresAt: "2026-11-20T10:00:00.000Z" },
      { status: "not_connected" },
    );
    await ready();

    const ig = card("Instagram");
    expect(within(ig).getByText("Conectado")).toBeInTheDocument();
    expect(within(ig).getByText("20 nov 2026")).toBeInTheDocument();
    expect(
      within(ig).getByRole("button", { name: "Desconectar Instagram" }),
    ).toBeInTheDocument();
    expect(within(ig).queryByRole("button", { name: /Conectar|Reconectar/ })).toBeNull();
  });

  it("not_connected → 'Conectar' y NINGÚN Desconectar", async () => {
    state({ status: "not_connected" }, { status: "not_connected" });
    await ready();

    for (const name of ["Instagram", "TikTok"]) {
      expect(
        within(card(name)).getByRole("button", { name: `Conectar ${name}` }),
      ).toBeInTheDocument();
      expect(
        within(card(name)).queryByRole("button", { name: /Desconectar/ }),
      ).toBeNull();
    }
  });

  it("expiring_soon → aviso, fecha de caducidad, Reconectar y Desconectar", async () => {
    state(
      { status: "expiring_soon", expiresAt: "2026-10-03T10:00:00.000Z" },
      { status: "connected" },
    );
    await ready();

    const ig = card("Instagram");
    expect(within(ig).getByText("Caduca pronto")).toBeInTheDocument();
    expect(within(ig).getByText(/reconecta antes de que caduque/i)).toBeInTheDocument();
    expect(within(ig).getByText("3 oct 2026")).toBeInTheDocument();
    expect(
      within(ig).getByRole("button", { name: "Reconectar Instagram" }),
    ).toBeInTheDocument();
    expect(
      within(ig).getByRole("button", { name: "Desconectar Instagram" }),
    ).toBeInTheDocument();
  });

  it("reauth_required → explica que hay que reconectar, sin fecha, con Reconectar", async () => {
    state(
      { status: "reauth_required", expiresAt: "2026-09-01T10:00:00.000Z" },
      { status: "not_connected" },
    );
    await ready();

    const ig = card("Instagram");
    expect(within(ig).getByText("Requiere autorización")).toBeInTheDocument();
    expect(within(ig).getByText(/ya no es válida/i)).toBeInTheDocument();
    expect(within(ig).queryByText("1 sep 2026")).toBeNull();
    expect(
      within(ig).getByRole("button", { name: "Reconectar Instagram" }),
    ).toBeInTheDocument();
  });

  it("nunca muestra códigos del proveedor ni tokens aunque la respuesta trajera campos extra", async () => {
    state(
      {
        status: "connected",
        access_token: SECRET_IG,
        providerCode: "190",
        expiresAt: "2026-11-20T10:00:00.000Z",
      },
      { status: "connected", refresh_token: SECRET_TT },
    );
    const { container } = await ready();

    expect(container.textContent).not.toContain(SECRET_IG);
    expect(container.textContent).not.toContain(SECRET_TT);
    expect(container.textContent).not.toContain("190");
  });

  it("un estado desconocido o una fecha ilegible no inventan nada: estado desconocido = error de carga", async () => {
    state({ status: "healthy" as Status }, { status: "connected" });
    install();
    renderSection();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudo cargar el estado de las conexiones.",
    );
    expect(screen.queryByRole("button", { name: /Desconectar/ })).toBeNull();
  });

  it("una fecha ilegible se ignora (sin 'Invalid Date')", async () => {
    state({ status: "connected", expiresAt: "no-es-fecha" }, { status: "not_connected" });
    const { container } = await ready();
    expect(container.textContent).not.toMatch(/Invalid|NaN/);
    expect(within(card("Instagram")).queryByText(/Vigente hasta/)).toBeNull();
  });
});

describe("desconexión: confirmación explícita", () => {
  it("el primer clic SOLO abre la confirmación: ninguna petición de desconexión", async () => {
    await ready();

    ask("Instagram");

    expect(
      screen.getByRole("group", { name: "Confirmar desconexión de Instagram" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/dejará de mostrar contenido de esta cuenta/),
    ).toBeInTheDocument();
    expect(disconnectCalls()).toHaveLength(0);
  });

  it("Cancelar cierra la confirmación sin ninguna petición y devuelve el foco al botón", async () => {
    await ready();
    ask("Instagram");

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(screen.queryByRole("group", { name: /Confirmar desconexión/ })).toBeNull();
    expect(disconnectCalls()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Desconectar Instagram" })).toHaveFocus();
  });

  it("al abrir la confirmación el foco va a Cancelar (la opción segura)", async () => {
    await ready();
    ask("Instagram");
    expect(screen.getByRole("button", { name: "Cancelar" })).toHaveFocus();
  });

  it("Confirmar envía POST exacto { provider } con el Bearer, y NADA más", async () => {
    await ready();
    ask("Instagram");

    await act(async () => {
      fireEvent.click(confirmBtn("Instagram"));
    });

    expect(disconnectCalls()).toHaveLength(1);
    const [, init] = disconnectCalls()[0];
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({ provider: "instagram" });
  });

  it("doble clic en Confirmar: una sola petición", async () => {
    let resolve!: (r: unknown) => void;
    disconnectImpl = () => new Promise((r) => (resolve = r));
    await ready();
    ask("Instagram");
    const button = confirmBtn("Instagram");

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(disconnectCalls()).toHaveLength(1));
    expect(
      screen.getByRole("button", { name: /Desconectando Instagram/ }),
    ).toBeDisabled();

    resolve(httpResponse(200, { status: "not_connected" }));
    await waitFor(() => expect(statusCalls()).toHaveLength(2));
    expect(disconnectCalls()).toHaveLength(1);
  });

  it("solo hay una confirmación abierta a la vez y no se puede confirmar otra red sin abrirla", async () => {
    state({ status: "connected" }, { status: "connected" });
    await ready();

    ask("Instagram");
    ask("TikTok");

    expect(screen.getAllByRole("group", { name: /Confirmar desconexión/ })).toHaveLength(
      1,
    );
    expect(
      screen.getByRole("group", { name: "Confirmar desconexión de TikTok" }),
    ).toBeInTheDocument();
    expect(disconnectCalls()).toHaveLength(0);
  });

  it("desconectar TikTok envía provider tiktok", async () => {
    state({ status: "not_connected" }, { status: "connected" });
    await ready();
    ask("TikTok");
    await act(async () => {
      fireEvent.click(confirmBtn("TikTok"));
    });
    expect(JSON.parse(disconnectCalls()[0][1].body)).toEqual({ provider: "tiktok" });
  });
});

describe("desconexión: resultado", () => {
  it("éxito → aviso, y el estado se RELEE del servidor (sin actualización optimista)", async () => {
    await ready();
    ask("Instagram");
    // Tras la desconexión el servidor informa de la nueva realidad.
    disconnectImpl = () => {
      state({ status: "not_connected" }, { status: "not_connected" });
      return httpResponse(200, {
        provider: "instagram",
        status: "not_connected",
        was_connected: true,
      });
    };

    await act(async () => {
      fireEvent.click(confirmBtn("Instagram"));
    });

    await waitFor(() => expect(statusCalls()).toHaveLength(2));
    expect(await screen.findByText("Instagram desconectado.")).toBeInTheDocument();
    expect(within(card("Instagram")).getByText("No conectado")).toBeInTheDocument();
    expect(
      within(card("Instagram")).getByRole("button", { name: "Conectar Instagram" }),
    ).toBeInTheDocument();
  });

  it("éxito, pero la relectura falla → error de carga, NUNCA 'desconectado' inventado", async () => {
    await ready();
    ask("Instagram");
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/admin/social-disconnect") return httpResponse(200, {});
      throw new Error("red caída");
    });

    await act(async () => {
      fireEvent.click(confirmBtn("Instagram"));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudo cargar el estado",
    );
    expect(screen.queryByText("No conectado")).toBeNull();
  });

  it.each([
    ["500", () => httpResponse(500, { error: "Error interno" })],
    ["red caída", () => new Error("ECONNRESET")],
    ["respuesta 400", () => httpResponse(400, { error: "Solicitud inválida" })],
  ])(
    "fallo (%s) → mensaje, el estado NO cambia y la confirmación se cierra",
    async (_n, result) => {
      await ready();
      ask("Instagram");
      disconnectImpl = () => result();

      await act(async () => {
        fireEvent.click(confirmBtn("Instagram"));
      });

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "No pudimos desconectar Instagram. Inténtalo de nuevo.",
      );
      expect(within(card("Instagram")).getByText("Conectado")).toBeInTheDocument();
      expect(screen.queryByText("Instagram desconectado.")).toBeNull();
      expect(screen.queryByRole("group", { name: /Confirmar desconexión/ })).toBeNull();
      // Sin reintento automático: reintentar exige abrir y confirmar otra vez.
      expect(disconnectCalls()).toHaveLength(1);
      expect(statusCalls()).toHaveLength(1);
    },
  );

  it("403 'no disponible en este entorno' → mensaje específico y sin cambiar el estado", async () => {
    await ready();
    ask("Instagram");
    disconnectImpl = () => httpResponse(403, { error: "No disponible en este entorno" });

    await act(async () => {
      fireEvent.click(confirmBtn("Instagram"));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "solo está disponible en el entorno de producción",
    );
    expect(within(card("Instagram")).getByText("Conectado")).toBeInTheDocument();
  });

  it("sin sesión → mensaje de sesión, ninguna petición de desconexión", async () => {
    await ready();
    ask("Instagram");
    auth.session = null;

    await act(async () => {
      fireEvent.click(confirmBtn("Instagram"));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Tu sesión ya no es válida",
    );
    expect(disconnectCalls()).toHaveLength(0);
  });
});

describe("MFA: la desconexión NUNCA se reproduce sola", () => {
  it("step_up_required → se informa al contenedor, la confirmación se cierra y no hay reintento", async () => {
    await ready();
    ask("Instagram");
    disconnectImpl = () =>
      httpResponse(403, { error: "Autenticación requerida", code: "step_up_required" });

    await act(async () => {
      fireEvent.click(confirmBtn("Instagram"));
    });

    await waitFor(() => expect(failures).toEqual(["step_up_required"]));
    expect(screen.queryByRole("group", { name: /Confirmar desconexión/ })).toBeNull();
    expect(within(card("Instagram")).getByText("Conectado")).toBeInTheDocument();
    expect(disconnectCalls()).toHaveLength(1);
  });

  it("403 genérico (rol/capacidad revocados) → forbidden, jamás MFA", async () => {
    await ready();
    ask("Instagram");
    disconnectImpl = () => httpResponse(403, { error: "Prohibido" });

    await act(async () => {
      fireEvent.click(confirmBtn("Instagram"));
    });

    await waitFor(() => expect(failures).toEqual(["forbidden"]));
  });

  it("401 → unauthenticated", async () => {
    await ready();
    ask("Instagram");
    disconnectImpl = () => httpResponse(401, { error: "No autorizado" });

    await act(async () => {
      fireEvent.click(confirmBtn("Instagram"));
    });

    await waitFor(() => expect(failures).toEqual(["unauthenticated"]));
  });

  it("al volver del MFA la sección se monta de nuevo: sin confirmación abierta y SIN ninguna desconexión", async () => {
    const view = await ready();
    ask("Instagram");
    disconnectImpl = () => httpResponse(403, { code: "step_up_required" });
    await act(async () => {
      fireEvent.click(confirmBtn("Instagram"));
    });
    await waitFor(() => expect(failures).toEqual(["step_up_required"]));
    const before = disconnectCalls().length;

    // El contenedor lleva a /admin/mfa y, tras verificarlo, vuelve a /admin: monta la sección de nuevo.
    view.unmount();
    disconnectImpl = () => httpResponse(200, {});
    install();
    renderSection();
    await screen.findByRole("heading", { name: "Instagram" });

    expect(screen.queryByRole("group", { name: /Confirmar desconexión/ })).toBeNull();
    expect(disconnectCalls()).toHaveLength(before); // ninguna desconexión nueva
    expect(within(card("Instagram")).getByText("Conectado")).toBeInTheDocument();
    // Hay que confirmar de nuevo: Desconectar abre la confirmación, no ejecuta.
    ask("Instagram");
    expect(disconnectCalls()).toHaveLength(before);
    expect(
      screen.getByRole("group", { name: /Confirmar desconexión de Instagram/ }),
    ).toBeInTheDocument();
  });

  it("ninguna intención, token ni credencial se guarda en URL, localStorage ni sessionStorage", async () => {
    const setLocal = vi.spyOn(Storage.prototype, "setItem");
    const before = window.location.href;
    await ready();
    ask("Instagram");
    disconnectImpl = () => httpResponse(403, { code: "step_up_required" });
    await act(async () => {
      fireEvent.click(confirmBtn("Instagram"));
    });
    await waitFor(() => expect(failures).toHaveLength(1));

    expect(setLocal).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    expect(window.location.href).not.toMatch(/intent|disconnect|token/i);
  });
});

describe("conexión y desconexión no se pisan", () => {
  it("mientras se desconecta, los botones de conectar/desconectar quedan deshabilitados", async () => {
    state({ status: "connected" }, { status: "not_connected" });
    let resolve!: (r: unknown) => void;
    disconnectImpl = () => new Promise((r) => (resolve = r));
    await ready();
    ask("Instagram");
    fireEvent.click(confirmBtn("Instagram"));

    await waitFor(() => expect(disconnectCalls()).toHaveLength(1));
    expect(
      within(card("TikTok")).getByRole("button", { name: "Conectar TikTok" }),
    ).toBeDisabled();

    resolve(httpResponse(200, {}));
    await waitFor(() => expect(statusCalls()).toHaveLength(2));
  });
});
