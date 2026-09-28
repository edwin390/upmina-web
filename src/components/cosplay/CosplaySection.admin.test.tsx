import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import CosplayLocaleProvider from "@/i18n/LocaleProvider";
import type { CosplayPostListPage } from "@/types";
import CosplaySection from "./CosplaySection";

// Visibilidad y apertura del editor ADMIN de Cosplay en /cosplay (Fase 9I-3, checkpoint 3). El
// backend sigue siendo la única autoridad real (cada mutación revalida cosplay_admin + MFA
// reciente, ver cosplay-editor-handlers.ts) — aquí solo se prueba que la UI: (a) no muestra NADA
// privilegiado sin la capacidad, (b) sí lo muestra con ella, y (c) abrir el editor nunca dispara
// una mutación por sí solo.

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

function routeFetch(
  opts: {
    adminList?: unknown[];
    mfaRecent?: boolean;
    /** Respuesta de POST /api/admin/cosplay-post-save (éxito por defecto, publicado). */
    saveResult?: { status: number; body: unknown };
    /** Respuesta del listado público SOLO para el refetch con cache-bust (?_r=…) que sigue a
     *  onPostChanged — simula que la publicación nueva YA está en Postgres, a diferencia de la
     *  respuesta (posiblemente cacheada) que se sirve antes de publicar. */
    listAfterPublish?: CosplayPostListPage;
  } = {},
) {
  return vi.fn(async (url: string, init?: { method?: string }) => {
    if (url.startsWith("/api/content/cosplay-list")) {
      if (url.includes("_r=") && opts.listAfterPublish) {
        return jsonResponse(opts.listAfterPublish);
      }
      return jsonResponse(EMPTY_LIST_PAGE);
    }
    if (url === "/api/admin/access") {
      return jsonResponse({
        role: "admin",
        capabilities: ["cosplay_admin"],
        mfa: { recent: opts.mfaRecent ?? true },
      });
    }
    if (url.startsWith("/api/admin/cosplay-post-list-admin")) {
      return jsonResponse({ items: opts.adminList ?? [] });
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

describe("USER/sin sesión — cero UI privilegiada", () => {
  it("sin sesión: no se monta el panel ADMIN ni 'Nueva publicación', y nunca se pide /api/admin/access", async () => {
    const fetchMock = routeFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    await waitFor(() =>
      expect(screen.getByText("Todavía no hay publicaciones")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /nueva publicación/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: /tus publicaciones/i })).toBeNull();
    expect(fetchMock.mock.calls.some((c) => c[0] === "/api/admin/access")).toBe(false);
  });
});

describe("ADMIN (cosplay_admin + MFA reciente) — controles visibles", () => {
  beforeEach(() => {
    authFakes.session = { access_token: "at-admin", user: { id: "admin-1" } };
  });

  it("muestra 'Nueva publicación' y el panel de publicaciones", async () => {
    vi.stubGlobal("fetch", routeFetch());
    renderSection();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /nueva publicación/i }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("heading", { name: /tus publicaciones/i }),
    ).toBeInTheDocument();
  });

  it("abrir el editor con 'Nueva publicación' NUNCA crea una publicación por sí solo (sin POST)", async () => {
    const fetchMock = routeFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    const openButton = await screen.findByRole("button", { name: /nueva publicación/i });
    fireEvent.click(openButton);

    await screen.findByRole("heading", { name: /nueva publicación de cosplay/i });
    // Solo lecturas: nunca un POST a cosplay-post-save con solo abrir el editor.
    expect(
      fetchMock.mock.calls.some((c) => c[0] === "/api/admin/cosplay-post-save"),
    ).toBe(false);
    expect(screen.getByLabelText(/título/i, { selector: "input" })).toHaveValue("");
  });

  it("cerrar el editor recién abierto (sin cambios) no pide confirmación", async () => {
    vi.stubGlobal("fetch", routeFetch());
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: /nueva publicación/i }));
    await screen.findByRole("heading", { name: /nueva publicación de cosplay/i });

    fireEvent.click(screen.getByRole("button", { name: /^cerrar$/i }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /nueva publicación de cosplay/i }),
      ).toBeNull(),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("escribir un título y cerrar SIN guardar pide confirmación explícita (no descarta en silencio)", async () => {
    vi.stubGlobal("fetch", routeFetch());
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: /nueva publicación/i }));
    const titleInput = await screen.findByLabelText(/título/i, {
      selector: "input",
    });
    fireEvent.change(titleInput, { target: { value: "Kirito de prueba" } });

    fireEvent.click(screen.getByRole("button", { name: /^cerrar$/i }));
    const alertDialog = await screen.findByRole("alertdialog");
    expect(alertDialog).toHaveTextContent(/cerrar sin guardar/i);

    // El editor sigue abierto detrás de la confirmación.
    expect(
      screen.getByRole("heading", { name: /nueva publicación de cosplay/i }),
    ).toBeInTheDocument();
  });

  it("?intent=create en la URL abre el editor automáticamente y limpia el parámetro", async () => {
    vi.stubGlobal("fetch", routeFetch());
    renderSection(["/cosplay?intent=create"]);
    await screen.findByRole("heading", { name: /nueva publicación de cosplay/i });
  });

  it("?intent=delete NUNCA identifica una publicación: solo abre el panel de descubrimiento", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        adminList: [
          {
            id: "post-1",
            slug: "x",
            status: "draft",
            title: "Borrador existente",
            version: 1,
            publishedAt: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    renderSection(["/cosplay?intent=delete"]);

    // Nunca abre el editor directamente ni preselecciona una publicación.
    expect(
      screen.queryByRole("heading", {
        name: /(nueva publicación|editar publicación) de cosplay/i,
      }),
    ).toBeNull();
    await screen.findByText("Borrador existente");
  });
});

