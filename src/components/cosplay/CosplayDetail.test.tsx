import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import CosplayLocaleProvider from "@/i18n/LocaleProvider";
import type { CosplayPostDetail } from "@/types";
import CosplayDetail from "./CosplayDetail";

// /cosplay/:slug (Fase 9I-1): carga/error/no-encontrado/contenido, metadatos, y lo básico del
// visor (abrir, foto siguiente/anterior, Escape cierra). jsdom no implementa
// <dialog>.showModal(): se simula, igual que en InstagramSection.test.tsx.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function image(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    url: `https://example.test/${id}.webp`,
    width: 1600,
    height: 2400,
    position: Number(id),
    isCover: id === "0",
    decorative: false,
    altEs: `Alt ${id}`,
    altEn: null,
    altDe: null,
    captionEs: null,
    captionEn: null,
    captionDe: null,
    ...overrides,
  };
}

function detail(overrides: Partial<CosplayPostDetail> = {}): CosplayPostDetail {
  return {
    id: "post-1",
    slug: "kirito-sao",
    titleEs: "Kirito",
    titleEn: null,
    titleDe: null,
    characterName: "Kirito",
    series: "Sword Art Online",
    event: null,
    shotOn: "2026-03-15",
    publishedAt: "2026-03-20T00:00:00.000Z",
    cover: image("0"),
    photoCount: 2,
    descriptionEs: "Descripción de Kirito.",
    descriptionEn: null,
    descriptionDe: null,
    photographerCredit: "Fotógrafo de prueba",
    gallery: [image("0"), image("1")],
    ...overrides,
  } as CosplayPostDetail;
}

function renderDetail(slug: string | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CosplayLocaleProvider>
          <CosplayDetail slug={slug} />
        </CosplayLocaleProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
  };
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Determinista: sin esto, jsdom reporta navigator.language="en-US" y el idioma resuelto sería
  // inglés (comportamiento correcto de resolveInitialLocale, ya cubierto por locale.test.ts) —
  // aquí se fija español porque lo que se prueba es el renderizado, no la resolución de idioma.
  window.localStorage.setItem("upmina:locale", "es");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("/cosplay/:slug — estados", () => {
  it("carga: muestra el mensaje de cargando", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    renderDetail("kirito-sao");
    expect(screen.getByRole("status")).toHaveTextContent("Cargando…");
  });

  it("error: fetch 500 muestra el mensaje de error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, 500)));
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/no se pudo cargar/i),
    );
  });

  it("404: muestra 'no encontrado' con enlace de vuelta, no una pantalla en blanco", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, 404)));
    renderDetail("no-existe");
    await waitFor(() =>
      expect(screen.getByText("No encontramos esta publicación")).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: /volver a cosplay/i })).toHaveAttribute(
      "href",
      "/cosplay",
    );
  });

  it("sin slug: se trata igual que no encontrado, nunca carga infinita", async () => {
    vi.stubGlobal("fetch", vi.fn());
    renderDetail(undefined);
    await waitFor(() =>
      expect(screen.getByText("No encontramos esta publicación")).toBeInTheDocument(),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("contenido: título, descripción, metadatos y fecha formateada (UTC, sin desfase)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(detail())));
    renderDetail("kirito-sao");

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );
    expect(screen.getByText("Descripción de Kirito.")).toBeInTheDocument();
    expect(screen.getByText("Sword Art Online")).toBeInTheDocument();
    expect(screen.getByText("15 de marzo de 2026")).toBeInTheDocument();
    expect(screen.getByText("Fotógrafo de prueba")).toBeInTheDocument();
  });

  it("un campo opcional ausente (event) no deja un rótulo vacío", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(detail({ event: null }))));
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );
    expect(screen.queryByText("EVENTO")).toBeNull();
  });
});

describe("/cosplay/:slug — galería y visor", () => {
  it("abre el visor al pulsar una miniatura, con foco en Cerrar", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(detail())));
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Alt 0" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cerrar" })).toHaveFocus();
  });

  it("Siguiente avanza a la foto 2 de 2 (circular)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(detail())));
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Alt 0" }));
    await screen.findByRole("dialog");
    expect(screen.getByText("1 de 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Foto siguiente" }));
    expect(screen.getByText("2 de 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Foto siguiente" }));
    expect(screen.getByText("1 de 2")).toBeInTheDocument(); // circular
  });

  it("Escape cierra el visor y devuelve el foco a la miniatura que lo abrió", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(detail())));
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );

    const trigger = screen.getByRole("button", { name: "Alt 0" });
    fireEvent.click(trigger);
    await screen.findByRole("dialog");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("una imagen decorativa sin alt real usa el rótulo genérico 'Ver foto N' (nunca sin nombre accesible)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          detail({
            gallery: [image("0"), image("1", { decorative: true, altEs: null })],
          }),
        ),
      ),
    );
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );

    expect(screen.getByRole("button", { name: "Ver foto 2" })).toBeInTheDocument();
  });
});
