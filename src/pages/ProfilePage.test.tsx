import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ProfilePage from "./ProfilePage";

// /@username (Fase 9J-2B): perfil público — estados de carga/no-encontrado/error/vacío/contenido,
// jerarquía TikTok-style (avatar, display name, @username, bio, N publicaciones, SIN likes
// fabricados), galería de 3 columnas con cover/indicador multi-media/tile de texto, y ausencia
// total de controles de gestión (editar/borrar/ADMIN) — esta página es de solo lectura pública.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function mediaItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "media-1",
    position: 0,
    kind: "image",
    url: "https://example.test/media-1.webp",
    width: 1200,
    height: 1600,
    ...overrides,
  };
}

function post(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    text: "hola comunidad",
    createdAt: "2026-03-02T10:00:00.000Z",
    author: { username: "edwin1", displayName: null },
    media: [],
    ...overrides,
  };
}

function profilePage(overrides: Record<string, unknown> = {}) {
  return {
    profile: {
      username: "edwin1",
      displayName: null,
      bio: null,
      postCount: 0,
      ...(overrides.profile as Record<string, unknown> | undefined),
    },
    posts: { items: [], nextCursor: null, ...(overrides.posts as object | undefined) },
  };
}

function stubProfile(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => json(body, status));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderProfile(entry = "/@edwin1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/:usernameParam" element={<ProfilePage />} />
          <Route path="/community" element={<p>Comunidad stub</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/@username — estados", () => {
  it("carga: muestra un estado de carga", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    renderProfile();
    expect(screen.getByText("Cargando perfil…")).toBeInTheDocument();
  });

  it("perfil inexistente (404): estado específico de no-encontrado, no un 404 genérico del sitio", async () => {
    stubProfile({ error: "Perfil no encontrado" }, 404);
    renderProfile();
    expect(await screen.findByText("Este perfil no existe")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver a Comunidad" })).toHaveAttribute(
      "href",
      "/community",
    );
  });

  it("error de servidor: estado con reintento", async () => {
    stubProfile({ error: "Error interno" }, 500);
    renderProfile();
    expect(await screen.findByText("No se pudo cargar este perfil.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
  });

  it("perfil existente sin publicaciones: estado vacío específico", async () => {
    stubProfile(profilePage());
    renderProfile();
    expect(await screen.findByText("Todavía no hay publicaciones")).toBeInTheDocument();
  });
});

describe("/@username — encabezado (jerarquía tipo TikTok)", () => {
  it("muestra @username, displayName y bio cuando existen", async () => {
    stubProfile(
      profilePage({
        profile: { displayName: "Edwin", bio: "Fan de Mina", postCount: 3 },
      }),
    );
    renderProfile();
    expect(await screen.findByText("Edwin")).toBeInTheDocument();
    expect(screen.getByText("@edwin1")).toBeInTheDocument();
    expect(screen.getByText("Fan de Mina")).toBeInTheDocument();
    expect(screen.getByText("3 publicaciones")).toBeInTheDocument();
  });

  it("displayName ausente: no se inventa un nombre, solo @username", async () => {
    stubProfile(profilePage());
    renderProfile();
    await screen.findByText("@edwin1");
    // El único texto de identidad es "@edwin1"; no aparece ningún display name fabricado.
    expect(screen.getAllByText("@edwin1")).toHaveLength(1);
  });

  it("1 publicación: singular correcto", async () => {
    stubProfile(profilePage({ profile: { postCount: 1 } }));
    renderProfile();
    expect(await screen.findByText("1 publicación")).toBeInTheDocument();
  });

  it("NUNCA fabrica una estadística de likes", async () => {
    stubProfile(profilePage({ profile: { postCount: 5 } }));
    renderProfile();
    await screen.findByText("5 publicaciones");
    expect(screen.queryByText(/like/i)).toBeNull();
    expect(screen.queryByText(/0 me gusta/i)).toBeNull();
  });
});

describe("/@username — galería", () => {
  it("grid de 3 columnas en desktop", async () => {
    stubProfile(profilePage({ posts: { items: [post("p1")], nextCursor: null } }));
    const { container } = renderProfile();
    await screen.findByRole("list");
    expect(container.querySelector("ul.grid-cols-3")).not.toBeNull();
  });

  it("publicación con imagen: usa la primera media ready como cover (object-cover permitido aquí)", async () => {
    stubProfile(
      profilePage({
        posts: {
          items: [post("p1", { text: null, media: [mediaItem()] })],
          nextCursor: null,
        },
      }),
    );
    const { container } = renderProfile();
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(1));
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("src", "https://example.test/media-1.webp");
    expect(img.className).toContain("object-cover");
  });

  it("publicación con varias imágenes: indicador multi-media con el recuento", async () => {
    stubProfile(
      profilePage({
        posts: {
          items: [
            post("p1", {
              text: null,
              media: [
                mediaItem({ id: "m1" }),
                mediaItem({ id: "m2", url: "https://example.test/media-2.webp" }),
                mediaItem({ id: "m3", url: "https://example.test/media-3.webp" }),
              ],
            }),
          ],
          nextCursor: null,
        },
      }),
    );
    renderProfile();
    expect(await screen.findByText("+3")).toBeInTheDocument();
  });

  it("publicación de solo texto: tile de texto estilizado, nunca en blanco", async () => {
    stubProfile(
      profilePage({
        posts: { items: [post("p1", { text: "solo texto aquí" })], nextCursor: null },
      }),
    );
    renderProfile();
    expect(await screen.findByText("solo texto aquí")).toBeInTheDocument();
  });

  it("cada tile es enfocable por teclado con una etiqueta accesible", async () => {
    stubProfile(
      profilePage({
        posts: {
          items: [post("p1", { text: null, media: [mediaItem()] })],
          nextCursor: null,
        },
      }),
    );
    renderProfile();
    const tile = await screen.findByRole("button", { name: /1 imagen/ });
    tile.focus();
    expect(document.activeElement).toBe(tile);
  });
});

describe("/@username — sin controles de gestión", () => {
  it("no expone editar, borrar ni ningún control ADMIN/MODERATOR", async () => {
    stubProfile(
      profilePage({
        profile: { postCount: 1 },
        posts: { items: [post("p1")], nextCursor: null },
      }),
    );
    renderProfile();
    await screen.findByText("1 publicación");
    expect(screen.queryByRole("button", { name: /editar/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /borrar/i })).toBeNull();
    expect(screen.queryByText(/admin/i)).toBeNull();
    expect(screen.queryByText(/moderator/i)).toBeNull();
  });
});
