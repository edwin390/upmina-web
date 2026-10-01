import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  act,
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import CosplayLocaleProvider from "@/i18n/LocaleProvider";
import type { CosplayPostListPage } from "@/types";
import CosplaySection from "./CosplaySection";
import ActionNotice from "@/components/ActionNotice";
import * as actionNotice from "@/lib/action-notice";

// Menú ADMIN contextual por tarjeta de Cosplay en /cosplay (ajuste UX posterior a 9I-3: reemplaza
// el panel "Tus publicaciones" — ver CLAUDE.md). El backend sigue siendo la única autoridad real
// (cada mutación revalida cosplay_admin + MFA reciente, ver cosplay-editor-handlers.ts) — aquí
// solo se prueba que la UI: (a) no muestra NADA privilegiado sin la capacidad, (b) sí lo muestra
// con ella, en CADA tarjeta, (c) Editar/Eliminar apuntan siempre a la publicación exacta cuyo
// menú se abrió, (d) el borrado exige confirmación explícita y nunca se reproduce solo por volver
// de un step-up de MFA, y (e) el catálogo público (con el menú incluido) nunca exige MFA reciente
// solo para renderizarse — solo pulsar "Eliminar" cruza esa frontera (necesita la versión ACTUAL
// del post, que getCosplayPostAdmin también protege con MFA reciente en el servidor).

const authFakes = vi.hoisted(() => ({
  session: null as { access_token: string; user: { id: string } } | null,
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: authFakes.session,
    user: authFakes.session?.user ?? null,
    loading: false,
    signOut: vi.fn(),
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

const EMPTY_LIST_PAGE: CosplayPostListPage = { items: [], nextCursor: null };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const image = (id: string) => ({
  id,
  url: `https://example.test/${id}.webp`,
  width: 1600,
  height: 2400,
  position: 0,
  isCover: true,
  decorative: false,
  alt: `Alt ${id}`,
  caption: null,
});

function post(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `post-${id}`,
    slug: `post-${id}`,
    title: `Publicación ${id}`,
    characterName: null,
    series: null,
    event: null,
    shotOn: null,
    publishedAt: "2026-03-01T00:00:00.000Z",
    cover: image(id),
    photoCount: 1,
    ...overrides,
  };
}

function adminDetailFor(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `post-${id}`,
    slug: `post-${id}`,
    status: "published",
    title: `Publicación ${id}`,
    description: null,
    characterName: null,
    series: null,
    event: null,
    shotOn: null,
    photographerCredit: null,
    version: 3,
    publishedAt: "2026-03-01T00:00:00.000Z",
    images: [],
    ...overrides,
  };
}

function routeFetch(
  opts: {
    mfaRecent?: boolean;
    posts?: CosplayPostListPage;
    /** Respuesta de GET /api/admin/cosplay-post-get-admin (necesaria para leer la versión ANTES
     *  de mostrar la confirmación de borrado — ver CosplayCardAdminMenu). */
    adminDetail?: { status: number; body: unknown };
    /** Respuesta de POST /api/admin/cosplay-post-delete. */
    deleteResult?: { status: number; body: unknown };
    /** Respuesta de POST /api/admin/cosplay-post-save (éxito por defecto, publicado). */
    saveResult?: { status: number; body: unknown };
    listAfterPublish?: CosplayPostListPage;
    drafts?: { id: string; title: string; updatedAt: string }[];
  } = {},
) {
  return vi.fn(async (url: string, init?: { method?: string }) => {
    if (url.startsWith("/api/content/cosplay-list")) {
      if (url.includes("_r=") && opts.listAfterPublish) {
        return jsonResponse(opts.listAfterPublish);
      }
      return jsonResponse(opts.posts ?? EMPTY_LIST_PAGE);
    }
    if (url === "/api/admin/access") {
      return jsonResponse({
        role: "admin",
        capabilities: ["cosplay_admin"],
        mfa: { recent: opts.mfaRecent ?? true },
      });
    }
    if (url.startsWith("/api/admin/cosplay-post-list-admin"))
      return jsonResponse({ items: opts.drafts ?? [] });
    if (url.startsWith("/api/admin/cosplay-post-get-admin")) {
      const result = opts.adminDetail ?? { status: 200, body: adminDetailFor("1") };
      return jsonResponse(result.body, result.status);
    }
    if (url === "/api/admin/cosplay-post-delete" && init?.method === "POST") {
      const result = opts.deleteResult ?? {
        status: 200,
        body: { postId: "post-1", deletedAssets: [], allCleaned: true },
      };
      return jsonResponse(result.body, result.status);
    }
    if (url === "/api/admin/cosplay-post-save" && init?.method === "POST") {
      const result = opts.saveResult ?? {
        status: 200,
        body: {
          post: {
            id: "post-new",
            slug: "kirito-de-prueba",
            status: "published",
            title: "Kirito de prueba",
            description: null,
            characterName: null,
            series: null,
            event: null,
            shotOn: null,
            photographerCredit: null,
            version: 1,
            publishedAt: "2026-01-01T00:00:00.000Z",
          },
          images: [],
        },
      };
      return jsonResponse(result.body, result.status);
    }
    throw new Error(`fetch inesperado a ${url}`);
  });
}

function MfaProbe() {
  const location = useLocation();
  return <p data-testid="mfa">{location.pathname + location.search}</p>;
}

function renderSection(initialEntries = ["/cosplay"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ActionNotice />
      <MemoryRouter initialEntries={initialEntries}>
        <CosplayLocaleProvider>
          <Routes>
            <Route path="/cosplay" element={<CosplaySection />} />
            <Route path="/admin/mfa" element={<MfaProbe />} />
          </Routes>
        </CosplayLocaleProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  // <dialog>.showModal(): jsdom no lo implementa, igual que CosplayDetail.test.tsx/InstagramSection.test.tsx.
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
  };
});

