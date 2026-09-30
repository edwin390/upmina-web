import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import CommunitySection from "./CommunitySection";

// /community (Fase 9J-2A, con "Populares" activada en 9J-2C): feed público REAL — reemplaza el
// cascarón de 9J-1C UX follow-up (que no tenía ninguna fuente de datos pública todavía). Confirma:
// estados de carga/vacío/error, que texto-solo/imagen-solo/varias-imágenes se presentan, que la
// identidad del autor (@username, displayName opcional) se muestra sin inventar nombres, que
// cambiar de pestaña consulta el modo correcto, y que /community sigue sin ningún control de
// creación (eso vive exclusivamente en /@username).

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: null, user: null, loading: false, signOut: vi.fn() }),
}));

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
    author: { username: "mina", displayName: "Mina" },
    media: [],
    likeCount: 0,
    ...overrides,
  };
}

function stubFeed(page: { items: unknown[]; nextCursor: string | null }) {
  const fetchMock = vi.fn(async () => json(page));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CommunitySection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/community — estados", () => {
  it("carga: muestra un estado de carga (sin fabricar publicaciones)", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    renderSection();
    expect(screen.getByText("Cargando publicaciones…")).toBeInTheDocument();
  });

  it("vacío: estado amistoso, sin inventar publicaciones", async () => {
    stubFeed({ items: [], nextCursor: null });
    renderSection();
    expect(await screen.findByText("Todavía no hay publicaciones")).toBeInTheDocument();
  });

  it("error: estado con reintento, sin fabricar contenido", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "Error interno" }, 500)),
    );
    renderSection();
    expect(
      await screen.findByText("No se pudieron cargar las publicaciones."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
  });
});

// Fase 9J-2A UX follow-up (ancho en desktop): el feed usa un ancho máximo deliberadamente angosto
// (max-w-3xl ≈ 768px, dentro del rango 720–800px pedido) y centrado — un solo <section> envuelve
// header + estados de carga/error/vacío/contenido, así que TODOS comparten exactamente el mismo
// ancho (nunca solo la lista de tarjetas). Por debajo de ese ancho, max-w-* no fuerza nada: el
// feed sigue ocupando el ancho disponible con el mismo padding lateral de siempre (px-4).
describe("/community — ancho del feed en desktop", () => {
  it("el contenedor raíz tiene un max-width angosto y centrado, en carga/error/vacío/contenido", async () => {
    stubFeed({ items: [post("p1")], nextCursor: null });
    const { container } = renderSection();
    await screen.findByText("hola comunidad");
    const section = container.querySelector("section");
    expect(section?.className).toContain("max-w-3xl");
    expect(section?.className).toContain("mx-auto");
  });
});

