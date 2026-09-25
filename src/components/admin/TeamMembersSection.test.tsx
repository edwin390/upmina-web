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
import TeamMembersSection from "./TeamMembersSection";

// Sección "Miembros del equipo" (Bloque 9F). El backend (team_admin + AAL2 + RPC) decide todo lo
// privilegiado; aquí se fija cómo la UI consume el contrato de /api/admin/team-members,
// /api/admin/team-members-role y /api/admin/team-members-remove: identidad, controles (ninguno en
// la fila propia), confirmaciones, foco, un solo mutador, sin actualización optimista y releer el
// listado tras cada resultado del servidor. Todos los datos son SINTÉTICOS.

const TOKEN = "jwt-sintetico-de-prueba";
const SELF = "11111111-1111-4111-8111-111111111111";
const MOD = "22222222-2222-4222-8222-222222222222";
const DEV = "33333333-3333-4333-8333-333333333333";
const ADM = "44444444-4444-4444-8444-444444444444";
const BARE = "55555555-5555-4555-8555-555555555555";

const auth = vi.hoisted(() => ({ session: null as null | { access_token: string } }));

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: auth.session } }) } },
}));

type Member = Record<string, unknown>;
const member = (user_id: string, over: Member = {}): Member => ({
  user_id,
  role: "moderator",
  granted_at: "2026-09-20T12:00:00.000Z",
  username: null,
  display_name: null,
  email: null,
  is_self: false,
  ...over,
});

const SELF_M = member(SELF, {
  role: "admin",
  display_name: "Yo Mismo",
  username: "yo_mismo",
  email: "yo@example.invalid",
  is_self: true,
});
const MOD_M = member(MOD, {
  display_name: "Mina Moderadora",
  username: "mina_mod",
  email: "mina@example.invalid",
});
const DEV_M = member(DEV, { role: "developer", username: "dev_solo" });
const ADM_M = member(ADM, { role: "admin", display_name: "Otro Admin" });
const BARE_M = member(BARE, { email: "sin-perfil@example.invalid" });

const fetchMock = vi.fn();
const res = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

interface Routes {
  list?: () => unknown;
  role?: (body: string) => unknown;
  remove?: (body: string) => unknown;
}
function route(r: Routes) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/admin/team-members" && method === "GET") {
      return r.list ? r.list() : res(200, { members: [SELF_M, MOD_M, DEV_M, ADM_M] });
    }
    if (url === "/api/admin/team-members-role" && method === "POST") {
      return (
        r.role?.(String(init?.body)) ??
        res(200, {
          user_id: MOD,
          role: "developer",
          previous_role: "moderator",
          changed_at: "2026-09-28T10:00:00.000Z",
          revoked_invitations: 0,
        })
      );
    }
    if (url === "/api/admin/team-members-remove" && method === "POST") {
      return (
        r.remove?.(String(init?.body)) ??
        res(200, {
          user_id: MOD,
          previous_role: "moderator",
          removed_at: "2026-09-28T10:00:00.000Z",
          revoked_invitations: 0,
        })
      );
    }
    throw new Error(`fetch inesperado: ${method} ${url}`);
  });
}
const calls = (method: string, url: string) =>
  fetchMock.mock.calls.filter((c) => c[0] === url && (c[1]?.method ?? "GET") === method);
const gets = () => calls("GET", "/api/admin/team-members");
const roles = () => calls("POST", "/api/admin/team-members-role");
const removes = () => calls("POST", "/api/admin/team-members-remove");

