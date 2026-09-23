import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// Edición de perfil (display_name/bio) dentro de /account (Bloque 7D.3). useAuth y el
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

function present(overrides: Record<string, unknown> = {}) {
  sb.readImpl = async () => ({
    data: { username: "fan_sintetico", display_name: null, bio: null, ...overrides },
    error: null,
  });
}

function absent() {
  sb.readImpl = async () => ({ data: null, error: null });
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

const PATCHED = (over: Record<string, unknown> = {}) => ({
  profile: {
    username: "fan_sintetico",
    display_name: "Nuevo nombre",
    bio: "Nueva bio",
    avatar_path: null,
    created_at: "2026-09-23T00:00:00Z",
    updated_at: "2026-09-24T00:00:00Z",
    ...over,
  },
});

async function renderPresent(overrides: Record<string, unknown> = {}) {
  present(overrides);
  const utils = render(tree());
  await screen.findByRole("button", { name: "Editar perfil" });
  return utils;
}

async function enterEdit(overrides: Record<string, unknown> = {}) {
  const utils = await renderPresent(overrides);
  fireEvent.click(screen.getByRole("button", { name: "Editar perfil" }));
  return utils;
}

const nameField = () => screen.getByLabelText("Nombre visible") as HTMLInputElement;
const bioField = () => screen.getByLabelText("Bio") as HTMLTextAreaElement;
const saveButton = () => screen.getByRole("button", { name: /^Guardar|^Guardando/ });
const form = () => nameField().closest("form")!;

function setName(value: string) {
  fireEvent.change(nameField(), { target: { value } });
}
function setBio(value: string) {
  fireEvent.change(bioField(), { target: { value } });
}
function save() {
  fireEvent.submit(form());
}
function patchCalls() {
  return fetchMock.mock.calls.filter((c) => c[1]?.method === "PATCH");
}
function lastBody() {
  const calls = patchCalls();
  return JSON.parse(calls[calls.length - 1][1].body as string);
}

describe("vista", () => {
  it("perfil existente: identidad, botón Editar y sin campos de edición", async () => {
    await renderPresent({ display_name: "Fan Sintético", bio: "Bio de prueba" });
    expect(screen.getByText("Fan Sintético")).toBeInTheDocument();
    expect(screen.getByText("fan_sintetico")).toBeInTheDocument();
    expect(screen.getByText("Bio de prueba")).toBeInTheDocument();
    expect(screen.queryByLabelText("Nombre visible")).toBeNull();
    expect(screen.queryByLabelText("Bio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Guardar" })).toBeNull();
  });

  it("no muestra user_id, rol, admin, AAL, MFA ni token", async () => {
    await renderPresent({ display_name: "Fan" });
    const text = document.body.textContent ?? "";
    expect(text).not.toContain(USER_ID);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toMatch(/rol-sintetico|admin|AAL|MFA/i);
  });
});