beforeEach(() => {
  window.localStorage.setItem("upmina:locale", "es");
  authFakes.session = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("USER/sin sesión — cero UI privilegiada (test 1)", () => {
  it("sin sesión: cero menús ADMIN en las tarjetas, cero 'Nueva publicación', nunca se pide /api/admin/access", async () => {
    const fetchMock = routeFetch({
      posts: { items: [post("1"), post("2")], nextCursor: null },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    await waitFor(() => expect(screen.getByText("Publicación 1")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /nueva publicación/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /más acciones/i })).toBeNull();
    expect(screen.queryByText(/^editar$/i)).toBeNull();
    expect(screen.queryByText(/^eliminar$/i)).toBeNull();
    expect(fetchMock.mock.calls.some((c) => c[0] === "/api/admin/access")).toBe(false);
  });
});

describe("borradores reanudables", () => {
  it("Abriendo cubre acceso y Buscando borradores cubre una segunda promise independiente", async () => {
    authFakes.session = { access_token: "jwt-admin", user: { id: "admin" } };
    const base = routeFetch();
    let resolveAccess!: (value: Response) => void;
    let resolveDrafts!: (value: Response) => void;
    let waitAccess = false;
    const fetchMock = vi.fn((url: string, init?: { method?: string }) => {
      if (url === "/api/admin/access" && waitAccess)
        return new Promise<Response>((done) => {
          resolveAccess = done;
        });
      if (url.includes("scope=own-drafts"))
        return new Promise<Response>((done) => {
          resolveDrafts = done;
        });
      return base(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection();
    const button = await screen.findByRole("button", { name: "Nueva publicación" });
    expect(button).toBeEnabled();
    const labelLayout = button.querySelector(".grid");
    expect(labelLayout).toBeInTheDocument();
    expect(labelLayout?.querySelectorAll("[aria-hidden='true'].invisible")).toHaveLength(
      2,
    );
    const idleClasses = button.className;
    waitAccess = true;
    const before = fetchMock.mock.calls.filter(
      ([url]) => url === "/api/admin/access",
    ).length;
    fireEvent.click(button);
    expect(button).toHaveTextContent("Abriendo…");
    expect(button).toHaveAccessibleName("Abriendo…");
    expect(button.className).toBe(idleClasses);
    expect(button.querySelector(".grid")).toBe(labelLayout);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => url === "/api/admin/access"),
      ).toHaveLength(before + 1),
    );
    expect(screen.queryByText("Buscando borradores…")).toBeNull();
    await act(async () =>
      resolveAccess(
        jsonResponse({
          role: "admin",
          capabilities: ["cosplay_admin"],
          mfa: { recent: true },
        }),
      ),
    );
    expect(await screen.findByText("Buscando borradores…")).toBeInTheDocument();
    expect(button).toHaveTextContent("Nueva publicación");
    expect(button).toBeEnabled();
    await act(async () => resolveDrafts(jsonResponse({ items: [] })));
    expect(await screen.findByLabelText("Título")).toHaveValue("");
  });
  it("MFA vencido durante save conserva el editor inline sin falso éxito ni autosave/retry", async () => {
    const notice = vi.spyOn(actionNotice, "showActionSuccess");
    authFakes.session = { access_token: "jwt-admin", user: { id: "admin" } };
    const fetchMock = routeFetch({
      saveResult: {
        status: 403,
        body: { error: "No autorizado", code: "step_up_required" },
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Nueva publicación" }));
    fireEvent.change(await screen.findByLabelText("Título"), {
      target: { value: "Trabajo sin guardar" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    expect(
      await screen.findByRole("region", { name: "Verificar identidad" }),
    ).toBeVisible();
    expect(screen.queryByTestId("mfa")).toBeNull();
    expect(screen.getByLabelText("Título")).toHaveValue("Trabajo sin guardar");
    fireEvent.click(screen.getByRole("button", { name: "Volver al editor" }));
    expect(screen.getByLabelText("Título")).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/admin/cosplay-post-save"),
    ).toHaveLength(1);
    expect(notice).not.toHaveBeenCalled();
  });
  const ownDraft = {
    id: "draft-1",
    title: "Progreso guardado",
    updatedAt: "2026-09-30T12:00:00Z",
  };
  function asAdmin() {
    authFakes.session = { access_token: "jwt-admin", user: { id: "admin" } };
  }
  it("cero drafts abre un editor vacío", async () => {
    asAdmin();
    vi.stubGlobal("fetch", routeFetch());
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Nueva publicación" }));
    expect(
      await screen.findByRole("dialog", { name: "Nueva publicación de Cosplay" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Título")).toHaveValue("");
  });

  it.each([false, true])(
    "un draft permite elegir resume=%s sin selección automática",
    async (resume) => {
      asAdmin();
      const fetchMock = routeFetch({
        drafts: [ownDraft],
        adminDetail: {
          status: 200,
          body: adminDetailFor("draft", {
            id: ownDraft.id,
            status: "draft",
            title: ownDraft.title,
          }),
        },
      });
      vi.stubGlobal("fetch", fetchMock);
      renderSection();
      fireEvent.click(await screen.findByRole("button", { name: "Nueva publicación" }));
      const choice = await screen.findByRole("button", {
        name: /Progreso guardado.*Continuar borrador/,
      });
      expect(
        fetchMock.mock.calls.some(([url]) => url.includes("cosplay-post-get-admin")),
      ).toBe(false);
      fireEvent.click(
        resume ? choice : screen.getByRole("button", { name: "Crear nueva publicación" }),
      );
      await screen.findByLabelText("Título");
      await waitFor(() =>
        expect(screen.getByLabelText("Título")).toHaveValue(resume ? ownDraft.title : ""),
      );
      if (resume)
        expect(
          fetchMock.mock.calls.some(
            ([url]) =>
              url.includes(`postId=${ownDraft.id}`) && url.includes("scope=own-draft"),
          ),
        ).toBe(true);
      expect(
        fetchMock.mock.calls.some(([url]) => url.includes("cosplay-post-delete")),
      ).toBe(false);
    },
  );

  it("múltiples drafts muestran selección y cargan el elegido", async () => {
    asAdmin();
    const second = { ...ownDraft, id: "draft-2", title: "Segundo progreso" };
    const fetchMock = routeFetch({
      drafts: [ownDraft, second],
      adminDetail: {
        status: 200,
        body: adminDetailFor("2", {
          id: second.id,
          status: "draft",
          title: second.title,
        }),
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Nueva publicación" }));
    const selected = await screen.findByRole("button", {
      name: /Segundo progreso.*Continuar borrador/,
    });
    expect(
      screen.getByRole("button", { name: /Progreso guardado.*Continuar borrador/ }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => url.includes("cosplay-post-get-admin")),
    ).toBe(false);
    fireEvent.click(selected);
    await waitFor(() =>
      expect(screen.getByLabelText("Título")).toHaveValue(second.title),
    );
    expect(fetchMock.mock.calls.some(([url]) => url.includes("postId=draft-2"))).toBe(
      true,
    );
  });

  it("guardar → desmontar → nueva entrada descubre el draft y conserva el ID al reanudar", async () => {
    asAdmin();
    const drafts: (typeof ownDraft)[] = [];
    const detail = adminDetailFor("draft", {
      id: ownDraft.id,
      status: "draft",
      title: ownDraft.title,
    });
    const base = routeFetch({
      drafts,
      adminDetail: { status: 200, body: detail },
      saveResult: { status: 200, body: { post: detail, images: [] } },
    });
    const fetchMock = vi.fn(
      async (url: string, init?: { method?: string; body?: string }) => {
        if (url === "/api/admin/cosplay-post-save" && init?.method === "POST")
          drafts.splice(0, drafts.length, ownDraft);
        return base(url, init);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const first = renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Nueva publicación" }));
    fireEvent.change(await screen.findByLabelText("Título"), {
      target: { value: ownDraft.title },
    });
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    await screen.findByText("Borrador guardado correctamente");
    await waitFor(() => expect(screen.queryByLabelText("Título")).toBeNull());
    await waitFor(() => expect(drafts).toHaveLength(1));
    first.unmount();
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Nueva publicación" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Progreso guardado.*Continuar borrador/,
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Título")).toHaveValue(ownDraft.title),
    );
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([url]) => url === "/api/admin/cosplay-post-save",
      );
      expect(calls).toHaveLength(2);
      expect(JSON.parse(calls[1]![1]!.body!)).toMatchObject({ postId: ownDraft.id });
    });
  });
});

describe("ADMIN (cosplay_admin + MFA reciente) — menú contextual por tarjeta", () => {
  beforeEach(() => {
    authFakes.session = { access_token: "at-admin", user: { id: "admin-1" } };
  });

  it("test 2: cada tarjeta pública muestra su propio menú ADMIN '⋯'", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({ posts: { items: [post("1"), post("2")], nextCursor: null } }),
    );
    renderSection();

    await screen.findByText("Publicación 1");
    expect(
      await screen.findByRole("button", { name: /más acciones para publicación 1/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /más acciones para publicación 2/i }),
    ).toBeInTheDocument();
  });

  it("pulido de posicionamiento: el trigger ADMIN y la insignia de recuento de fotos no se solapan (la insignia baja SOLO para ADMIN, nunca para USER)", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        posts: {
          items: [post("1"), post("2", { photoCount: 3 })],
          nextCursor: null,
        },
      }),
    );
    renderSection();

    await screen.findByText("Publicación 2");
    await screen.findByRole("button", { name: /más acciones para publicación 2/i });
    // Insignia "3 fotos" desplazada por debajo del trigger (top-12), no en la misma esquina.
    expect(screen.getByText("3 fotos")).toHaveClass("top-12");
    expect(screen.getByText("3 fotos")).not.toHaveClass("top-2");
  });

  it("test 7: renderizar el catálogo (incluido el menú ADMIN de cada tarjeta) NUNCA exige MFA reciente — no llama a ningún endpoint que la revalide", async () => {
    const fetchMock = routeFetch({
      mfaRecent: false,
      posts: { items: [post("1"), post("2")], nextCursor: null },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    await screen.findByText("Publicación 1");
    await screen.findByRole("button", { name: /más acciones para publicación 1/i });
    // Ni abrir el menú en sí ni ver el catálogo llamó a un endpoint privilegiado más allá de
    // /api/admin/access (que solo informa capacidad, nunca exige MFA reciente por sí mismo).
    expect(
      fetchMock.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          c[0].startsWith("/api/admin/cosplay-post-get-admin"),
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some((c) => c[0] === "/api/admin/cosplay-post-delete"),
    ).toBe(false);
  });

  it("test 8: el panel 'Tus publicaciones' ya no existe en absoluto", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({ posts: { items: [post("1")], nextCursor: null } }),
    );
    renderSection();

    await screen.findByText("Publicación 1");
    expect(screen.queryByRole("heading", { name: /tus publicaciones/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^tus publicaciones$/i })).toBeNull();
  });

  it("test 9: el mensaje obsoleto 'No se pudieron cargar tus publicaciones.' ya no puede aparecer (la lista aparte ya no existe)", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({ posts: { items: [post("1")], nextCursor: null } }),
    );
    renderSection();

    await screen.findByText("Publicación 1");
    expect(screen.queryByText(/no se pudieron cargar tus publicaciones/i)).toBeNull();
  });

  it("test 3: 'Editar' desde el menú de una tarjeta abre el editor cargando ESA publicación exacta, no otra", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        posts: { items: [post("1"), post("2")], nextCursor: null },
        adminDetail: {
          status: 200,
          body: adminDetailFor("2", { title: "Publicación 2 (cargada del servidor)" }),
        },
      }),
    );
    renderSection();

    await screen.findByText("Publicación 2");
    fireEvent.click(
      await screen.findByRole("button", { name: /más acciones para publicación 2/i }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /^editar$/i }));

    await screen.findByRole("heading", { name: /editar publicación de cosplay/i });
    await waitFor(() =>
      expect(screen.getByLabelText(/título/i, { selector: "input" })).toHaveValue(
        "Publicación 2 (cargada del servidor)",
      ),
    );
  });

  it("test 4 + 5: 'Eliminar' pide confirmación explícita, y solo al confirmar envía el DELETE con el postId/versión EXACTOS de esa tarjeta", async () => {
    const fetchMock = routeFetch({
      posts: { items: [post("1"), post("2")], nextCursor: null },
      adminDetail: { status: 200, body: adminDetailFor("2", { version: 7 }) },
      deleteResult: {
        status: 200,
        body: { postId: "post-2", deletedAssets: [], allCleaned: true },
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    await screen.findByText("Publicación 2");
    fireEvent.click(
      await screen.findByRole("button", { name: /más acciones para publicación 2/i }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /^eliminar$/i }));

    // Confirmación explícita: el DELETE NUNCA se dispara solo por pulsar "Eliminar" en el menú.
    const confirmGroup = await screen.findByRole("group", {
      name: /eliminar esta publicación/i,
    });
    expect(
      fetchMock.mock.calls.some((c) => c[0] === "/api/admin/cosplay-post-delete"),
    ).toBe(false);

    fireEvent.click(
      within(confirmGroup).getByRole("button", { name: /confirmar eliminación/i }),
    );

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => c[0] === "/api/admin/cosplay-post-delete"),
      ).toBe(true),
    );
    const deleteCall = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/admin/cosplay-post-delete",
    );
    const body = JSON.parse((deleteCall?.[1] as { body: string }).body);
    expect(body).toEqual({ postId: "post-2", expectedVersion: 7 });
    expect(
      await screen.findByText("Publicación eliminada correctamente"),
    ).toBeInTheDocument();
  });

  it("failed published deletion keeps confirmation usable and shows one error, no success", async () => {
    const notice = vi.spyOn(actionNotice, "showActionSuccess");
    vi.stubGlobal(
      "fetch",
      routeFetch({
        posts: { items: [post("1")], nextCursor: null },
        deleteResult: { status: 500, body: { error: "error" } },
      }),
    );
    renderSection();
    fireEvent.click(
      await screen.findByRole("button", { name: /más acciones para publicación 1/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Eliminar" }));
    const group = await screen.findByRole("group", {
      name: /eliminar esta publicación/i,
    });
    fireEvent.click(within(group).getByRole("button", { name: "Confirmar eliminación" }));
    expect(await within(group).findByRole("alert")).toHaveTextContent(
      "No se pudo eliminar la publicación",
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(within(group).getByRole("button", { name: "Cancelar" })).toBeEnabled();
    expect(notice).not.toHaveBeenCalled();
  });

  it("'Cancelar' en la confirmación de borrado no envía nada", async () => {
    const fetchMock = routeFetch({
      posts: { items: [post("1")], nextCursor: null },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    await screen.findByText("Publicación 1");
    fireEvent.click(
      await screen.findByRole("button", { name: /más acciones para publicación 1/i }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /^eliminar$/i }));
    await screen.findByRole("group", { name: /eliminar esta publicación/i });

    fireEvent.click(screen.getByRole("button", { name: /^cancelar$/i }));
    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: /eliminar esta publicación/i }),
      ).toBeNull(),
    );
    expect(
      fetchMock.mock.calls.some((c) => c[0] === "/api/admin/cosplay-post-delete"),
    ).toBe(false);
  });
});

