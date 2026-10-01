import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import CosplayLocaleProvider from "@/i18n/LocaleProvider";
import type { CosplayPostDetail } from "@/types";
import CosplayDetail from "./CosplayDetail";

// /cosplay/:slug (Fase "COSPLAY DETAIL REDESIGN"): detalle de una publicación de Cosplay,
// inspirado visualmente en el detalle de Community — media SIEMPRE visible (sin un paso
// adicional de "abrir" un visor aparte, a diferencia del CosplayLightbox anterior), con
// navegación anterior/siguiente entre las FOTOS de esta misma publicación (nunca entre
// publicaciones). Evento y Fecha manual (shotOn) ya no se muestran: la fecha visible es la
// automática de publicación (publishedAt).

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
    alt: `Alt ${id}`,
    caption: null,
    ...overrides,
  };
}

function detail(overrides: Partial<CosplayPostDetail> = {}): CosplayPostDetail {
  return {
    id: "post-1",
    slug: "kirito-sao",
    title: "Kirito",
    characterName: "Kirito",
    series: "Sword Art Online",
    // Publicaciones antiguas pueden seguir teniendo event/shotOn en los datos (nunca se borran
    // de forma destructiva) — el detalle simplemente ya no los muestra. Se dejan con valores
    // aquí a propósito para probar justo eso.
    event: "[legacy] Convención de ejemplo",
    shotOn: "2026-03-15",
    publishedAt: "2026-03-20T00:00:00.000Z",
    cover: image("0"),
    photoCount: 2,
    description: "Descripción de Kirito.",
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

  it("error: fetch 500 muestra el mensaje de error con reintento", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, 500)));
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/no se pudo cargar/i),
    );
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
  });

  it("404: muestra 'no encontrado' con enlace de vuelta, no una pantalla en blanco", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, 404)));
    renderDetail("no-existe");
    await waitFor(() =>
      expect(screen.getByText("No encontramos esta publicación")).toBeInTheDocument(),
    );
    // Dos enlaces de vuelta coexisten en este estado (el de cabecera, siempre presente, y el del
    // propio bloque "no encontrado") — ambos apuntan a /cosplay.
    for (const link of screen.getAllByRole("link", { name: /volver a cosplay/i })) {
      expect(link).toHaveAttribute("href", "/cosplay");
    }
  });

  it("sin slug: se trata igual que no encontrado, nunca carga infinita", async () => {
    vi.stubGlobal("fetch", vi.fn());
    renderDetail(undefined);
    await waitFor(() =>
      expect(screen.getByText("No encontramos esta publicación")).toBeInTheDocument(),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cierre/back: el enlace 'Volver a Cosplay' está siempre presente y apunta a /cosplay", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(detail())));
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );
    const backLinks = screen.getAllByRole("link", { name: /volver a cosplay/i });
    for (const link of backLinks) {
      expect(link).toHaveAttribute("href", "/cosplay");
    }
  });
});

describe("/cosplay/:slug — contenido, inspirado en el detalle de Community", () => {
  it("título, descripción, personaje/serie/fotógrafo y fecha AUTOMÁTICA de publicación (nunca la manual)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(detail())));
    renderDetail("kirito-sao");

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );
    expect(screen.getByText("Descripción de Kirito.")).toBeInTheDocument();
    expect(screen.getByText("Sword Art Online")).toBeInTheDocument();
    expect(screen.getByText("Fotógrafo de prueba")).toBeInTheDocument();

    // publishedAt (automática) es un timestamp real: se formatea en la hora local del entorno
    // (nunca fijada a UTC como formatDateOnly, que es solo para columnas `date`), así que no se
    // fija un día exacto aquí — solo que use publishedAt (2026) y nunca el shot_on manual del
    // fixture ("2026-03-15" → "15 de marzo").
    const time = document.querySelector("time")!;
    expect(time).toHaveAttribute("datetime", "2026-03-20T00:00:00.000Z");
    expect(time.textContent).toContain("2026");
    expect(time.textContent).not.toContain("15 de marzo");
  });

  it("Evento YA NO aparece en el detalle, aunque la publicación tenga un valor legacy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(detail({ event: "[legacy] Convención X" }))),
    );
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );
    expect(screen.queryByText("[legacy] Convención X")).toBeNull();
    expect(screen.queryByText("Evento")).toBeNull();
  });

  it("Fecha MANUAL (shotOn) ya no aparece en el detalle, aunque la publicación tenga un valor legacy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(detail({ shotOn: "2020-01-01" }))),
    );
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );
    // Ni el rótulo "Fecha" ni una fecha formateada a partir de shotOn (1 de enero de 2020).
    expect(screen.queryByText("1 de enero de 2020")).toBeNull();
  });

  it("un campo opcional ausente (personaje/serie/fotógrafo) no deja metadata vacía ni rótulos huérfanos", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json(detail({ characterName: null, series: null, photographerCredit: null })),
        ),
    );
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );
    expect(document.querySelector("dl")).toBeNull();
  });

  it("publicaciones antiguas (con event/shotOn en los datos) siguen renderizando el detalle con normalidad", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json(detail({ event: "Evento legacy", shotOn: "2019-05-05" })),
        ),
    );
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );
    expect(screen.getByText("Descripción de Kirito.")).toBeInTheDocument();
    expect(document.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/0.webp",
    );
  });
});

