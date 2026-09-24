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
import TeamInvitationsSection from "./TeamInvitationsSection";
import { buildActivationUrl } from "@/lib/admin-invitation-link";

// Sección "Invitaciones del equipo" (Bloque 9E). El backend (team_admin + AAL2) decide todo lo
// privilegiado; aquí se fija cómo la UI consume el contrato de /api/admin/team-invitations y
// /api/admin/team-invitations-revoke, y sobre todo el manejo del ENLACE SENSIBLE: solo existe
// tras crear, solo en el estado del componente, y desaparece al descartarlo.

const TOKEN = "jwt-sintetico-de-prueba";
const SECRET = "SECRETO_SINTETICO_0123456789_ABCDEFGHIJKLMNOPQRS"; // valor ficticio
const ACTIVATION_PATH = `/admin/activate#token=${SECRET}`;
const ID1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ID4 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ID5 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const auth = vi.hoisted(() => ({ session: null as null | { access_token: string } }));

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: auth.session } }) } },
}));

type Inv = Record<string, unknown>;
const inv = (id: string, over: Inv = {}): Inv => ({
  id,
  role: "moderator",
  invitation_type: "standard",
  status: "pending",
  created_at: "2026-09-20T12:00:00.000Z",
  expires_at: "2099-09-27T12:00:00.000Z",
  consumed_at: null,
  revoked_at: null,
  ...over,
});
const CONSUMED_AT = "2026-09-21T12:00:00.000Z";

const fetchMock = vi.fn();
const res = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

interface Routes {
  list?: () => unknown;
  create?: (body: string) => unknown;
  revoke?: (body: string) => unknown;
}
function route(r: Routes) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/admin/team-invitations" && method === "GET") {
      return r.list ? r.list() : res(200, { invitations: [] });
    }
    if (url === "/api/admin/team-invitations" && method === "POST") {
      const out = r.create?.(String(init?.body));
      return (
        out ??
        res(201, {
          invitation: inv(ID1),
          token: SECRET,
          activation_path: ACTIVATION_PATH,
        })
      );
    }
    if (url === "/api/admin/team-invitations-revoke" && method === "POST") {
      const out = r.revoke?.(String(init?.body));
      return (
        out ??
        res(200, { id: ID1, status: "revoked", revoked_at: "2026-09-25T12:00:00.000Z" })
      );
    }
    throw new Error(`fetch inesperado: ${method} ${url}`);
  });
}
const calls = (method: string, url: string) =>
  fetchMock.mock.calls.filter((c) => c[0] === url && (c[1]?.method ?? "GET") === method);
const posts = () => calls("POST", "/api/admin/team-invitations");
const revokes = () => calls("POST", "/api/admin/team-invitations-revoke");
const gets = () => calls("GET", "/api/admin/team-invitations");

const clipboard = { writeText: vi.fn() };