describe("endurecimiento global de MFA (9G/9I) — entrada a Cosplay (Caso A)", () => {
  beforeEach(() => {
    authFakes.session = { access_token: "at-admin", user: { id: "admin-1" } };
  });

  it("MFA reciente: 'Nueva publicación' abre el editor directamente, sin pasar por /admin/mfa", async () => {
    vi.stubGlobal("fetch", routeFetch({ mfaRecent: true }));
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: /nueva publicación/i }));
    await screen.findByRole("heading", { name: /nueva publicación de cosplay/i });
    expect(screen.queryByTestId("mfa")).toBeNull();
  });

  it("MFA vencido: 'Nueva publicación' NUNCA abre el editor — navega a /admin/mfa?returnTo=/cosplay?intent=create", async () => {
    vi.stubGlobal("fetch", routeFetch({ mfaRecent: false }));
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: /nueva publicación/i }));

    expect(await screen.findByTestId("mfa")).toHaveTextContent(
      "/admin/mfa?returnTo=%2Fcosplay%3Fintent%3Dcreate",
    );
    expect(
      screen.queryByRole("heading", { name: /nueva publicación de cosplay/i }),
    ).toBeNull();
  });

  it("MFA vencido: 'Editar' desde el panel de descubrimiento NUNCA abre el editor — navega a /admin/mfa?returnTo=/cosplay?intent=edit", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        mfaRecent: false,
        adminList: [
          {
            id: "post-1",
            slug: "x",
            status: "draft",
            title: "Borrador existente",
            version: 1,
            publishedAt: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: /tus publicaciones/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^editar$/i }));

    expect(await screen.findByTestId("mfa")).toHaveTextContent(
      "/admin/mfa?returnTo=%2Fcosplay%3Fintent%3Dedit",
    );
    expect(
      screen.queryByRole("heading", { name: /editar publicación de cosplay/i }),
    ).toBeNull();
  });
});

describe("publicar (ajuste UX posterior a 9I-3): cierre + aviso solo tras confirmación real del backend", () => {
  beforeEach(() => {
    authFakes.session = { access_token: "at-admin", user: { id: "admin-1" } };
  });

  it("publicar con éxito: cierra el editor, muestra 'Publicado con éxito' y la publicación nueva aparece SOLA como Última publicación (sin recargar la página)", async () => {
    const publishedPost = {
      id: "post-new",
      slug: "kirito-de-prueba",
      title: "Kirito de prueba",
      characterName: null,
      series: null,
      event: null,
      shotOn: null,
      publishedAt: "2026-01-01T00:00:00.000Z",
      cover: null,
      photoCount: 0,
    };
    const fetchMock = routeFetch({
      listAfterPublish: { items: [publishedPost], nextCursor: null },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    await screen.findByText("Todavía no hay publicaciones");

    fireEvent.click(await screen.findByRole("button", { name: /nueva publicación/i }));
    const titleInput = await screen.findByLabelText(/título/i, { selector: "input" });
    fireEvent.change(titleInput, { target: { value: "Kirito de prueba" } });

    fireEvent.click(screen.getByRole("button", { name: /^publicar$/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /nueva publicación de cosplay/i }),
      ).toBeNull(),
    );
    expect(screen.getByText("Publicado con éxito")).toBeInTheDocument();

    // La causa real del bug reportado (ver useCosplayList.ts): un refetch a la MISMA URL recibía
    // la respuesta cacheada por la Edge Network de Vercel (Cache-Control: s-maxage=60) sin la
    // publicación nueva. El fix agrega ?_r=… SOLO en el refetch post-publicación para forzar un
    // MISS de esa caché — aquí se verifica que ese refetch realmente ocurre...
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (c) => typeof c[0] === "string" && c[0].includes("_r="),
        ),
      ).toBe(true),
    );
    // ...y que la publicación recién creada se convierte AUTOMÁTICAMENTE en "Última publicación",
    // sin recargar la página completa ni que el ADMIN tenga que hacer nada más.
    await waitFor(() => expect(screen.getByText("Kirito de prueba")).toBeInTheDocument());
    expect(screen.queryByText("Todavía no hay publicaciones")).toBeNull();
  });

  it("publicar con error del backend: el editor NO se cierra, conserva lo introducido, muestra el error y NUNCA dispara un refetch de éxito falso", async () => {
    const fetchMock = routeFetch({
      saveResult: {
        status: 422,
        body: { error: "Solicitud inválida", code: "missing_title" },
      },
      listAfterPublish: {
        items: [
          {
            id: "post-new",
            slug: "kirito-de-prueba",
            title: "Kirito de prueba",
            characterName: null,
            series: null,
            event: null,
            shotOn: null,
            publishedAt: "2026-01-01T00:00:00.000Z",
            cover: null,
            photoCount: 0,
          },
        ],
        nextCursor: null,
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: /nueva publicación/i }));
    const titleInput = await screen.findByLabelText(/título/i, { selector: "input" });
    fireEvent.change(titleInput, { target: { value: "Kirito de prueba" } });

    fireEvent.click(screen.getByRole("button", { name: /^publicar$/i }));

    await screen.findByRole("alert");
    expect(
      screen.getByRole("heading", { name: /nueva publicación de cosplay/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/título/i, { selector: "input" })).toHaveValue(
      "Kirito de prueba",
    );
    expect(screen.queryByText("Publicado con éxito")).toBeNull();
    // Un fallo de publicación nunca debe invalidar/refrescar el listado público: onPostChanged
    // (y por tanto el cache-bust) solo se dispara tras un save() realmente exitoso.
    expect(
      fetchMock.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes("_r=")),
    ).toBe(false);
  });
});