describe("entrar en edición", () => {
  it("precarga display_name y bio, muestra username fijo y Guardar/Cancelar", async () => {
    await enterEdit({ display_name: "Fan", bio: "Línea 1\nLínea 2" });
    expect(nameField().value).toBe("Fan");
    expect(bioField().value).toBe("Línea 1\nLínea 2");
    expect(screen.getByText("fan_sintetico")).toBeInTheDocument();
    expect(screen.queryByLabelText(/username/i)).toBeNull();
    expect(screen.queryByDisplayValue("fan_sintetico")).toBeNull();
    expect(screen.getByRole("button", { name: "Guardar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
  });

  it("perfil sin valores: campos vacíos", async () => {
    await enterEdit();
    expect(nameField().value).toBe("");
    expect(bioField().value).toBe("");
  });

  it("el foco pasa al campo Nombre visible", async () => {
    await enterEdit();
    expect(document.activeElement).toBe(nameField());
  });
});

describe("cancelar", () => {
  it("descarta cambios, no hace request y vuelve a la vista con los valores originales", async () => {
    await enterEdit({ display_name: "Original", bio: "Bio original" });
    setName("Otro");
    setBio("Otra bio");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Nombre visible")).toBeNull();
    expect(screen.getByText("Original")).toBeInTheDocument();
    expect(screen.getByText("Bio original")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Editar perfil" }));
    expect(nameField().value).toBe("Original");
    expect(bioField().value).toBe("Bio original");
  });

  it("devuelve el foco al botón Editar perfil", async () => {
    await enterEdit();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Editar perfil" }),
    );
  });
});

describe("estado sucio", () => {
  it("sin cambios → Guardar deshabilitado y no se envía nada", async () => {
    await enterEdit({ display_name: "Edwin", bio: "A\nB" });
    expect(saveButton()).toBeDisabled();
    save();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("espacios exteriores semánticamente iguales → deshabilitado", async () => {
    await enterEdit({ display_name: "Edwin", bio: "Hola" });
    setName("  Edwin  ");
    setBio("\n Hola \n");
    expect(saveButton()).toBeDisabled();
  });

  it("null vs vacío / solo espacios → deshabilitado", async () => {
    await enterEdit();
    setName("   ");
    setBio(" \n ");
    expect(saveButton()).toBeDisabled();
  });

  it("CRLF vs LF semánticamente igual → deshabilitado", async () => {
    await enterEdit({ bio: "A\nB" });
    setBio("A\r\nB");
    expect(saveButton()).toBeDisabled();
    setBio("A\rB");
    expect(saveButton()).toBeDisabled();
  });

  it("cambiar solo display_name o solo bio → habilitado", async () => {
    await enterEdit({ display_name: "Edwin", bio: "Hola" });
    setName("Otro");
    expect(saveButton()).toBeEnabled();
    setName("Edwin");
    expect(saveButton()).toBeDisabled();
    setBio("Adiós");
    expect(saveButton()).toBeEnabled();
  });
});

describe("cuerpo del PATCH", () => {
  it("solo display_name cambiado → body solo display_name (normalizado)", async () => {
    fetchMock.mockResolvedValue(httpResponse(200, PATCHED()));
    await enterEdit({ display_name: "Viejo", bio: "Igual" });
    setName("  Nuevo nombre  ");
    save();
    await screen.findByRole("button", { name: "Editar perfil" });
    expect(patchCalls()).toHaveLength(1);
    expect(lastBody()).toEqual({ display_name: "Nuevo nombre" });
  });

  it("solo bio cambiada → body solo bio", async () => {
    fetchMock.mockResolvedValue(httpResponse(200, PATCHED()));
    await enterEdit({ display_name: "Igual", bio: "Vieja" });
    setBio("Nueva bio");
    save();
    await screen.findByRole("button", { name: "Editar perfil" });
    expect(lastBody()).toEqual({ bio: "Nueva bio" });
  });

  it("ambos cambiados → ambos", async () => {
    fetchMock.mockResolvedValue(httpResponse(200, PATCHED()));
    await enterEdit({ display_name: "A", bio: "B" });
    setName("C");
    setBio("D");
    save();
    await screen.findByRole("button", { name: "Editar perfil" });
    expect(lastBody()).toEqual({ display_name: "C", bio: "D" });
  });

  it("vaciar display_name → null; vaciar bio → null", async () => {
    fetchMock.mockResolvedValue(
      httpResponse(200, PATCHED({ display_name: null, bio: null })),
    );
    await enterEdit({ display_name: "A", bio: "B" });
    setName("   ");
    setBio("");
    save();
    await screen.findByRole("button", { name: "Editar perfil" });
    expect(lastBody()).toEqual({ display_name: null, bio: null });
  });

  it("la bio se envía con LF y NFC, y nunca campos ajenos", async () => {
    fetchMock.mockResolvedValue(httpResponse(200, PATCHED()));
    await enterEdit({ bio: "x" });
    setBio("L1\r\nL2");
    save();
    await screen.findByRole("button", { name: "Editar perfil" });
    const body = lastBody();
    expect(body).toEqual({ bio: "L1\nL2" });
    for (const key of [
      "username",
      "user_id",
      "avatar_path",
      "role",
      "email",
      "metadata",
    ]) {
      expect(body).not.toHaveProperty(key);
    }
  });
});

describe("autenticación", () => {
  it("usa el access_token existente, sin exponerlo ni tocar admin/MFA/localStorage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    fetchMock.mockResolvedValue(httpResponse(200, PATCHED()));
    await enterEdit({ display_name: "A" });
    setName("B");
    save();
    await screen.findByRole("button", { name: "Editar perfil" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/profile");
    expect(init.method).toBe("PATCH");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/admin"))).toBe(
      false,
    );
    expect(sb.authStateListeners).toBe(0); // ProfileSection no registra listeners
  });
});

describe("límites en code points", () => {
  const emoji = (n: number) => "😀".repeat(n);

  it("display_name: 40 permitido, 41 bloquea sin fetch y conserva lo escrito", async () => {
    await enterEdit();
    setName("a".repeat(40));
    expect(saveButton()).toBeEnabled();
    setName("a".repeat(41));
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("hasta 40 caracteres");
    save();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(nameField().value).toBe("a".repeat(41));
  });

  it("display_name con emoji: 40 emoji permitido (80 unidades UTF-16), 41 bloquea", async () => {
    await enterEdit();
    setName(emoji(40));
    expect(screen.getByText("40/40")).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
    setName(emoji(41));
    expect(saveButton()).toBeDisabled();
  });

  it("bio: 280 permitido, 281 bloquea sin fetch", async () => {
    await enterEdit();
    setBio("a".repeat(280));
    expect(saveButton()).toBeEnabled();
    setBio("a".repeat(281));
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("hasta 280 caracteres");
    save();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bioField().value).toBe("a".repeat(281));
  });

  it("bio con emoji: 280 emoji permitido, 281 bloquea", async () => {
    await enterEdit();
    setBio(emoji(280));
    expect(screen.getByText("280/280")).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
    setBio(emoji(281));
    expect(saveButton()).toBeDisabled();
  });

  it("los contadores muestran n/40 y n/280", async () => {
    await enterEdit({ display_name: "Ana", bio: "Hola" });
    expect(screen.getByText("3/40")).toBeInTheDocument();
    expect(screen.getByText("4/280")).toBeInTheDocument();
  });
});

describe("éxito", () => {
  it("un PATCH, usa response.profile, sin segundo SELECT, vuelve a la vista y enfoca Editar", async () => {
    fetchMock.mockResolvedValue(httpResponse(200, PATCHED()));
    await enterEdit({ display_name: "Viejo" });
    setName("Nuevo nombre");
    setBio("Nueva bio");
    save();

    expect(await screen.findByText("Nuevo nombre")).toBeInTheDocument();
    expect(screen.getByText("Nueva bio")).toBeInTheDocument();
    expect(screen.queryByLabelText("Nombre visible")).toBeNull();
    expect(patchCalls()).toHaveLength(1);
    expect(sb.reads).toHaveLength(1); // solo la lectura inicial
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Editar perfil" }),
      ),
    );
  });

  it("el username mostrado es el del servidor y no hay forma de editarlo", async () => {
    fetchMock.mockResolvedValue(
      httpResponse(200, PATCHED({ username: "fan_sintetico" })),
    );
    await enterEdit({ display_name: "A" });
    setName("B");
    save();
    await screen.findByText("Nuevo nombre");
    expect(screen.getByText("fan_sintetico")).toBeInTheDocument();
  });
});

describe("doble submit", () => {
  it("dos submits rápidos → un solo PATCH", async () => {
    let resolveFetch!: (r: unknown) => void;
    fetchMock.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
    await enterEdit({ display_name: "A" });
    setName("B");
    save();
    save();
    expect(patchCalls()).toHaveLength(1);
    expect(saveButton()).toBeDisabled();
    await act(async () => resolveFetch(httpResponse(200, PATCHED())));
    expect(patchCalls()).toHaveLength(1);
  });
});

describe("errores HTTP", () => {
  async function failWith(status: number, body: unknown = {}) {
    fetchMock.mockResolvedValue(httpResponse(status, body));
    await enterEdit({ display_name: "A", bio: "B" });
    setName("Escrito");
    setBio("Bio escrita");
    await act(async () => save());
  }

  function stillEditing() {
    expect(nameField().value).toBe("Escrito");
    expect(bioField().value).toBe("Bio escrita");
  }

  it("400 → mensaje, sigue en edición y conserva lo escrito", async () => {
    await failWith(400);
    expect(
      await screen.findByText("Los datos enviados no son válidos."),
    ).toBeInTheDocument();
    stillEditing();
  });

  it("401 → mensaje de sesión, sin logout automático", async () => {
    await failWith(401);
    expect(
      await screen.findByText(
        "Tu sesión ya no es válida. Cierra sesión e inicia de nuevo.",
      ),
    ).toBeInTheDocument();
    expect(sb.signOutCalls).toBe(0);
    stillEditing();
  });

  it("422 → mensaje de revisión", async () => {
    await failWith(422);
    expect(
      await screen.findByText("Revisa el nombre visible y la bio."),
    ).toBeInTheDocument();
    stillEditing();
  });

  it.each([500, 503, 418])("%s → mensaje genérico", async (status) => {
    await failWith(status);
    expect(
      await screen.findByText("No se pudo guardar tu perfil. Inténtalo de nuevo."),
    ).toBeInTheDocument();
    stillEditing();
  });

  it("error de red → mensaje genérico y conserva lo escrito", async () => {
    fetchMock.mockRejectedValue(new Error("red caída"));
    await enterEdit({ display_name: "A", bio: "B" });
    setName("Escrito");
    setBio("Bio escrita");
    save();
    expect(
      await screen.findByText("No se pudo guardar tu perfil. Inténtalo de nuevo."),
    ).toBeInTheDocument();
    stillEditing();
  });

  it("200 con cuerpo inválido → mensaje genérico, sigue en edición", async () => {
    for (const bad of [
      {},
      { profile: null },
      { profile: { username: "" } },
      { profile: 5 },
    ]) {
      cleanup();
      fetchMock.mockReset();
      await failWith(200, bad);
      expect(
        await screen.findByText("No se pudo guardar tu perfil. Inténtalo de nuevo."),
      ).toBeInTheDocument();
      stillEditing();
    }
  });

  it("200 con JSON ilegible → mensaje genérico", async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      json: async () => {
        throw new Error("no json");
      },
    });
    await enterEdit({ display_name: "A" });
    setName("Escrito");
    save();
    expect(
      await screen.findByText("No se pudo guardar tu perfil. Inténtalo de nuevo."),
    ).toBeInTheDocument();
  });

  it("tras un error se puede reintentar", async () => {
    fetchMock.mockResolvedValueOnce(httpResponse(500));
    fetchMock.mockResolvedValueOnce(httpResponse(200, PATCHED()));
    await enterEdit({ display_name: "A" });
    setName("Nuevo nombre");
    save();
    await screen.findByText("No se pudo guardar tu perfil. Inténtalo de nuevo.");
    save();
    expect(
      await screen.findByRole("button", { name: "Editar perfil" }),
    ).toBeInTheDocument();
    expect(patchCalls()).toHaveLength(2);
  });
});

