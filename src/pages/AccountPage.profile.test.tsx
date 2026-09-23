import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// Fija el onboarding/lectura de perfil dentro de /account (Bloque 7C.2). useAuth y el
// cliente de Supabase se mockean: aquí importa cómo reacciona la UI a lecturas de
// public.profiles y a las respuestas de POST /api/profile.

const USER_ID = "user-id-sintetico-0001";
const OTHER_USER_ID = "user-id-sintetico-0002";
const TOKEN = "token-sintetico-de-prueba";

type Sess = {
  access_token: string;
  refresh_token: string;
  user: { id: string; email?: string; app_metadata: object };
};

const authFakes = vi.hoisted(() => ({ session: null as null | Sess, loading: false }));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: authFakes.session,
    user: authFakes.session?.user ?? null,
    loading: authFakes.loading,
    signOut: async () => {},
  }),
}));

type ReadResult = { data: unknown; error: unknown };

const sb = vi.hoisted(() => ({
  reads: [] as { table: string; columns: string; column: string; value: unknown }[],
  readImpl: undefined as undefined | ((call: number) => Promise<ReadResult>),
  signOutCalls: 0,
  authStateListeners: 0,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (column: string, value: unknown) => ({
          maybeSingle: () => {
            sb.reads.push({ table, columns, column, value });
            return sb.readImpl
              ? sb.readImpl(sb.reads.length)
              : Promise.resolve({ data: null, error: null });
          },
        }),
      }),
    }),
    auth: {
      async signOut() {
        sb.signOutCalls++;
        return { error: null };
      },
      onAuthStateChange() {
        sb.authStateListeners++;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  },
}));

import AccountPage from "./AccountPage";

function fakeSession(id = USER_ID): Sess {
  return {
    access_token: TOKEN,
    refresh_token: "refresh-sintetico-de-prueba",
    user: { id, email: "fan@example.com", app_metadata: { role: "rol-sintetico" } },
  };
}

function tree() {
  return (
    <MemoryRouter initialEntries={["/account"]}>
      <Routes>
        <Route path="/account" element={<AccountPage />} />
        <Route path="/login" element={<p>Login stub</p>} />
      </Routes>
    </MemoryRouter>
  );
}

const fetchMock = vi.fn();

function httpResponse(status: number, body: unknown = {}) {
  return { status, json: async () => body };
}

const CREATED = {
  profile: {
    username: "edwin390",
    display_name: null,
    bio: null,
    avatar_path: null,
    created_at: "2026-09-23T00:00:00Z",
    updated_at: "2026-09-23T00:00:00Z",
  },
};

function present(overrides: Record<string, unknown> = {}) {
  sb.readImpl = async () => ({
    data: { username: "fan_sintetico", display_name: null, bio: null, ...overrides },
    error: null,
  });
}

function absent() {
  sb.readImpl = async () => ({ data: null, error: null });
}

async function renderAbsent() {
  absent();
  const utils = render(tree());
  await screen.findByLabelText("Username");
  return utils;
}

function type(value: string) {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value } });
}

function submit() {
  fireEvent.submit(screen.getByLabelText("Username").closest("form")!);
}