beforeEach(() => {
  auth.session = { access_token: TOKEN };
  fetchMock.mockReset();
  clipboard.writeText.mockReset();
  clipboard.writeText.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderReady(r: Routes = {}) {
  route(r);
  render(<TeamInvitationsSection />);
  await waitFor(() => expect(screen.queryByText("Cargando invitaciones…")).toBeNull());
}

async function createLink(role: "admin" | "moderator" = "moderator") {
  fireEvent.change(screen.getByLabelText("Rol de la invitación"), {
    target: { value: role },
  });
  fireEvent.click(screen.getByRole("button", { name: "Crear invitación" }));
  return screen.findByRole("region", { name: "Invitación creada" });
}

const created = (over: Inv = {}) =>
  res(201, {
    invitation: inv(ID1, over),
    token: SECRET,
    activation_path: ACTIVATION_PATH,
  });
const revokedOk = () =>
  res(200, { id: ID1, status: "revoked", revoked_at: "2026-09-25T12:00:00.000Z" });

describe("listado", () => {
  it("loading mientras carga", async () => {
    let release!: (v: unknown) => void;
    route({ list: () => new Promise((r) => (release = r)) });
    render(<TeamInvitationsSection />);
    expect(await screen.findByText("Cargando invitaciones…")).toBeInTheDocument();
    await act(async () => release(res(200, { invitations: [] })));
  });

  it("empty", async () => {
    await renderReady();
    expect(screen.getByText("Todavía no hay invitaciones.")).toBeInTheDocument();
  });

  it("pinta rol, estado y fechas; consulta con Bearer; sin secretos aunque el GET trajera campos extra", async () => {
    await renderReady({
      list: () =>
        res(200, {
          invitations: [
            {
              ...inv(ID1),
              token: "TOKEN_EN_GET",
              token_hash: "HASH_EN_GET",
              activation_path: "/admin/activate#token=X",
            },
            inv(ID2, { role: "admin", status: "consumed", consumed_at: CONSUMED_AT }),
            inv(ID3, { status: "revoked", revoked_at: CONSUMED_AT }),
            inv(ID4, { status: "expired", expires_at: "2026-09-01T12:00:00.000Z" }),
            inv(ID5, {
              role: "admin",
              invitation_type: "bootstrap_admin",
              status: "consumed",
              consumed_at: CONSUMED_AT,
            }),
          ],
        }),
    });
    expect(screen.getByText("Pendiente")).toBeInTheDocument();
    expect(screen.getAllByText("Consumida")).toHaveLength(2);
    expect(screen.getByText("Revocada")).toBeInTheDocument();
    expect(screen.getByText("Expirada")).toBeInTheDocument();
    expect(screen.getAllByText("Administrador").length).toBeGreaterThan(0);
    expect(screen.getByText("(invitación inicial)")).toBeInTheDocument();
    expect(screen.getAllByText(/Creada:/)).toHaveLength(5);
    const html = document.body.innerHTML;
    for (const secret of ["TOKEN_EN_GET", "HASH_EN_GET", "activate#token", SECRET]) {
      expect(html).not.toContain(secret);
    }
    expect(gets()[0][1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    [401, "Tu sesión ya no es válida"],
    [403, "No se pudo autorizar esta acción"],
    [500, "No se pudieron cargar las invitaciones."],
  ])("error de listado %s → mensaje genérico y Reintentar", async (status, text) => {
    await renderReady({
      list: () => res(status, { error: "detalle interno de postgres" }),
    });
    expect(screen.getByRole("alert")).toHaveTextContent(text);
    expect(document.body.textContent).not.toMatch(/postgres|rpc|sql/i);
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
    expect(screen.queryByText("Todavía no hay invitaciones.")).toBeNull();
  });

  it("forma inesperada del listado → error (nunca lista vacía)", async () => {
    await renderReady({ list: () => res(200, { invitations: [{ id: 5 }] }) });
    expect(screen.getByRole("alert")).toHaveTextContent("No se pudieron cargar");
    expect(screen.queryByText("Todavía no hay invitaciones.")).toBeNull();
  });

  it("fallo de red → error", async () => {
    fetchMock.mockRejectedValue(new Error("red"));
    render(<TeamInvitationsSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudieron cargar");
  });

  it("sin sesión → mensaje de sesión, sin llamar a la API", async () => {
    auth.session = null;
    await renderReady();
    expect(screen.getByRole("alert")).toHaveTextContent("Tu sesión ya no es válida");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("crear", () => {
  it("por defecto moderator; solo ofrece admin y moderator", async () => {
    await renderReady();
    const select = screen.getByLabelText("Rol de la invitación") as HTMLSelectElement;
    expect(select.value).toBe("moderator");
    expect([...select.options].map((o) => o.value)).toEqual(["moderator", "admin"]);
  });

  it.each([
    ["admin", "Administrador"],
    ["moderator", "Moderador"],
  ] as const)(
    "crea invitación %s: POST { role } exacto y muestra el enlace absoluto",
    async (role, label) => {
      await renderReady({ create: () => created({ role }) });
      const region = await createLink(role);
      const [call] = posts();
      expect(JSON.parse(String(call[1].body))).toEqual({ role });
      expect(call[1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(within(region).getByText(new RegExp(`Rol: ${label}`))).toBeInTheDocument();
      expect(within(region).getByText(/Expira:/)).toBeInTheDocument();
      const input = within(region).getByLabelText(
        "Enlace de activación",
      ) as HTMLInputElement;
      expect(input.value).toBe(`${window.location.origin}${ACTIVATION_PATH}`);
      expect(new URL(input.value).hash).toBe(`#token=${SECRET}`);
      expect(new URL(input.value).search).toBe(""); // fragmento, nunca query string
      expect(within(region).getByText(/es sensible/)).toBeInTheDocument();
      expect(region).toHaveFocus();
    },
  );

  it("doble submit: mientras crea se deshabilita y solo se envía UN POST", async () => {
    let release!: (v: unknown) => void;
    await renderReady({ create: () => new Promise((r) => (release = r)) });
    const button = screen.getByRole("button", { name: "Crear invitación" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.submit(button.closest("form") as HTMLFormElement);
    // El POST sale tras leer la sesión (asíncrono): se espera a que exista y se comprueba que
    // sigue siendo UNO mientras la respuesta está pendiente y después de resolverla.
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Creando…" })).toBeDisabled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(posts()).toHaveLength(1);
    await act(async () => release(created()));
    expect(
      await screen.findByRole("region", { name: "Invitación creada" }),
    ).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
  });

  it("tras crear se recarga el listado y el secreto vive solo en el campo del resultado", async () => {
    await renderReady({ list: () => res(200, { invitations: [inv(ID1)] }) });
    const before = gets().length;
    await createLink();
    await waitFor(() => expect(gets().length).toBe(before + 1));
    const region = screen.getByRole("region", { name: "Invitación creada" });
    for (const li of screen.getAllByRole("listitem")) {
      expect(li.innerHTML).not.toContain(SECRET);
    }
    const input = within(region).getByLabelText(
      "Enlace de activación",
    ) as HTMLInputElement;
    expect(input.value).toContain(SECRET);
  });

  it("crear otra invitación reemplaza (y borra) el enlace anterior", async () => {
    const SECRET2 = "OTRO_SECRETO_SINTETICO_0123456789_ABCDEFGHIJKLMN";
    let n = 0;
    await renderReady({
      create: () => {
        n += 1;
        return res(201, {
          invitation: inv(ID1),
          activation_path: `/admin/activate#token=${n === 1 ? SECRET : SECRET2}`,
        });
      },
    });
    await createLink();
    fireEvent.click(screen.getByRole("button", { name: "Crear invitación" }));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Enlace de activación") as HTMLInputElement).value,
      ).toContain(SECRET2),
    );
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it.each([
    [401, "Tu sesión ya no es válida"],
    [403, "No se pudo autorizar esta acción"],
    [400, "No pudimos crear la invitación"],
    [500, "No pudimos crear la invitación"],
  ])("error %s al crear → mensaje genérico, sin enlace", async (status, text) => {
    await renderReady({
      create: () => res(status, { error: "SQL interno rpc revoke_admin_invitation" }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear invitación" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(document.body.textContent).not.toMatch(/sql|rpc|revoke_admin/i);
    expect(screen.queryByRole("region", { name: "Invitación creada" })).toBeNull();
    expect(screen.getByRole("button", { name: "Crear invitación" })).toBeEnabled();
  });

  it.each([
    ["activation_path de otro origen", "https://evil.example/admin/activate#token=x"],
    ["ruta distinta de /admin/activate", "/otra#token=x"],
    ["sin fragmento de token", "/admin/activate?token=x"],
    ["protocol-relative", "//evil.example/admin/activate#token=x"],
    ["ausente", undefined],
  ])("respuesta 201 con %s → error, no se muestra ningún enlace", async (_n, path) => {
    await renderReady({
      create: () =>
        res(201, { invitation: inv(ID1), token: SECRET, activation_path: path }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear invitación" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos crear");
    expect(screen.queryByLabelText("Enlace de activación")).toBeNull();
    expect(document.body.innerHTML).not.toContain("evil.example");
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("buildActivationUrl solo acepta el activation_path del servidor", () => {
    expect(buildActivationUrl(ACTIVATION_PATH)).toBe(
      `${window.location.origin}${ACTIVATION_PATH}`,
    );
    expect(buildActivationUrl("https://evil.example/admin/activate#token=x")).toBeNull();
    expect(buildActivationUrl(42)).toBeNull();
    for (const bad of [
      "/admin/activate#token=",
      "/admin/activate#token=ab cd",
      "/admin/activate#token=ab%0Acd",
      `/admin/activate#token=ab${String.fromCharCode(10)}cd`,
      "/admin/activate#token=ab?x=1",
      "/admin/activate#token=ab&x=1",
      "/admin/activate#token=ab/../x",
      "/admin/activate#token=ab#cd",
      `/admin/activate#token=${String.fromCharCode(92)}evil.example`,
    ]) {
      expect(buildActivationUrl(bad), bad).toBeNull();
    }
  });
});

describe("enlace sensible: copiar, descartar y no persistir", () => {
  it("Copiar enlace → writeText con la URL absoluta y feedback", async () => {
    await renderReady();
    await createLink();
    fireEvent.click(screen.getByRole("button", { name: "Copiar enlace" }));
    await waitFor(() =>
      expect(clipboard.writeText).toHaveBeenCalledWith(
        `${window.location.origin}${ACTIVATION_PATH}`,
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Enlace copiado.");
  });

  it("fallo al copiar → feedback de error y el enlace sigue disponible para copiar a mano", async () => {
    clipboard.writeText.mockRejectedValue(new Error("denegado"));
    await renderReady();
    await createLink();
    fireEvent.click(screen.getByRole("button", { name: "Copiar enlace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo copiar");
    expect(screen.getByLabelText("Enlace de activación")).toBeInTheDocument();
  });

  it("sin API de portapapeles → mismo feedback de error, sin lanzar", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    await renderReady();
    await createLink();
    fireEvent.click(screen.getByRole("button", { name: "Copiar enlace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo copiar");
  });

  it("feedback de copiado tardío tras descartar y crear otro enlace NO se atribuye al enlace nuevo", async () => {
    let resolveCopy!: () => void;
    clipboard.writeText.mockImplementation(
      () => new Promise<void>((r) => (resolveCopy = r)),
    );
    await renderReady();
    await createLink();
    fireEvent.click(screen.getByRole("button", { name: "Copiar enlace" }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Cerrar y descartar enlace" }));
    await createLink();
    await act(async () => resolveCopy());
    expect(screen.queryByText("Enlace copiado.")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Cerrar y descartar enlace elimina el secreto del DOM y devuelve el foco al formulario", async () => {
    await renderReady();
    await createLink();
    expect(document.body.innerHTML).toContain(SECRET);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar y descartar enlace" }));
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.queryByRole("region", { name: "Invitación creada" })).toBeNull();
    expect(screen.getByRole("button", { name: "Crear invitación" })).toHaveFocus();
  });

  it("tras descartar y recargar el listado, el secreto no reaparece; un nuevo montaje tampoco lo recupera", async () => {
    await renderReady();
    await createLink();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar y descartar enlace" }));
    await waitFor(() => expect(screen.queryByText("Cargando invitaciones…")).toBeNull());
    expect(document.body.innerHTML).not.toContain(SECRET);
    cleanup();
    await renderReady();
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("no persiste el enlace: ni storage/cookies/URL ni logs de consola", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const logs = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "debug").mockImplementation(() => {}),
    ];
    await renderReady();
    await createLink();
    fireEvent.click(screen.getByRole("button", { name: "Copiar enlace" }));
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "Cerrar y descartar enlace" }));
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET);
    expect(document.cookie).not.toContain(SECRET);
    expect(window.location.href).not.toContain(SECRET);
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
  });
});

describe("revocar", () => {
  const pendingList = () => res(200, { invitations: [inv(ID1)] });
  const revokeButton = () => screen.getByRole("button", { name: /^Revocar invitación/ });

  it("solo las standard pendientes ofrecen Revocar", async () => {
    await renderReady({
      list: () =>
        res(200, {
          invitations: [
            inv(ID1),
            inv(ID2, { status: "consumed", consumed_at: CONSUMED_AT }),
            inv(ID3, { status: "revoked", revoked_at: CONSUMED_AT }),
            inv(ID4, { status: "expired" }),
            inv(ID5, { invitation_type: "bootstrap_admin", role: "admin" }),
          ],
        }),
    });
    expect(screen.getAllByRole("button", { name: /^Revocar invitación/ })).toHaveLength(
      1,
    );
  });

  it("pide confirmación: sin ella no hay POST; Cancelar cierra la confirmación", async () => {
    await renderReady({ list: pendingList });
    fireEvent.click(revokeButton());
    const group = screen.getByRole("group", { name: "Confirmar revocación" });
    expect(group).toHaveTextContent("no se puede deshacer");
    expect(revokes()).toHaveLength(0);
    fireEvent.click(within(group).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("group", { name: "Confirmar revocación" })).toBeNull();
    expect(revokes()).toHaveLength(0);
  });

  it("confirmar → POST { id }; sin actualización optimista: refleja lo que devuelve el servidor al recargar", async () => {
    let revoked = false;
    let release!: (v: unknown) => void;
    await renderReady({
      list: () =>
        res(200, {
          invitations: [
            revoked ? inv(ID1, { status: "revoked", revoked_at: CONSUMED_AT }) : inv(ID1),
          ],
        }),
      revoke: () => new Promise((r) => (release = r)),
    });
    fireEvent.click(revokeButton());
    fireEvent.click(screen.getByRole("button", { name: "Sí, revocar" }));
    expect(await screen.findByRole("button", { name: "Revocando…" })).toBeDisabled();
    expect(screen.getByText("Pendiente")).toBeInTheDocument(); // aún sin confirmar
    expect(JSON.parse(String(revokes()[0][1].body))).toEqual({ id: ID1 });
    revoked = true;
    await act(async () => release(revokedOk()));
    expect(await screen.findByText("Revocada")).toBeInTheDocument();
    expect(screen.queryByText("Pendiente")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Revocar invitación/ })).toBeNull();
  });

  it("el foco de teclado no se pierde: abrir confirmación → Cancelar; cancelar → botón Revocar de esa fila", async () => {
    await renderReady({ list: pendingList });
    fireEvent.click(revokeButton());
    const group = screen.getByRole("group", { name: "Confirmar revocación" });
    expect(within(group).getByRole("button", { name: "Cancelar" })).toHaveFocus();
    fireEvent.click(within(group).getByRole("button", { name: "Cancelar" }));
    expect(revokeButton()).toHaveFocus();
  });

  it("tras revocar con éxito el foco pasa al encabezado de la lista (la fila deja de ser revocable)", async () => {
    await renderReady({ list: pendingList });
    fireEvent.click(revokeButton());
    fireEvent.click(screen.getByRole("button", { name: "Sí, revocar" }));
    await waitFor(() => expect(revokes()).toHaveLength(1));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Invitaciones existentes" }),
      ).toHaveFocus(),
    );
  });

  it("doble click en confirmar: un solo POST", async () => {
    let release!: (v: unknown) => void;
    await renderReady({
      list: pendingList,
      revoke: () => new Promise((r) => (release = r)),
    });
    fireEvent.click(revokeButton());
    const confirm = screen.getByRole("button", { name: "Sí, revocar" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(revokes()).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Revocando…" })).toBeDisabled();
    await act(async () => release(revokedOk()));
    expect(revokes()).toHaveLength(1);
  });

  it.each([
    [401, "Tu sesión ya no es válida"],
    [403, "No se pudo autorizar esta acción"],
    [500, "No pudimos revocar la invitación"],
  ])(
    "error %s al revocar → mensaje genérico, la invitación sigue pendiente",
    async (status, text) => {
      await renderReady({
        list: pendingList,
        revoke: () => res(status, { error: "detalle SQL" }),
      });
      fireEvent.click(revokeButton());
      fireEvent.click(screen.getByRole("button", { name: "Sí, revocar" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(text);
      expect(document.body.textContent).not.toMatch(/sql|rpc/i);
      expect(screen.getByText("Pendiente")).toBeInTheDocument();
    },
  );

  it.each([[409], [404]])(
    "%s al revocar → 'ya no se puede revocar' y se vuelve a cargar el listado",
    async (status) => {
      let phase = 0;
      await renderReady({
        list: () =>
          res(200, {
            invitations: [
              phase === 0
                ? inv(ID1)
                : inv(ID1, { status: "consumed", consumed_at: CONSUMED_AT }),
            ],
          }),
        revoke: () => {
          phase = 1;
          return res(status, { error: "La invitación ya no se puede revocar" });
        },
      });
      fireEvent.click(revokeButton());
      fireEvent.click(screen.getByRole("button", { name: "Sí, revocar" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "ya no se puede revocar",
      );
      expect(await screen.findByText("Consumida")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Revocar invitación/ })).toBeNull();
    },
  );
});