describe("404: perfil desaparecido", () => {
  it("sale de edición, vuelve a comprobar y cae al onboarding si ya no existe", async () => {
    fetchMock.mockResolvedValue(httpResponse(404, { error: "Perfil no encontrado" }));
    await enterEdit({ display_name: "A" });
    setName("B");
    absent(); // la relectura ya no encuentra el perfil
    save();

    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    expect(sb.reads).toHaveLength(2);
    expect(screen.queryByLabelText("Nombre visible")).toBeNull();
    // Nunca se crea desde PATCH: solo hubo un PATCH y ningún POST.
    expect(fetchMock.mock.calls.every((c) => c[1]?.method === "PATCH")).toBe(true);
  });

  it("si la relectura sí encuentra el perfil, vuelve a la vista", async () => {
    fetchMock.mockResolvedValue(httpResponse(404, {}));
    await enterEdit({ display_name: "A" });
    setName("B");
    save();
    expect(
      await screen.findByRole("button", { name: "Editar perfil" }),
    ).toBeInTheDocument();
    expect(sb.reads).toHaveLength(2);
    expect(screen.queryByLabelText("Nombre visible")).toBeNull();
  });
});

describe("carreras", () => {
  it("desmontar antes de la respuesta → no se aplica nada ni hay lecturas extra", async () => {
    let resolveFetch!: (r: unknown) => void;
    fetchMock.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
    const { unmount } = await enterEdit({ display_name: "A" });
    setName("B");
    save();
    unmount();
    await act(async () => resolveFetch(httpResponse(200, PATCHED())));
    expect(sb.reads).toHaveLength(1);
    expect(patchCalls()).toHaveLength(1);
  });

  it("cambio de userId antes de la respuesta → la respuesta no se aplica", async () => {
    let resolveFetch!: (r: unknown) => void;
    fetchMock.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
    const { rerender } = await enterEdit({ display_name: "A" });
    setName("B");
    save();

    authFakes.session = fakeSession(OTHER_USER_ID);
    rerender(tree());
    await screen.findByRole("button", { name: "Editar perfil" });

    await act(async () =>
      resolveFetch(httpResponse(200, PATCHED({ display_name: "Ajeno" }))),
    );
    expect(screen.queryByText("Ajeno")).toBeNull();
    expect(screen.queryByText("Nuevo nombre")).toBeNull();
    expect(screen.getByText("fan_sintetico")).toBeInTheDocument();
  });

  it("cambio de userId antes de un 404 → no dispara relectura extra", async () => {
    let resolveFetch!: (r: unknown) => void;
    fetchMock.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
    const { rerender } = await enterEdit({ display_name: "A" });
    setName("B");
    save();
    authFakes.session = fakeSession(OTHER_USER_ID);
    rerender(tree());
    await screen.findByRole("button", { name: "Editar perfil" });
    const reads = sb.reads.length;
    await act(async () => resolveFetch(httpResponse(404, {})));
    expect(sb.reads).toHaveLength(reads);
  });
});