beforeEach(() => {
  authFakes.session = fakeSession();
  authFakes.loading = false;
  sb.reads = [];
  sb.readImpl = undefined;
  sb.signOutCalls = 0;
  sb.authStateListeners = 0;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("acceso y carga", () => {
  it("sin sesión: redirige a /login y no lee ni envía nada", () => {
    authFakes.session = null;
    render(tree());
    expect(screen.getByText("Login stub")).toBeInTheDocument();
    expect(sb.reads).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sesión aún cargando: no muestra contenido privado ni lee el perfil", () => {
    authFakes.loading = true;
    render(tree());
    expect(screen.queryByText("Tu perfil público")).toBeNull();
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(sb.reads).toHaveLength(0);
  });

  it("usuario autenticado: inicia la carga del perfil sin mostrar el formulario prematuramente", async () => {
    let resolveRead!: (r: ReadResult) => void;
    sb.readImpl = () => new Promise((resolve) => (resolveRead = resolve));
    render(tree());

    expect(screen.getByText("Cargando tu perfil…")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(sb.reads).toHaveLength(1);

    await act(async () => resolveRead({ data: null, error: null }));
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.queryByText("Cargando tu perfil…")).toBeNull();
  });

  it("lee solo public.profiles filtrando por el user_id de la sesión, sin pedir columnas privadas", async () => {
    present();
    render(tree());
    await screen.findByText("fan_sintetico");

    expect(sb.reads).toHaveLength(1);
    expect(sb.reads[0].table).toBe("profiles");
    expect(sb.reads[0].column).toBe("user_id");
    expect(sb.reads[0].value).toBe(USER_ID);
    expect(sb.reads[0].columns).not.toMatch(/user_id|role|email|\*/);
  });
});

describe("perfil existente / ausente / error", () => {
  it("perfil existente: muestra username, display_name y bio; sin formulario", async () => {
    present({ display_name: "Fan Sintético", bio: "Bio de prueba" });
    render(tree());

    expect(await screen.findByText("Fan Sintético")).toBeInTheDocument();
    expect(screen.getByText("fan_sintetico")).toBeInTheDocument();
    expect(screen.getByText("Bio de prueba")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).toBeNull();
  });

  it("perfil existente sin display_name ni bio: solo el username", async () => {
    present();
    render(tree());
    await screen.findByText("fan_sintetico");
    expect(screen.queryByText("Bio de prueba")).toBeNull();
  });

  it("perfil inexistente: muestra el onboarding con la ayuda del username", async () => {
    await renderAbsent();
    expect(screen.getByRole("button", { name: "Crear perfil" })).toBeInTheDocument();
    expect(screen.getByText(/3–20 caracteres/)).toBeInTheDocument();
  });

  it("error de lectura NO se interpreta como perfil inexistente", async () => {
    sb.readImpl = async () => ({
      data: null,
      error: { code: "XX000", message: "boom-interno" },
    });
    render(tree());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudo cargar tu perfil.",
    );
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(document.body.innerHTML).not.toContain("boom-interno");
  });

  it("excepción de red en la lectura: mismo estado de error recuperable, sin formulario", async () => {
    sb.readImpl = async () => {
      throw new Error("red-caida");
    };
    render(tree());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudo cargar tu perfil.",
    );
    expect(screen.queryByLabelText("Username")).toBeNull();
  });

  it("reintentar vuelve a leer y resuelve al estado correcto", async () => {
    sb.readImpl = async (call) =>
      call === 1
        ? { data: null, error: { code: "XX000" } }
        : {
            data: { username: "fan_sintetico", display_name: null, bio: null },
            error: null,
          };
    render(tree());

    fireEvent.click(await screen.findByRole("button", { name: "Reintentar" }));

    expect(await screen.findByText("fan_sintetico")).toBeInTheDocument();
    expect(sb.reads).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("validación del username en cliente", () => {
  it("username válido habilita el submit; vacío o inválido lo deshabilita", async () => {
    await renderAbsent();
    const button = screen.getByRole("button", { name: "Crear perfil" });
    expect(button).toBeDisabled();

    type("ab");
    expect(button).toBeDisabled();
    type("abc");
    expect(button).toBeEnabled();
  });

  it("username inválido muestra feedback y no envía (ni con Enter)", async () => {
    await renderAbsent();
    type("edwin-390");

    expect(screen.getByText(/Usa 3–20 caracteres/)).toBeInTheDocument();
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(/3–20 caracteres/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rechaza longitud 21 y acepta 3 y 20", async () => {
    await renderAbsent();
    const button = screen.getByRole("button", { name: "Crear perfil" });
    type("a".repeat(21));
    expect(button).toBeDisabled();
    type("a".repeat(20));
    expect(button).toBeEnabled();
    type("abc");
    expect(button).toBeEnabled();
  });

  it("no transliteran Unicode: edwín y homoglyph cirílico son inválidos", async () => {
    await renderAbsent();
    const button = screen.getByRole("button", { name: "Crear perfil" });
    type("edwín");
    expect(button).toBeDisabled();
    type("еdwin390");
    expect(button).toBeDisabled();
    type("edwin 390");
    expect(button).toBeDisabled();
  });

  it("hace trim y lowercase antes de enviar", async () => {
    fetchMock.mockResolvedValue(httpResponse(201, CREATED));
    await renderAbsent();
    type("  Edwin_390  ");
    submit();
    await act(async () => {});

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      username: "edwin_390",
    });
  });
});

describe("submit a POST /api/profile", () => {
  it("envía POST con Bearer de la sesión, JSON y body solo con username", async () => {
    fetchMock.mockResolvedValue(httpResponse(201, CREATED));
    await renderAbsent();
    type("edwin390");
    submit();
    await act(async () => {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/profile");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(Object.keys(JSON.parse(init.body))).toEqual(["username"]);
  });

  it("el token no aparece en la URL, el body ni el DOM", async () => {
    fetchMock.mockResolvedValue(httpResponse(201, CREATED));
    await renderAbsent();
    type("edwin390");
    submit();
    await act(async () => {});

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain(TOKEN);
    expect(init.body).not.toContain(TOKEN);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it("doble submit mientras está pendiente: una sola petición y estado pendiente", async () => {
    let resolveFetch!: (r: unknown) => void;
    fetchMock.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
    await renderAbsent();
    type("edwin390");
    submit();
    submit();
    submit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Creando perfil…" })).toBeDisabled();
    expect(screen.getByLabelText("Username")).toBeDisabled();

    await act(async () => resolveFetch(httpResponse(201, CREATED)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("201: pasa al perfil existente con lo que devolvió el servidor, sin recargar ni segundo SELECT", async () => {
    fetchMock.mockResolvedValue(httpResponse(201, CREATED));
    await renderAbsent();
    type("Edwin390");
    submit();

    expect(await screen.findByText("edwin390")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(sb.reads).toHaveLength(1);
  });

  it("201 con cuerpo inesperado: error genérico, sin pasar a perfil existente", async () => {
    fetchMock.mockResolvedValue(httpResponse(201, { algo: "raro" }));
    await renderAbsent();
    type("edwin390");
    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no se pudo crear tu perfil/i,
    );
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
  });

  const statuses: [number, RegExp][] = [
    [409, /este username no está disponible/i],
    [422, /^elige otro username\.$/i],
    [400, /no se pudo procesar la solicitud/i],
    [401, /tu sesión ya no es válida/i],
    [500, /no se pudo crear tu perfil/i],
    [503, /no se pudo crear tu perfil/i],
  ];

  it.each(statuses)(
    "%i muestra el mensaje público esperado y permite reintentar",
    async (status, message) => {
      fetchMock.mockResolvedValue(
        httpResponse(status, { error: "detalle-interno-servidor" }),
      );
      await renderAbsent();
      type("edwin390");
      submit();

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(document.body.innerHTML).not.toContain("detalle-interno-servidor");
      expect(screen.getByLabelText("Username")).toBeEnabled();
      expect(screen.getByRole("button", { name: "Crear perfil" })).toBeEnabled();
    },
  );

  it("422 no revela la lista de reservados ni el motivo", async () => {
    fetchMock.mockResolvedValue(httpResponse(422, { error: "Username no disponible" }));
    await renderAbsent();
    type("admin");
    submit();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Elige otro username.");
    expect(alert.textContent).not.toMatch(/reservad|mod|staff/i);
  });

  it("401 no cierra la sesión automáticamente (no inventa un segundo sistema auth)", async () => {
    fetchMock.mockResolvedValue(httpResponse(401, { error: "No autenticado" }));
    await renderAbsent();
    type("edwin390");
    submit();
    await screen.findByRole("alert");

    expect(sb.signOutCalls).toBe(0);
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeInTheDocument();
  });

  it("500 no cierra la sesión ni redirige", async () => {
    fetchMock.mockResolvedValue(httpResponse(500, { error: "Error interno" }));
    await renderAbsent();
    type("edwin390");
    submit();
    await screen.findByRole("alert");

    expect(sb.signOutCalls).toBe(0);
    expect(screen.queryByText("Login stub")).toBeNull();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
  });

  it("error de red (fetch rechaza): mensaje genérico recuperable, sin logout ni filtrar el error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET-10.0.0.7"));
    await renderAbsent();
    type("edwin390");
    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no se pudo crear tu perfil/i,
    );
    expect(document.body.innerHTML).not.toContain("ECONNRESET");
    expect(sb.signOutCalls).toBe(0);
    expect(screen.getByRole("button", { name: "Crear perfil" })).toBeEnabled();
  });

  it("tras un error se puede reenviar con éxito", async () => {
    fetchMock
      .mockResolvedValueOnce(httpResponse(409))
      .mockResolvedValueOnce(httpResponse(201, CREATED));
    await renderAbsent();
    type("edwin390");
    submit();
    await screen.findByRole("alert");

    type("edwin391");
    submit();
    expect(await screen.findByText("edwin390")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("respuestas asíncronas obsoletas", () => {
  it("cambio de usuario durante la lectura: la respuesta del usuario anterior se ignora", async () => {
    const resolvers: ((r: ReadResult) => void)[] = [];
    sb.readImpl = () => new Promise((resolve) => resolvers.push(resolve));
    const { rerender } = render(tree());
    expect(sb.reads[0].value).toBe(USER_ID);

    authFakes.session = fakeSession(OTHER_USER_ID);
    rerender(tree());
    expect(sb.reads[1].value).toBe(OTHER_USER_ID);

    await act(async () =>
      resolvers[1]({
        data: { username: "otro_usuario", display_name: null, bio: null },
        error: null,
      }),
    );
    // La lectura anterior termina DESPUÉS de la posterior y no debe pisarla.
    await act(async () => resolvers[0]({ data: null, error: null }));

    expect(screen.getByText("otro_usuario")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).toBeNull();
  });

  it("desmontar durante la lectura no produce errores ni actualiza estado", async () => {
    let resolveRead!: (r: ReadResult) => void;
    sb.readImpl = () => new Promise((resolve) => (resolveRead = resolve));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(tree());
    unmount();

    await act(async () => resolveRead({ data: null, error: null }));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("cambio de usuario durante el POST: la respuesta tardía no cambia la vista del nuevo usuario", async () => {
    let resolveFetch!: (r: unknown) => void;
    fetchMock.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
    const { rerender } = await renderAbsent();
    type("edwin390");
    submit();

    authFakes.session = fakeSession(OTHER_USER_ID);
    absent();
    rerender(tree());
    await screen.findByLabelText("Username");

    await act(async () => resolveFetch(httpResponse(201, CREATED)));
    expect(screen.queryByText("edwin390")).toBeNull();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
  });

  it("desmontar durante el POST no produce errores", async () => {
    let resolveFetch!: (r: unknown) => void;
    fetchMock.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = await renderAbsent();
    type("edwin390");
    submit();
    unmount();

    await act(async () => resolveFetch(httpResponse(201, CREATED)));
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("integración con la cuenta existente", () => {
  it("el logout existente sigue funcionando con perfil cargado", async () => {
    present();
    render(tree());
    await screen.findByText("fan_sintetico");

    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    await act(async () => {});
    expect(sb.signOutCalls).toBe(1);
  });

  it("la sesión sigue visible y separada del perfil público", async () => {
    present();
    render(tree());
    await screen.findByText("fan_sintetico");

    expect(screen.getByRole("status")).toHaveTextContent(
      "Sesión activa como fan@example.com.",
    );
    const section = screen.getByRole("region", { name: "Tu perfil público" });
    expect(section).not.toHaveTextContent("fan@example.com");
  });

  it("no muestra user_id, tokens, claims, rol ni email como parte del perfil", async () => {
    present({ display_name: "Fan" });
    render(tree());
    await screen.findByText("fan_sintetico");

    const html = document.body.innerHTML;
    expect(html).not.toContain(USER_ID);
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain("refresh-sintetico-de-prueba");
    expect(html).not.toContain("rol-sintetico");
    expect(html).not.toMatch(/admin|moderator|aal/i);
  });

  it("solo hace fetch a /api/profile (nunca /api/admin/me) y no crea listeners de auth", async () => {
    fetchMock.mockResolvedValue(httpResponse(201, CREATED));
    await renderAbsent();
    type("edwin390");
    submit();
    await act(async () => {});

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/profile"]);
    expect(sb.authStateListeners).toBe(0);
  });

  it("ninguna lectura toca admin_roles ni otras tablas", async () => {
    present();
    render(tree());
    await screen.findByText("fan_sintetico");
    expect(sb.reads.every((r) => r.table === "profiles")).toBe(true);
  });
});

describe("invariantes estructurales del código", () => {
  const source = readFileSync(
    resolve(__dirname, "../components/account/ProfileSection.tsx"),
    "utf8",
  );
  const code = source
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");

  it("no usa admin_roles, /api/admin/me, MFA/AAL2, otro AuthProvider ni otro listener", () => {
    expect(code).not.toMatch(/admin_roles|admin\/me|aal2|\bmfa\b/i);
    expect(code).not.toMatch(/AuthProvider|onAuthStateChange|getSession/);
  });

  it("no guarda el token en almacenamiento ni lo registra", () => {
    expect(code).not.toMatch(/localStorage|sessionStorage|console\./);
  });
});
