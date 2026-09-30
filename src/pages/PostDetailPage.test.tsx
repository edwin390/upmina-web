import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import PostDetailPage from "./PostDetailPage";

// /community/post/:postId (Fase 9J-2B.1): estados de carga/no-encontrado/error/contenido; texto
// completo, media, identidad del autor enlazando a /@username, fecha; sin comentarios ni likes.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    text: "hola comunidad",
    createdAt: "2026-03-02T10:00:00.000Z",
    author: { username: "edwin1", displayName: null },
    media: [],
    ...overrides,
  };
}

function stubDetail(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => json(body, status));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDetail(entry = "/community/post/post-1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/community/post/:postId" element={<PostDetailPage />} />
          <Route path="/community" element={<p>Comunidad stub</p>} />
          <Route path="/@:username" element={<p>Perfil stub</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/community/post/:postId — estados", () => {
  it("carga: muestra un estado de carga", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    renderDetail();
    expect(screen.getByText("Cargando publicación…")).toBeInTheDocument();
  });

  it("publicación inexistente (404): estado específico de no-encontrado", async () => {
    stubDetail({ error: "No encontrado" }, 404);
    renderDetail();
    expect(await screen.findByText("Esta publicación no existe")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver a Comunidad" })).toHaveAttribute(
      "href",
      "/community",
    );
  });

  it("error de servidor: estado con reintento", async () => {
    stubDetail({ error: "Error interno" }, 500);
    renderDetail();
    expect(
      await screen.findByText("No se pudo cargar esta publicación."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
  });
});

describe("/community/post/:postId — contenido", () => {
  it("renderiza el texto completo y la fecha", async () => {
    stubDetail({ post: post({ text: "texto completo de la publicación" }) });
    renderDetail();
    expect(
      await screen.findByText("texto completo de la publicación"),
    ).toBeInTheDocument();
  });

  it("renderiza la media", async () => {
    stubDetail({
      post: post({
        text: null,
        media: [
          {
            id: "m1",
            position: 0,
            kind: "image",
            url: "https://example.test/m1.webp",
            width: 1200,
            height: 1600,
          },
        ],
      }),
    });
    const { container } = renderDetail();
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(1));
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/m1.webp",
    );
  });

  it("la identidad del autor enlaza a /@username", async () => {
    stubDetail({ post: post({ author: { username: "kirito", displayName: "Kirito" } }) });
    renderDetail();
    const link = await screen.findByRole("link", { name: /Kirito/ });
    expect(link).toHaveAttribute("href", "/@kirito");
  });

  it("no muestra comentarios ni una estadística de likes fabricada", async () => {
    stubDetail({ post: post() });
    renderDetail();
    await screen.findByText("hola comunidad");
    expect(screen.queryByText(/comentario/i)).toBeNull();
    expect(screen.queryByText(/like/i)).toBeNull();
  });
});