describe("endurecimiento global de MFA (9G/9I) — entrada a Cosplay desde el menú de tarjeta", () => {
  beforeEach(() => {
    authFakes.session = { access_token: "at-admin", user: { id: "admin-1" } };
  });

  it("MFA vencido: 'Editar' NUNCA abre el editor — navega a /admin/mfa?returnTo=/cosplay?intent=edit", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        mfaRecent: false,
        posts: { items: [post("1")], nextCursor: null },
      }),
    );
    renderSection();

    fireEvent.click(
      await screen.findByRole("button", { name: /más acciones para publicación 1/i }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /^editar$/i }));

    expect(await screen.findByTestId("mfa")).toHaveTextContent(
      "/admin/mfa?returnTo=%2Fcosplay%3Fintent%3Dedit",
    );
    expect(
      screen.queryByRole("heading", { name: /editar publicación de cosplay/i }),
    ).toBeNull();
  });

  it("test 6: MFA vencido en 'Eliminar' (falla al leer la versión) — navega a MFA, NUNCA muestra confirmación ni borra, y al volver hay que confirmar de nuevo explícitamente", async () => {
    const fetchMock = routeFetch({
      mfaRecent: true,
      posts: { items: [post("1"), post("2")], nextCursor: null },
      // La lectura de versión (paso previo a mostrar la confirmación) falla con step_up_required:
      // simula MFA vencido justo al cruzar la frontera de la acción destructiva.
      adminDetail: {
        status: 403,
        body: { error: "No autorizado", code: "step_up_required" },
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    await screen.findByText("Publicación 2");
    fireEvent.click(
      await screen.findByRole("button", { name: /más acciones para publicación 2/i }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /^eliminar$/i }));

    expect(await screen.findByTestId("mfa")).toHaveTextContent(
      "/admin/mfa?returnTo=%2Fcosplay%3Fintent%3Ddelete",
    );
    // Nunca se mostró la confirmación destructiva ni se llegó a llamar al DELETE.
    expect(
      screen.queryByRole("group", { name: /eliminar esta publicación/i }),
    ).toBeNull();
    expect(
      fetchMock.mock.calls.some((c) => c[0] === "/api/admin/cosplay-post-delete"),
    ).toBe(false);

    // "Volver" a /cosplay?intent=delete (mismo returnTo que ya usa el resto de la app): el
    // catálogo se vuelve a mostrar tal cual, SIN ninguna publicación preseleccionada ni borrado
    // reproducido automáticamente — el ADMIN debe abrir el menú de la tarjeta y confirmar de
    // nuevo desde cero.
    cleanup();
    vi.restoreAllMocks();
    const fetchAfterReturn = routeFetch({
      posts: { items: [post("1"), post("2")], nextCursor: null },
    });
    vi.stubGlobal("fetch", fetchAfterReturn);
    renderSection(["/cosplay?intent=delete"]);

    await screen.findByText("Publicación 2");
    expect(
      screen.queryByRole("group", { name: /eliminar esta publicación/i }),
    ).toBeNull();
    expect(
      fetchAfterReturn.mock.calls.some((c) => c[0] === "/api/admin/cosplay-post-delete"),
    ).toBe(false);
  });
});