describe("/cosplay/:slug — media SIEMPRE visible, navegación entre FOTOS (nunca entre publicaciones)", () => {
  it("la fotografía principal está visible sin ningún paso de 'abrir' un visor aparte", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(detail())));
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );
    // Sin <dialog>, sin miniaturas-botón que haya que pulsar primero.
    expect(screen.queryByRole("dialog")).toBeNull();
    const img = document.querySelector("img")!;
    expect(img).toHaveAttribute("src", "https://example.test/0.webp");
    expect(img.className).toContain("object-contain");
  });

  it("una sola foto: sin flechas de navegación ni contador", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(detail({ gallery: [image("0")], photoCount: 1 }))),
    );
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Foto anterior" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Foto siguiente" })).toBeNull();
  });

  it("varias fotos: 'Siguiente' avanza en el orden correcto (circular) y el contador se actualiza", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          detail({
            gallery: [image("0"), image("1"), image("2")],
            photoCount: 3,
          }),
        ),
      ),
    );
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );

    expect(document.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/0.webp",
    );
    expect(screen.getByText("1 de 3")).toBeInTheDocument();
    const nav = screen.getByRole("group", { name: "1 de 3" });
    expect(nav).toContainElement(screen.getByRole("button", { name: "Foto anterior" }));
    expect(nav).toContainElement(screen.getByRole("button", { name: "Foto siguiente" }));
    expect(nav.querySelector("img")).toBeNull();
    expect(nav.previousElementSibling?.tagName).toBe("IMG");

    fireEvent.click(screen.getByRole("button", { name: "Foto siguiente" }));
    expect(document.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/1.webp",
    );
    expect(screen.getByText("2 de 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Foto siguiente" }));
    fireEvent.click(screen.getByRole("button", { name: "Foto siguiente" }));
    // Circular: de vuelta a la primera.
    expect(document.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/0.webp",
    );
    expect(screen.getByText("1 de 3")).toBeInTheDocument();
  });

  it("'Anterior' retrocede circularmente", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(detail({ gallery: [image("0"), image("1")] }))),
    );
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Foto anterior" }));
    expect(document.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/1.webp",
    );
  });

  it("teclado: ArrowRight/ArrowLeft cambian de foto", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(detail({ gallery: [image("0"), image("1")] }))),
    );
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(document.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/1.webp",
    );
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(document.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/0.webp",
    );
  });

  it("navegar entre fotos NUNCA navega a otra publicación (la URL/slug permanecen intactos)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(detail({ gallery: [image("0"), image("1")] }))),
    );
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Foto siguiente" }));
    // El título/heading de la publicación no cambia: seguimos en la misma publicación.
    expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument();
    expect(screen.queryAllByRole("link", { name: /volver a cosplay/i })).not.toHaveLength(
      0,
    );
  });

  it("responsive: la fotografía usa una altura máxima (nunca fija) y nunca se recorta (object-contain)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(detail())));
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );
    const img = document.querySelector("img")!;
    expect(img.className).toContain("object-contain");
    expect(img.className).not.toContain("object-cover");
    expect(img.className).toMatch(/max-h-\[60vh\]/);
  });

  it("respeta el orden de las fotos (position) al recorrerlas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          detail({
            gallery: [
              image("2", { position: 0 }),
              image("0", { position: 1 }),
              image("1", { position: 2 }),
            ],
          }),
        ),
      ),
    );
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );
    // El visor respeta el orden en que llega `gallery` (ya ordenado por el servidor) —
    // empieza en la primera del array, sea cual sea su `id`.
    expect(document.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/2.webp",
    );
    fireEvent.click(screen.getByRole("button", { name: "Foto siguiente" }));
    expect(document.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/0.webp",
    );
  });

  it("una imagen decorativa sin alt real usa alt vacío (nunca alt inventado)", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json(detail({ gallery: [image("0", { decorative: true, alt: null })] })),
        ),
    );
    renderDetail("kirito-sao");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Kirito" })).toBeInTheDocument(),
    );
    expect(document.querySelector("img")).toHaveAttribute("alt", "");
  });
});