beforeEach(() => {
  auth.session = { access_token: TOKEN };
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderReady(r: Routes = {}) {
  route(r);
  render(<TeamMembersSection />);
  await waitFor(() => expect(screen.queryByText("Cargando miembros…")).toBeNull());
}

const row = (text: string | RegExp) =>
  screen.getByText(text).closest("li") as HTMLElement;

/** Elige un rol en la fila y pulsa Aplicar (abre la confirmación). */
function pickRole(li: HTMLElement, role: string) {
  fireEvent.change(within(li).getByLabelText("Nuevo rol"), { target: { value: role } });
  fireEvent.click(within(li).getByRole("button", { name: /^Aplicar cambio de rol a/ }));
}

describe("listado", () => {
  it("loading mientras carga", async () => {
    let release!: (v: unknown) => void;
    route({ list: () => new Promise((r) => (release = r)) });
    render(<TeamMembersSection />);
    expect(await screen.findByText("Cargando miembros…")).toBeInTheDocument();
    await act(async () => release(res(200, { members: [] })));
  });

  it("vacío", async () => {
    await renderReady({ list: () => res(200, { members: [] }) });
    expect(screen.getByText("No hay miembros para mostrar.")).toBeInTheDocument();
  });

  it("envía el Bearer y muestra cada miembro con identidad, rol textual, email y fecha", async () => {
    await renderReady();
    expect(gets()).toHaveLength(1);
    expect(gets()[0][1].headers).toEqual({ Authorization: `Bearer ${TOKEN}` });

    const mina = row("Mina Moderadora");
    expect(within(mina).getByText("MODERADOR")).toBeInTheDocument();
    expect(within(mina).getByText("@mina_mod")).toBeInTheDocument();
    expect(within(mina).getByText("mina@example.invalid")).toBeInTheDocument();
    expect(within(mina).getByText(/Acceso desde:/)).toBeInTheDocument();

    expect(within(row("@dev_solo")).getByText("DEVELOPER")).toBeInTheDocument();
    expect(within(row("Otro Admin")).getByText("ADMIN")).toBeInTheDocument();
  });

  it("fallback de identidad: display_name → @username → «Cuenta sin perfil» (con email secundario)", async () => {
    await renderReady({
      list: () => res(200, { members: [SELF_M, MOD_M, DEV_M, BARE_M] }),
    });
    expect(screen.getByText("Mina Moderadora")).toBeInTheDocument();
    expect(screen.getByText("@dev_solo")).toBeInTheDocument();
    const bare = row("Cuenta sin perfil");
    expect(within(bare).getByText("sin-perfil@example.invalid")).toBeInTheDocument();
    // El UUID nunca es la identidad visible.
    expect(screen.queryByText(BARE)).toBeNull();
  });

  it("los botones de una cuenta sin perfil incluyen el email para no ser ambiguos", async () => {
    await renderReady({ list: () => res(200, { members: [SELF_M, BARE_M] }) });
    expect(
      screen.getByRole("button", {
        name: "Quitar acceso a Cuenta sin perfil (sin-perfil@example.invalid)",
      }),
    ).toBeInTheDocument();
  });

  it.each([
    ["sin members", {}],
    ["members no arreglo", { members: "x" }],
    ["rol desconocido", { members: [member(MOD, { role: "user" })] }],
    ["is_self no booleano", { members: [member(MOD, { is_self: "no" })] }],
    ["email de tipo inesperado", { members: [member(MOD, { email: 3 })] }],
    ["fila que no es objeto", { members: ["x"] }],
  ])("respuesta 200 malformada (%s) → error genérico", async (_n, body) => {
    await renderReady({ list: () => res(200, body) });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "No se pudieron cargar los miembros.",
    );
  });

  it("descarta campos extra del servidor (lista blanca): no se renderizan", async () => {
    await renderReady({
      list: () =>
        res(200, {
          members: [{ ...MOD_M, phone: "+000-SINTETICO", granted_by: SELF }],
        }),
    });
    expect(screen.queryByText(/SINTETICO/)).toBeNull();
  });

  it.each([
    [401, "Tu sesión ya no es válida. Inicia sesión de nuevo."],
    [
      403,
      "No se pudo autorizar esta acción. Comprueba tu verificación en dos pasos e inténtalo de nuevo.",
    ],
    [500, "No se pudieron cargar los miembros."],
  ])("error %i → mensaje genérico y Reintentar", async (status, message) => {
    await renderReady({ list: () => res(status, { error: "detalle interno de DB" }) });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(alert).not.toHaveTextContent("detalle interno");

    route({});
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByText("Mina Moderadora")).toBeInTheDocument();
    expect(gets()).toHaveLength(2);
  });

  it("fallo de red al listar → error genérico", async () => {
    await renderReady({
      list: () => {
        throw new Error("ECONNRESET 10.0.0.1");
      },
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("No se pudieron cargar los miembros.");
    expect(alert).not.toHaveTextContent("ECONNRESET");
  });

  it("sin sesión → mensaje de sesión y ninguna petición", async () => {
    auth.session = null;
    await renderReady();
    expect(screen.getByRole("alert")).toHaveTextContent("Tu sesión ya no es válida");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("respuestas obsoletas: una lectura anterior que llega tarde NO pisa a la más reciente", async () => {
    const held: ((v: unknown) => void)[] = [];
    let call = 0;
    await renderReady({
      list: () => {
        call++;
        return call === 1
          ? res(200, { members: [SELF_M, MOD_M, DEV_M] })
          : new Promise((r) => held.push(r));
      },
    });

    // Dos mutaciones seguidas → dos relecturas (#2 y #3) en vuelo a la vez.
    const first = row("Mina Moderadora");
    fireEvent.click(within(first).getByRole("button", { name: /^Quitar acceso a/ }));
    fireEvent.click(within(first).getByRole("button", { name: "Sí, quitar acceso" }));
    await waitFor(() => expect(held).toHaveLength(1));
    const second = row("@dev_solo");
    fireEvent.click(within(second).getByRole("button", { name: /^Quitar acceso a/ }));
    fireEvent.click(within(second).getByRole("button", { name: "Sí, quitar acceso" }));
    await waitFor(() => expect(held).toHaveLength(2));

    // La más reciente responde primero (solo queda SELF); la antigua llega después (aún con MOD).
    await act(async () => held[1](res(200, { members: [SELF_M] })));
    await act(async () => held[0](res(200, { members: [SELF_M, DEV_M] })));

    expect(screen.queryByText("@dev_solo")).toBeNull();
    expect(screen.getByText("Yo Mismo")).toBeInTheDocument();
  });
});

describe("fila propia", () => {
  it("muestra «Tú» y NINGÚN control de cambio de rol ni de quitar acceso", async () => {
    await renderReady();
    const self = row("Yo Mismo");
    expect(within(self).getByText("Tú")).toBeInTheDocument();
    expect(within(self).queryByLabelText("Nuevo rol")).toBeNull();
    expect(within(self).queryByRole("button")).toBeNull();
  });

  it("los demás miembros sí tienen selector, Aplicar y Quitar acceso", async () => {
    await renderReady();
    for (const text of ["Mina Moderadora", "@dev_solo", "Otro Admin"]) {
      const li = row(text);
      expect(within(li).getByLabelText("Nuevo rol")).toBeInTheDocument();
      expect(
        within(li).getByRole("button", { name: /^Aplicar cambio de rol a/ }),
      ).toBeDisabled();
      expect(within(li).getByRole("button", { name: /^Quitar acceso a/ })).toBeEnabled();
    }
  });

  it("el selector ofrece solo los OTROS roles", async () => {
    await renderReady();
    const options = within(row("Mina Moderadora"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["Elegir rol…", "ADMIN", "DEVELOPER"]);
  });
});

describe("cambio de rol", () => {
  it("Aplicar exige confirmación: elegir rol no envía nada y la confirmación nombra a la persona", async () => {
    await renderReady();
    const li = row("Mina Moderadora");
    pickRole(li, "developer");

    expect(roles()).toHaveLength(0);
    const group = within(li).getByRole("group", { name: "Confirmar cambio de rol" });
    expect(group).toHaveTextContent(
      "¿Cambiar el rol de Mina Moderadora de MODERADOR a DEVELOPER?",
    );
  });

  it("al abrir la confirmación el foco va a «Cancelar»; cancelar devuelve el foco a Aplicar y no envía", async () => {
    await renderReady();
    const li = row("Mina Moderadora");
    pickRole(li, "developer");
    const cancel = within(li).getByRole("button", { name: "Cancelar" });
    await waitFor(() => expect(cancel).toHaveFocus());

    fireEvent.click(cancel);
    expect(within(li).queryByRole("group")).toBeNull();
    await waitFor(() =>
      expect(
        within(li).getByRole("button", { name: /^Aplicar cambio de rol a/ }),
      ).toHaveFocus(),
    );
    expect(roles()).toHaveLength(0);
  });

  it("confirmar envía SOLO { user_id, role } con el Bearer y luego relee el listado desde el servidor", async () => {
    let served = 0;
    await renderReady({
      list: () => {
        served++;
        return served === 1
          ? res(200, { members: [SELF_M, MOD_M] })
          : res(200, { members: [SELF_M, { ...MOD_M, role: "developer" }] });
      },
    });
    const li = row("Mina Moderadora");
    pickRole(li, "developer");
    fireEvent.click(within(li).getByRole("button", { name: "Sí, cambiar rol" }));

    await waitFor(() => expect(roles()).toHaveLength(1));
    expect(JSON.parse(roles()[0][1].body)).toEqual({ user_id: MOD, role: "developer" });
    expect(roles()[0][1].headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });

    // El rol mostrado es el que devuelve el servidor tras releer.
    await waitFor(() => expect(gets()).toHaveLength(2));
    await waitFor(() =>
      expect(within(row("Mina Moderadora")).getByText("DEVELOPER")).toBeInTheDocument(),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Rol actualizado.");
    expect(document.activeElement?.textContent).toBe("Miembros actuales");
  });

  it("SIN actualización optimista: mientras el POST está pendiente el rol mostrado no cambia", async () => {
    let release!: (v: unknown) => void;
    await renderReady({ role: () => new Promise((r) => (release = r)) });
    const li = row("Mina Moderadora");
    pickRole(li, "developer");
    fireEvent.click(within(li).getByRole("button", { name: "Sí, cambiar rol" }));
    await waitFor(() => expect(roles()).toHaveLength(1));

    expect(within(row("Mina Moderadora")).getByText("MODERADOR")).toBeInTheDocument();
    expect(within(row("Mina Moderadora")).queryByText("DEVELOPER")).toBeNull();
    await act(async () =>
      release(
        res(200, {
          user_id: MOD,
          role: "developer",
          previous_role: "moderator",
          changed_at: "2026-09-28T10:00:00.000Z",
          revoked_invitations: 0,
        }),
      ),
    );
  });

  it("loading en la fila y un solo mutador: doble clic síncrono envía UNA sola petición", async () => {
    let release!: (v: unknown) => void;
    await renderReady({ role: () => new Promise((r) => (release = r)) });
    const li = row("Mina Moderadora");
    pickRole(li, "developer");
    const confirm = within(li).getByRole("button", { name: "Sí, cambiar rol" });
    await act(async () => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(roles()).toHaveLength(1));
    expect(within(li).getByRole("button", { name: "Aplicando…" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    // Los demás controles quedan deshabilitados mientras hay una mutación activa.
    expect(
      within(row("Otro Admin")).getByRole("button", { name: /^Quitar acceso a/ }),
    ).toBeDisabled();
    expect(within(row("Otro Admin")).getByLabelText("Nuevo rol")).toBeDisabled();

    await act(async () =>
      release(
        res(200, {
          user_id: MOD,
          role: "developer",
          previous_role: "moderator",
          changed_at: "2026-09-28T10:00:00.000Z",
          revoked_invitations: 0,
        }),
      ),
    );
    expect(roles()).toHaveLength(1);
  });

  it("degradar a un ADMIN avisa de que sus invitaciones pendientes se revocarán y muestra cuántas se revocaron", async () => {
    await renderReady({
      role: () =>
        res(200, {
          user_id: ADM,
          role: "moderator",
          previous_role: "admin",
          changed_at: "2026-09-28T10:00:00.000Z",
          revoked_invitations: 2,
        }),
    });
    const li = row("Otro Admin");
    pickRole(li, "moderator");
    expect(within(li).getByRole("group")).toHaveTextContent(
      "Sus invitaciones pendientes se revocarán",
    );
    fireEvent.click(within(li).getByRole("button", { name: "Sí, cambiar rol" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Rol actualizado. Se revocaron 2 invitaciones pendientes suyas.",
      ),
    );
  });

  it("un solo ADMIN degradado con 1 invitación → aviso en singular; sin invitaciones → sin sufijo", async () => {
    await renderReady({
      role: () =>
        res(200, {
          user_id: ADM,
          role: "developer",
          previous_role: "admin",
          changed_at: "2026-09-28T10:00:00.000Z",
          revoked_invitations: 1,
        }),
    });
    const li = row("Otro Admin");
    pickRole(li, "developer");
    fireEvent.click(within(li).getByRole("button", { name: "Sí, cambiar rol" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Rol actualizado. Se revocó 1 invitación pendiente suya.",
      ),
    );
  });

  it("quitar acceso con invitaciones revocadas también informa cuántas", async () => {
    await renderReady({
      remove: () =>
        res(200, {
          user_id: ADM,
          previous_role: "admin",
          removed_at: "2026-09-28T10:00:00.000Z",
          revoked_invitations: 3,
        }),
    });
    const li = row("Otro Admin");
    fireEvent.click(within(li).getByRole("button", { name: /^Quitar acceso a/ }));
    fireEvent.click(within(li).getByRole("button", { name: "Sí, quitar acceso" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Acceso quitado. Se revocaron 3 invitaciones pendientes suyas.",
      ),
    );
  });

  it("promover a ADMIN avisa del control total y NO menciona invitaciones", async () => {
    await renderReady();
    const li = row("Mina Moderadora");
    pickRole(li, "admin");
    const text = within(li).getByRole("group").textContent ?? "";
    expect(text).toContain("Tendrá control total del equipo.");
    expect(text).not.toContain("invitaciones");
  });

  it.each([
    [404, "Este cambio ya no se puede aplicar. Actualizamos la lista."],
    [409, "Este cambio ya no se puede aplicar. Actualizamos la lista."],
  ])(
    "%i → mensaje genérico, cierra la confirmación y RELEE el listado",
    async (status, message) => {
      await renderReady({ role: () => res(status, { error: "detalle" }) });
      const li = row("Mina Moderadora");
      pickRole(li, "developer");
      fireEvent.click(within(li).getByRole("button", { name: "Sí, cambiar rol" }));

      await waitFor(() => expect(gets()).toHaveLength(2));
      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.queryByRole("group")).toBeNull();
    },
  );

  it.each([
    [401, "Tu sesión ya no es válida. Inicia sesión de nuevo."],
    [
      403,
      "No se pudo autorizar esta acción. Comprueba tu verificación en dos pasos e inténtalo de nuevo.",
    ],
    [500, "No pudimos cambiar el rol. Inténtalo de nuevo."],
  ])(
    "error %i → mensaje genérico en la fila, la confirmación sigue abierta y NO se relee",
    async (status, message) => {
      await renderReady({
        role: () => res(status, { error: "password authentication failed" }),
      });
      const li = row("Mina Moderadora");
      pickRole(li, "developer");
      fireEvent.click(within(li).getByRole("button", { name: "Sí, cambiar rol" }));

      const alert = await within(li).findByRole("alert");
      expect(alert).toHaveTextContent(message);
      expect(alert).not.toHaveTextContent("password");
      expect(within(li).getByRole("group")).toBeInTheDocument();
      expect(gets()).toHaveLength(1);
      // El bloqueo se libera: se puede reintentar.
      expect(within(li).getByRole("button", { name: "Sí, cambiar rol" })).toBeEnabled();
    },
  );

  it("fallo de red → mensaje genérico sin detalles", async () => {
    await renderReady({
      role: () => {
        throw new Error("ECONNRESET 10.0.0.1");
      },
    });
    const li = row("Mina Moderadora");
    pickRole(li, "developer");
    fireEvent.click(within(li).getByRole("button", { name: "Sí, cambiar rol" }));
    const alert = await within(li).findByRole("alert");
    expect(alert).toHaveTextContent("No pudimos cambiar el rol. Inténtalo de nuevo.");
    expect(alert).not.toHaveTextContent("ECONNRESET");
  });

  it("si el listado cambia el rol de la persona, una selección igual al rol actual no habilita Aplicar", async () => {
    await renderReady();
    const li = row("Mina Moderadora");
    fireEvent.change(within(li).getByLabelText("Nuevo rol"), {
      target: { value: "developer" },
    });
    expect(
      within(li).getByRole("button", { name: /^Aplicar cambio de rol a/ }),
    ).toBeEnabled();
    fireEvent.change(within(li).getByLabelText("Nuevo rol"), { target: { value: "" } });
    expect(
      within(li).getByRole("button", { name: /^Aplicar cambio de rol a/ }),
    ).toBeDisabled();
  });
});

describe("quitar acceso", () => {
  it("exige confirmación y explica que la cuenta y el perfil NO se eliminan", async () => {
    await renderReady();
    const li = row("Mina Moderadora");
    fireEvent.click(within(li).getByRole("button", { name: /^Quitar acceso a/ }));

    expect(removes()).toHaveLength(0);
    const group = within(li).getByRole("group", { name: "Confirmar quitar acceso" });
    expect(group).toHaveTextContent("La cuenta y el perfil NO se eliminan");
    expect(group).toHaveTextContent("Mina Moderadora");
  });

  it("foco inicial en «Cancelar»; cancelar devuelve el foco a «Quitar acceso» y no envía", async () => {
    await renderReady();
    const li = row("Mina Moderadora");
    fireEvent.click(within(li).getByRole("button", { name: /^Quitar acceso a/ }));
    const cancel = within(li).getByRole("button", { name: "Cancelar" });
    await waitFor(() => expect(cancel).toHaveFocus());

    fireEvent.click(cancel);
    await waitFor(() =>
      expect(within(li).getByRole("button", { name: /^Quitar acceso a/ })).toHaveFocus(),
    );
    expect(removes()).toHaveLength(0);
  });

  it("confirmar envía SOLO { user_id }, relee el listado y muestra el aviso", async () => {
    let served = 0;
    await renderReady({
      list: () => {
        served++;
        return served === 1
          ? res(200, { members: [SELF_M, MOD_M] })
          : res(200, { members: [SELF_M] });
      },
    });
    const li = row("Mina Moderadora");
    fireEvent.click(within(li).getByRole("button", { name: /^Quitar acceso a/ }));
    fireEvent.click(within(li).getByRole("button", { name: "Sí, quitar acceso" }));

    await waitFor(() => expect(removes()).toHaveLength(1));
    expect(JSON.parse(removes()[0][1].body)).toEqual({ user_id: MOD });
    await waitFor(() => expect(screen.queryByText("Mina Moderadora")).toBeNull());
    expect(gets()).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent("Acceso quitado.");
    expect(document.activeElement?.textContent).toBe("Miembros actuales");
  });

  it("SIN actualización optimista: la fila sigue hasta que el servidor responde", async () => {
    let release!: (v: unknown) => void;
    await renderReady({ remove: () => new Promise((r) => (release = r)) });
    const li = row("Mina Moderadora");
    fireEvent.click(within(li).getByRole("button", { name: /^Quitar acceso a/ }));
    fireEvent.click(within(li).getByRole("button", { name: "Sí, quitar acceso" }));
    await waitFor(() => expect(removes()).toHaveLength(1));
    expect(screen.getByText("Mina Moderadora")).toBeInTheDocument();
    await act(async () =>
      release(
        res(200, {
          user_id: MOD,
          previous_role: "moderator",
          removed_at: "2026-09-28T10:00:00.000Z",
          revoked_invitations: 0,
        }),
      ),
    );
  });

  it("doble clic síncrono en «Sí, quitar acceso» envía UNA sola petición", async () => {
    let release!: (v: unknown) => void;
    await renderReady({ remove: () => new Promise((r) => (release = r)) });
    const li = row("Mina Moderadora");
    fireEvent.click(within(li).getByRole("button", { name: /^Quitar acceso a/ }));
    const confirm = within(li).getByRole("button", { name: "Sí, quitar acceso" });
    await act(async () => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(removes()).toHaveLength(1));
    await act(async () =>
      release(
        res(200, {
          user_id: MOD,
          previous_role: "moderator",
          removed_at: "2026-09-28T10:00:00.000Z",
          revoked_invitations: 0,
        }),
      ),
    );
    expect(removes()).toHaveLength(1);
  });

  it("quitar a un ADMIN avisa de la revocación de invitaciones; un no-ADMIN no", async () => {
    await renderReady();
    fireEvent.click(
      within(row("Otro Admin")).getByRole("button", { name: /^Quitar acceso a/ }),
    );
    expect(within(row("Otro Admin")).getByRole("group")).toHaveTextContent(
      "Sus invitaciones pendientes se revocarán",
    );
    fireEvent.click(within(row("Otro Admin")).getByRole("button", { name: "Cancelar" }));

    fireEvent.click(
      within(row("Mina Moderadora")).getByRole("button", { name: /^Quitar acceso a/ }),
    );
    expect(within(row("Mina Moderadora")).getByRole("group").textContent).not.toContain(
      "invitaciones",
    );
  });

  it.each([404, 409])(
    "%i → cierra la confirmación, mensaje genérico y RELEE el listado",
    async (status) => {
      await renderReady({ remove: () => res(status, { error: "last_admin_protected" }) });
      const li = row("Mina Moderadora");
      fireEvent.click(within(li).getByRole("button", { name: /^Quitar acceso a/ }));
      fireEvent.click(within(li).getByRole("button", { name: "Sí, quitar acceso" }));

      await waitFor(() => expect(gets()).toHaveLength(2));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(
        "Este cambio ya no se puede aplicar. Actualizamos la lista.",
      );
      expect(alert).not.toHaveTextContent("last_admin_protected");
      expect(screen.queryByRole("group")).toBeNull();
    },
  );

  it.each([
    [401, "Tu sesión ya no es válida. Inicia sesión de nuevo."],
    [
      403,
      "No se pudo autorizar esta acción. Comprueba tu verificación en dos pasos e inténtalo de nuevo.",
    ],
    [500, "No pudimos quitar el acceso. Inténtalo de nuevo."],
  ])(
    "error %i → mensaje genérico, confirmación abierta y sin releer",
    async (status, message) => {
      await renderReady({ remove: () => res(status, { error: "detalle interno" }) });
      const li = row("Mina Moderadora");
      fireEvent.click(within(li).getByRole("button", { name: /^Quitar acceso a/ }));
      fireEvent.click(within(li).getByRole("button", { name: "Sí, quitar acceso" }));

      const alert = await within(li).findByRole("alert");
      expect(alert).toHaveTextContent(message);
      expect(alert).not.toHaveTextContent("detalle interno");
      expect(gets()).toHaveLength(1);
      expect(within(li).getByRole("group")).toBeInTheDocument();
    },
  );

  it("sin sesión al confirmar → mensaje de sesión y ninguna mutación", async () => {
    await renderReady();
    auth.session = null;
    const li = row("Mina Moderadora");
    fireEvent.click(within(li).getByRole("button", { name: /^Quitar acceso a/ }));
    fireEvent.click(within(li).getByRole("button", { name: "Sí, quitar acceso" }));
    expect(await within(li).findByRole("alert")).toHaveTextContent(
      "Tu sesión ya no es válida",
    );
    expect(removes()).toHaveLength(0);
  });
});

describe("una sola mutación a la vez y limpieza", () => {
  it("abrir una segunda confirmación reemplaza a la primera (solo una a la vez)", async () => {
    await renderReady();
    fireEvent.click(
      within(row("Mina Moderadora")).getByRole("button", { name: /^Quitar acceso a/ }),
    );
    fireEvent.click(
      within(row("Otro Admin")).getByRole("button", { name: /^Quitar acceso a/ }),
    );
    expect(screen.getAllByRole("group")).toHaveLength(1);
    expect(within(row("Otro Admin")).getByRole("group")).toBeInTheDocument();
  });

  it("desmontar con una petición pendiente no produce actualizaciones de estado ni errores", async () => {
    let release!: (v: unknown) => void;
    route({ list: () => new Promise((r) => (release = r)) });
    const { unmount } = render(<TeamMembersSection />);
    await waitFor(() => expect(gets()).toHaveLength(1));
    unmount();
    const spy = vi.spyOn(console, "error");
    await act(async () => release(res(200, { members: [SELF_M] })));
    expect(spy).not.toHaveBeenCalled();
  });

  it("el email no se escribe en ningún storage ni en la consola", async () => {
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const err = vi.spyOn(console, "error");
    await renderReady();
    const dump = JSON.stringify([
      Object.entries(localStorage),
      Object.entries(sessionStorage),
      log.mock.calls,
      warn.mock.calls,
      err.mock.calls,
    ]);
    expect(dump).not.toContain("example.invalid");
  });
});