describe("/community — contenido real", () => {
  it("Recientes renderiza publicaciones reales devueltas por el feed", async () => {
    stubFeed({ items: [post("p1")], nextCursor: null });
    renderSection();
    expect(await screen.findByText("hola comunidad")).toBeInTheDocument();
  });

  it("publicación de solo texto: sin imágenes renderizadas", async () => {
    stubFeed({ items: [post("p1", { media: [] })], nextCursor: null });
    const { container } = renderSection();
    await screen.findByText("hola comunidad");
    // Imágenes de Comunidad no tienen alt editorial (sin columna alt en el modelo, a diferencia
    // de Cosplay): alt="" es correcto, así que se consultan por selector, no por role="img" (un
    // <img alt=""> tiene role implícito "presentation", no "img").
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("publicación de solo imagen: sin texto, con la imagen completa (sin recorte forzado), acotada por una altura máxima (9J-3 follow-up CORRECTION)", async () => {
    stubFeed({
      items: [post("p1", { text: null, media: [mediaItem()] })],
      nextCursor: null,
    });
    const { container } = renderSection();
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(1));
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("src", "https://example.test/media-1.webp");
    // Imagen única en el feed (9J-3 follow-up CORRECTION): nunca object-cover — la imagen conserva
    // su proporción completa (object-contain) y solo se acota con una altura MÁXIMA (max-height),
    // nunca una altura fija que la recorte o la estire.
    expect(img.className).toContain("object-contain");
    expect(img.className).not.toContain("object-cover");
    expect(img.className).toMatch(/max-h-\[55vh\]/);
  });

  it("varias imágenes: todas se presentan", async () => {
    stubFeed({
      items: [
        post("p1", {
          text: null,
          media: [
            mediaItem({ id: "m1", position: 0 }),
            mediaItem({
              id: "m2",
              position: 1,
              url: "https://example.test/media-2.webp",
            }),
            mediaItem({
              id: "m3",
              position: 2,
              url: "https://example.test/media-3.webp",
            }),
          ],
        }),
      ],
      nextCursor: null,
    });
    const { container } = renderSection();
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(3));
    // El grid de varias imágenes sigue sin cambios (fuera de alcance de este ajuste): cada celda
    // conserva object-cover.
    for (const img of container.querySelectorAll("img")) {
      expect(img.className).toContain("object-cover");
    }
  });

  it("muestra @username del autor", async () => {
    stubFeed({
      items: [post("p1", { author: { username: "kirito", displayName: null } })],
      nextCursor: null,
    });
    renderSection();
    expect(await screen.findByText("@kirito")).toBeInTheDocument();
  });

  it("displayName presente: se muestra el nombre Y el @username (sin duplicar)", async () => {
    stubFeed({
      items: [post("p1", { author: { username: "kirito", displayName: "Kirito" } })],
      nextCursor: null,
    });
    renderSection();
    expect(await screen.findByText("Kirito")).toBeInTheDocument();
    expect(screen.getByText("@kirito")).toBeInTheDocument();
  });

  it("displayName ausente: se muestra @username como identidad principal, sin inventar un nombre", async () => {
    stubFeed({
      items: [post("p1", { author: { username: "kirito", displayName: null } })],
      nextCursor: null,
    });
    renderSection();
    const identities = await screen.findAllByText("@kirito");
    // Solo UNA aparición: no se duplica @username como si fuera también el displayName.
    expect(identities).toHaveLength(1);
  });
});

describe("/community — sin controles de creación", () => {
  it('no expone ningún <input type="file">, ni un botón de creación de publicaciones', async () => {
    stubFeed({ items: [], nextCursor: null });
    const { container } = renderSection();
    await waitFor(() => expect(container.querySelector('input[type="file"]')).toBeNull());
    expect(screen.queryByRole("button", { name: /nueva publicación/i })).toBeNull();
    expect(screen.queryByText(/sube tu edit/i)).toBeNull();
  });
});

describe("/community — pestañas (Fase 9J-2C: Populares activada)", () => {
  it("'Recientes' y 'Populares' son botones interactivos; Recientes empieza activa", async () => {
    stubFeed({ items: [], nextCursor: null });
    renderSection();
    await screen.findByText("Todavía no hay publicaciones");
    const recent = screen.getByRole("button", { name: "Recientes" });
    const popular = screen.getByRole("button", { name: "Populares" });
    expect(recent).toHaveAttribute("aria-current", "true");
    expect(popular).not.toHaveAttribute("aria-current");
  });

  it("pide mode=recent por defecto", async () => {
    const fetchMock = stubFeed({ items: [], nextCursor: null });
    renderSection();
    await screen.findByText("Todavía no hay publicaciones");
    expect(fetchMock).toHaveBeenCalledWith("/api/content/community-feed?mode=recent");
  });

  it("clic en 'Populares' pide mode=popular y la marca activa", async () => {
    const fetchMock = stubFeed({ items: [], nextCursor: null });
    renderSection();
    await screen.findByText("Todavía no hay publicaciones");

    fireEvent.click(screen.getByRole("button", { name: "Populares" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/content/community-feed?mode=popular"),
    );
    expect(screen.getByRole("button", { name: "Populares" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByRole("button", { name: "Recientes" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("Populares renderiza publicaciones reales devueltas por el servidor, nunca datos fabricados en el cliente", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("mode=popular")) {
        return json({
          items: [post("pop-1", { text: "popular real" })],
          nextCursor: null,
        });
      }
      return json({ items: [], nextCursor: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection();
    await screen.findByText("Todavía no hay publicaciones");

    fireEvent.click(screen.getByRole("button", { name: "Populares" }));
    expect(await screen.findByText("popular real")).toBeInTheDocument();
  });
});