const TOKEN_B = "token-sintetico-de-prueba-b";

/** Lecturas por cuenta: A y B tienen perfiles distintos (o ninguno). */
function profilesByUser(map: Record<string, Record<string, unknown> | null>) {
  sb.readImpl = async () => {
    const userId = String(sb.reads[sb.reads.length - 1].value);
    return { data: map[userId] ?? null, error: null };
  };
}

function switchToB(rerender: (ui: React.ReactElement) => void) {
  authFakes.session = { ...fakeSession(OTHER_USER_ID), access_token: TOKEN_B };
  rerender(tree());
}

describe("cambio de cuenta A → B (ProfileSection key={userId})", () => {
  const PROFILE_A = { username: "fan_a", display_name: "Nombre A", bio: "Bio A" };
  const PROFILE_B = { username: "fan_b", display_name: "Nombre B", bio: "Bio B" };

  it("durante la edición: el borrador y el modo edit de A desaparecen y se muestra B", async () => {
    profilesByUser({ [USER_ID]: PROFILE_A, [OTHER_USER_ID]: PROFILE_B });
    const { rerender } = render(tree());
    fireEvent.click(await screen.findByRole("button", { name: "Editar perfil" }));
    setName("Borrador de A");
    setBio("Bio borrador de A");

    switchToB(rerender);

    expect(await screen.findByText("Nombre B")).toBeInTheDocument();
    expect(screen.queryByLabelText("Nombre visible")).toBeNull();
    expect(screen.queryByLabelText("Bio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Guardar" })).toBeNull();
    expect(screen.queryByDisplayValue("Borrador de A")).toBeNull();
    expect(document.body.textContent).not.toContain("Borrador de A");
    expect(document.body.textContent).not.toContain("Nombre A");
    expect(screen.getByText("fan_b")).toBeInTheDocument();
    expect(screen.getByText("Bio B")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Editar perfil" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sb.reads.map((r) => r.value)).toEqual([USER_ID, OTHER_USER_ID]);

    // Editar de nuevo con B parte del perfil de B, nunca del borrador de A.
    fireEvent.click(screen.getByRole("button", { name: "Editar perfil" }));
    expect(nameField().value).toBe("Nombre B");
    expect(bioField().value).toBe("Bio B");
  });

  it("durante el onboarding: el username y el error de A desaparecen y B parte limpio", async () => {
    profilesByUser({});
    fetchMock.mockResolvedValueOnce(httpResponse(409, {}));
    const { rerender } = render(tree());
    const field = (await screen.findByLabelText("Username")) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "usuario_a" } });
    fireEvent.submit(field.closest("form")!);
    expect(
      await screen.findByText("Este username no está disponible."),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "borrador_a" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    switchToB(rerender);
    await waitFor(() => expect(sb.reads).toHaveLength(2));
    const fieldB = (await screen.findByLabelText("Username")) as HTMLInputElement;
    expect(fieldB.value).toBe("");
    expect(screen.queryByDisplayValue("borrador_a")).toBeNull();
    expect(screen.queryByText("Este username no está disponible.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // B crea su propio perfil: solo su username y solo su token.
    fetchMock.mockResolvedValueOnce(
      httpResponse(
        201,
        PATCHED({ username: "usuario_b", display_name: null, bio: null }),
      ),
    );
    fireEvent.change(fieldB, { target: { value: "usuario_b" } });
    fireEvent.submit(fieldB.closest("form")!);
    await screen.findByText("usuario_b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1];
    expect(JSON.parse(init.body as string)).toEqual({ username: "usuario_b" });
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN_B}`);
    expect(JSON.stringify(fetchMock.mock.calls[1])).not.toContain("usuario_a");
    expect(JSON.stringify(fetchMock.mock.calls[1])).not.toContain("borrador_a");
  });

  it("PATCH de A en vuelo: la respuesta tardía (200) no toca la UI de B ni relee", async () => {
    profilesByUser({ [USER_ID]: PROFILE_A, [OTHER_USER_ID]: PROFILE_B });
    let resolveFetch!: (r: unknown) => void;
    fetchMock.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
    const { rerender } = render(tree());
    fireEvent.click(await screen.findByRole("button", { name: "Editar perfil" }));
    setName("Cambio de A");
    save();
    expect(patchCalls()).toHaveLength(1);

    switchToB(rerender);
    await screen.findByText("Nombre B");
    const reads = sb.reads.length;

    await act(async () =>
      resolveFetch(
        httpResponse(200, PATCHED({ username: "fan_a", display_name: "Cambio de A" })),
      ),
    );
    expect(screen.queryByText("Cambio de A")).toBeNull();
    expect(screen.getByText("Nombre B")).toBeInTheDocument();
    expect(screen.getByText("fan_b")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(sb.reads).toHaveLength(reads);
    expect(patchCalls()).toHaveLength(1);
  });

  it.each([
    ["500", () => httpResponse(500, { error: "Error interno" })],
    ["422", () => httpResponse(422, { error: "Display name inválido" })],
    ["red caída", () => Promise.reject(new Error("ECONNRESET"))],
  ])(
    "PATCH de A en vuelo: el error tardío (%s) no aparece en la UI de B",
    async (_l, late) => {
      profilesByUser({ [USER_ID]: PROFILE_A, [OTHER_USER_ID]: PROFILE_B });
      let settle!: () => void;
      fetchMock.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            settle = () => Promise.resolve(late()).then(resolve, reject);
          }),
      );
      const { rerender } = render(tree());
      fireEvent.click(await screen.findByRole("button", { name: "Editar perfil" }));
      setName("Cambio de A");
      save();

      switchToB(rerender);
      await screen.findByText("Nombre B");
      const reads = sb.reads.length;

      await act(async () => settle());
      expect(screen.queryByRole("alert")).toBeNull();
      expect(document.body.textContent).not.toMatch(
        /No se pudo guardar|Revisa el nombre/,
      );
      expect(screen.getByText("Nombre B")).toBeInTheDocument();
      expect(sb.reads).toHaveLength(reads);
      expect(patchCalls()).toHaveLength(1);
    },
  );
});

describe("aviso de información pública", () => {
  it("en edición se muestra el aviso, como texto normal y no como alerta", async () => {
    await enterEdit({ display_name: "Fan" });
    const notice = screen.getByText("Tu nombre visible y tu bio serán públicos.");
    expect(notice).toBeInTheDocument();
    expect(notice.closest("form")).toBe(form());
    expect(notice.getAttribute("role")).toBeNull();
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("no aparece en la vista ni afirma que el email o la cuenta sean públicos", async () => {
    await renderPresent({ display_name: "Fan" });
    expect(screen.queryByText(/serán públicos/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Editar perfil" }));
    const text = form().textContent ?? "";
    expect(text).not.toMatch(/email|correo|cuenta/i);
    expect(text).toContain("el username no se puede cambiar");
  });
});

describe("XSS", () => {
  it("bio con HTML se muestra como texto, sin crear elementos", async () => {
    const html = "<script>alert(1)</script><img src=x onerror=alert(1)>";
    await renderPresent({ bio: html });
    expect(screen.getByText(html)).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  it("tras guardar una bio con HTML, sigue siendo texto", async () => {
    const html = "<b onmouseover=alert(1)>x</b>";
    fetchMock.mockResolvedValue(httpResponse(200, PATCHED({ bio: html })));
    await enterEdit({ bio: "a" });
    setBio(html);
    save();
    await screen.findByRole("button", { name: "Editar perfil" });
    expect(screen.getByText(html)).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
  });

  it("la fuente no usa dangerouslySetInnerHTML", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/components/account/ProfileSection.tsx"),
      "utf8",
    );
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });
});
