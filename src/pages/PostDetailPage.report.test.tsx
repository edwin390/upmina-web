import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import PostDetailPage from "./PostDetailPage";

// REP-1: el detalle de una publicación ofrece reportarla (el diálogo se prueba en
// CommunityReportButton.test.tsx).

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: null, user: null, loading: false, signOut: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/community/post/:postId — reportar", () => {
  it("muestra el botón de reporte junto al like cuando la publicación existe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              post: {
                id: "post-1",
                text: "hola comunidad",
                createdAt: "2026-03-02T10:00:00.000Z",
                author: { username: "edwin1", displayName: null },
                media: [],
                likeCount: 0,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter initialEntries={["/community/post/post-1"]}>
          <Routes>
            <Route path="/community/post/:postId" element={<PostDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("button", { name: "Reportar esta publicación" }),
    ).toBeInTheDocument();
  });

  it("no ofrece reportar una publicación inexistente", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "x" }), { status: 404 })),
    );
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter initialEntries={["/community/post/post-1"]}>
          <Routes>
            <Route path="/community/post/:postId" element={<PostDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Esta publicación no existe")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reportar/ })).toBeNull();
  });
});
