import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import CosplayLocaleProvider from "@/i18n/LocaleProvider";
import type { CosplayPostListPage } from "@/types";
import CosplaySection from "./CosplaySection";

// /cosplay (Fase 9I-1): estados de carga/error/vacío/contenido, y que el listado NUNCA renderiza
// controles privilegiados (Nueva publicación/Editar/Eliminar) — la arquitectura de ese control
// existe (PrivilegedOnly + cosplay_admin) pero deliberadamente no se monta todavía en esta
// página (Fase 9I-3 lo hará; ver la decisión documentada en el checkpoint 9I-1).

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const image = (id: string) => ({
  id,
  url: `https://example.test/${id}.webp`,
  width: 1600,
  height: 2400,
  position: 0,
  isCover: true,
  decorative: false,
  altEs: `Alt ${id}`,
  altEn: null,
  altDe: null,
  captionEs: null,
  captionEn: null,
  captionDe: null,
});

function post(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    slug: `post-${id}`,
    titleEs: `Publicación ${id}`,
    titleEn: null,
    titleDe: null,
    characterName: "Personaje",
    series: "Serie",
    event: null,
    shotOn: null,
    publishedAt: "2026-03-01T00:00:00.000Z",
    cover: image(id),
    photoCount: 1,
    ...overrides,
  };
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CosplayLocaleProvider>
          <CosplaySection />
        </CosplayLocaleProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // Determinista: sin esto, jsdom reporta navigator.language="en-US" y el idioma resuelto sería
  // inglés (comportamiento CORRECTO de resolveInitialLocale, ya cubierto por locale.test.ts) —
  // aquí se fija español a propósito porque lo que se prueba es el renderizado, no la resolución
  // de idioma.
  window.localStorage.setItem("upmina:locale", "es");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("/cosplay — estados", () => {
  it("carga: muestra el mensaje de cargando", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    renderSection();
    expect(screen.getByRole("status")).toHaveTextContent("Cargando publicaciones…");
  });

  it("error: fetch no-ok muestra el mensaje de error, no una pantalla en blanco", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, 500)));
    renderSection();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/no se pudieron cargar/i),
    );
  });

  it("vacío: 0 publicaciones muestra el estado vacío cuidado, no lenguaje de base de datos", async () => {
    const page: CosplayPostListPage = { items: [], nextCursor: null };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(page)));
    renderSection();
    await waitFor(() =>
      expect(screen.getByText("Todavía no hay publicaciones")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/no rows|null|undefined/i)).toBeNull();
  });

  it("contenido: la primera publicación es el hero, el resto va en la grid", async () => {
    const page: CosplayPostListPage = {
      items: [post("1"), post("2"), post("3")],
      nextCursor: null,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(page)));
    renderSection();

    await waitFor(() => expect(screen.getByText("Publicación 1")).toBeInTheDocument());
    // El texto en el DOM es "Última publicación" (uppercase es solo CSS text-transform).
    expect(screen.getByText("Última publicación")).toBeInTheDocument();
    expect(screen.getByText("Publicación 2")).toBeInTheDocument();
    expect(screen.getByText("Publicación 3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Publicación 1/ })).toHaveAttribute(
      "href",
      "/cosplay/post-1",
    );
  });

  it("sin siguiente página: no muestra 'Cargar más'", async () => {
    const page: CosplayPostListPage = { items: [post("1")], nextCursor: null };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(page)));
    renderSection();
    await waitFor(() => expect(screen.getByText("Publicación 1")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Cargar más" })).toBeNull();
  });

  it("con siguiente página: 'Cargar más' pide la página siguiente con el cursor", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [post("1")], nextCursor: "CURSOR1" }))
      .mockResolvedValueOnce(json({ items: [post("2")], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    await waitFor(() => expect(screen.getByText("Publicación 1")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Cargar más" }));

    await waitFor(() => expect(screen.getByText("Publicación 2")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/content/cosplay-list?cursor=CURSOR1",
    );
    expect(screen.queryByRole("button", { name: "Cargar más" })).toBeNull();
  });

  it("USER (sin nada montado todavía): CERO controles privilegiados en la página", async () => {
    const page: CosplayPostListPage = { items: [post("1")], nextCursor: null };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(page)));
    renderSection();
    await waitFor(() => expect(screen.getByText("Publicación 1")).toBeInTheDocument());

    for (const label of [/nueva publicación/i, /^editar$/i, /^eliminar$/i, /admin/i]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });
});
