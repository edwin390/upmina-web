import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { YouTubeVideo } from "@/types";
import YouTubeSection from "./YouTubeSection";
import { shortEmbedUrl } from "./youtubeUrl";

// Experiencia de Shorts de YouTube (9H-2.5): los videos largos comparten el reproductor principal;
// los Shorts tienen un visor vertical independiente. Ni un Short entra en el hero ni el hero cambia
// el Short elegido. Sin red real: fetch simulado.

const video = (id: string, title: string): YouTubeVideo => ({
  id,
  title,
  description: "",
  thumbnailUrl: `https://i.ytimg.com/vi/${id}/hq.jpg`,
  publishedAt: "2026-09-18T19:00:31Z",
  duration: "3:00",
});

const VIDEOS = ["VIDEOaaaaa1", "VIDEOaaaaa2", "VIDEOaaaaa3"].map((id, i) =>
  video(id, `Video ${i + 1}`),
);
const SHORTS = ["SHORTaaaaa1", "SHORTaaaaa2", "SHORTaaaaa3"].map((id, i) =>
  video(id, `Short ${i + 1}`),
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Api {
  latest: () => Response | Promise<Response>;
  videos: () => Response | Promise<Response>;
  shorts: () => Response | Promise<Response>;
}

function stubApi(overrides: Partial<Api> = {}) {
  const api: Api = {
    latest: () => json(VIDEOS[0]),
    videos: () => json(VIDEOS),
    shorts: () => json(SHORTS),
    ...overrides,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("youtube-latest")) return api.latest();
      if (url.includes("type=videos")) return api.videos();
      if (url.includes("type=shorts")) return api.shorts();
      return json({}, 404);
    }),
  );
}

function Probe() {
  const location = useLocation();
  return <output data-testid="url">{location.pathname + location.search}</output>;
}
const url = () => screen.getByTestId("url").textContent;

function renderSection(entry = "/youtube") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Probe />
        <Routes>
          <Route path="/youtube" element={<YouTubeSection />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const iframes = () => [...document.querySelectorAll<HTMLIFrameElement>("iframe")];
const heroFrame = () =>
  iframes().find((f) => f.title && !f.title.startsWith("Short de YouTube"));
const heroId = () => heroFrame()?.getAttribute("src")?.split("/embed/")[1];
const shortFrames = () => iframes().filter((f) => f.title.startsWith("Short de YouTube"));
const shortFrameId = () =>
  shortFrames()[0]?.getAttribute("src")?.split("/embed/")[1]?.split("?")[0];
const counter = (text: string) => screen.findByText(text);
const next = () => screen.getByRole("button", { name: "Short siguiente" });
const prev = () => screen.getByRole("button", { name: "Short anterior" });
const play = (title: string) =>
  fireEvent.click(screen.getByRole("button", { name: `Reproducir Short: ${title}` }));
const group = () => screen.getByRole("group", { name: "Shorts" });
const statusMessages = () =>
  screen.queryAllByRole("status").filter((el) => el.tagName !== "OUTPUT");
const UNAVAILABLE = /Este contenido ya no está disponible entre los más recientes\./;
const SHORTS_ERROR = /No se pudieron cargar los Shorts de YouTube ahora mismo/;
const VIDEOS_ERROR = /No se pudieron cargar los videos de YouTube ahora mismo/;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("videos largos: reproductor principal", () => {
  it("el último video largo se reproduce en el reproductor principal", async () => {
    stubApi();
    renderSection();

    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa1"));
    expect(shortFrames()).toHaveLength(0);
  });

  it("una tarjeta de 'Más videos' cambia el reproductor principal", async () => {
    stubApi();
    renderSection();
    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa1"));

    fireEvent.click(screen.getByRole("button", { name: /Video 3/ }));

    expect(heroId()).toBe("VIDEOaaaaa3");
    expect(url()).toBe("/youtube?video=VIDEOaaaaa3");
  });

  it("'Más videos' contiene solo videos largos (ninguna tarjeta de Short)", async () => {
    stubApi();
    renderSection();
    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa1"));

    const cards = screen.getAllByRole("button", { name: /^Video \d/ });
    expect(cards).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /^Short \d/ })).toBeNull();
  });

  it("el último upload es un Short: NO entra en el hero; se destaca el primer video largo", async () => {
    stubApi({ latest: () => json(SHORTS[0]) });
    renderSection();

    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa1"));
    for (const f of iframes()) expect(f.src).not.toContain("SHORTaaaaa");
  });

  it("mientras no se sabe si el último upload es un Short no se monta ningún reproductor", async () => {
    let release: (value: Response) => void = () => {};
    stubApi({
      latest: () => json(SHORTS[0]),
      shorts: () => new Promise<Response>((resolve) => (release = resolve)),
    });
    renderSection();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(iframes()).toHaveLength(0);

    release(json(SHORTS));
    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa1"));
  });

  it("una consulta de Shorts lenta NO retrasa el reproductor principal cuando el último ya está en 'Más videos'", async () => {
    stubApi({ shorts: () => new Promise<Response>(() => {}) });
    renderSection();

    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa1"));
    expect(await screen.findByText("Cargando Shorts…")).toBeInTheDocument();
  });

  it("?video=<id de un Short> nunca se reproduce en el hero", async () => {
    stubApi();
    renderSection("/youtube?video=SHORTaaaaa2");

    expect(await counter("2 de 3")).toBeInTheDocument();
    expect(heroId()).toBe("VIDEOaaaaa1");
    for (const f of iframes()) expect(f.src).not.toContain("SHORTaaaaa");
  });
});

describe("Shorts: visor vertical independiente", () => {
  it("se pinta su propio grupo con encabezado, portada, título y contador", async () => {
    stubApi();
    renderSection();

    expect(await counter("1 de 3")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Shorts" })).toBeInTheDocument();
    expect(group()).toBeInTheDocument();
    expect(within(group()).getByText("Short 1")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reproducir Short: Short 1" }),
    ).toBeInTheDocument();
  });

  it("antes de reproducir NO hay iframe de Short (solo el del reproductor principal)", async () => {
    stubApi();
    renderSection();
    await counter("1 de 3");

    expect(shortFrames()).toHaveLength(0);
    expect(iframes()).toHaveLength(1);
  });

  it("reproducir monta UN iframe de YouTube del Short seleccionado, con título descriptivo", async () => {
    stubApi();
    renderSection();
    await counter("1 de 3");

    play("Short 1");

    expect(shortFrames()).toHaveLength(1);
    const frame = shortFrames()[0];
    expect(frame.title).toBe("Short de YouTube: Short 1");
    expect(frame.src).toBe(shortEmbedUrl("SHORTaaaaa1"));
    expect(frame.src.startsWith("https://www.youtube.com/embed/")).toBe(true);
    expect(heroId()).toBe("VIDEOaaaaa1");
  });

  it("presentación vertical 9:16 acotada (estructural, sin píxeles frágiles)", async () => {
    stubApi();
    renderSection();
    await counter("1 de 3");

    const frame = screen.getByTestId("short-frame");
    expect(frame.className).toContain("aspect-[9/16]");
    const column = frame.parentElement as HTMLElement;
    expect(column.className).toMatch(/max-w-\[\d+px\]/);
    expect(group().firstElementChild?.className).toContain("md:flex-row");
  });

  it("siguiente selecciona el Short siguiente; anterior, el anterior", async () => {
    stubApi();
    renderSection();
    await counter("1 de 3");

    fireEvent.click(next());
    expect(await counter("2 de 3")).toBeInTheDocument();
    expect(within(group()).getByText("Short 2")).toBeInTheDocument();

    fireEvent.click(next());
    expect(await counter("3 de 3")).toBeInTheDocument();

    fireEvent.click(prev());
    expect(await counter("2 de 3")).toBeInTheDocument();
  });

  it("límites: anterior en el primero va al último y siguiente en el último va al primero", async () => {
    stubApi();
    renderSection();
    await counter("1 de 3");

    fireEvent.click(prev());
    expect(await counter("3 de 3")).toBeInTheDocument();
    fireEvent.click(next());
    expect(await counter("1 de 3")).toBeInTheDocument();
  });

  it("un solo Short: la navegación queda deshabilitada y no hay lista", async () => {
    stubApi({ shorts: () => json([SHORTS[0]]) });
    renderSection();
    await counter("1 de 1");

    expect(prev()).toBeDisabled();
    expect(next()).toBeDisabled();
    expect(screen.queryByRole("list", { name: "Lista de Shorts" })).toBeNull();
  });

  it("la lista de miniaturas elige un Short y marca el actual", async () => {
    stubApi();
    renderSection();
    await counter("1 de 3");
    const list = screen.getByRole("list", { name: "Lista de Shorts" });

    fireEvent.click(within(list).getByRole("button", { name: "Ver Short: Short 3" }));

    expect(await counter("3 de 3")).toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: "Ver Short: Short 3" }),
    ).toHaveAttribute("aria-current", "true");
    expect(
      within(list).getByRole("button", { name: "Ver Short: Short 1" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("navegar reproduciendo desmonta el reproductor anterior: nunca hay dos Shorts activos", async () => {
    stubApi();
    renderSection();
    await counter("1 de 3");
    play("Short 1");
    const first = shortFrames()[0];

    fireEvent.click(next());
    await counter("2 de 3");

    expect(first.isConnected).toBe(false);
    expect(shortFrames()).toHaveLength(1);
    expect(shortFrameId()).toBe("SHORTaaaaa2");

    fireEvent.click(next());
    fireEvent.click(prev());
    fireEvent.click(prev());
    expect(shortFrames()).toHaveLength(1);
    expect(shortFrameId()).toBe("SHORTaaaaa1");
    // Nunca más iframes que el principal + uno de Short.
    expect(iframes()).toHaveLength(2);
  });

  it("sin haber pulsado Reproducir, navegar no monta ningún reproductor", async () => {
    stubApi();
    renderSection();
    await counter("1 de 3");

    fireEvent.click(next());
    fireEvent.click(next());

    expect(shortFrames()).toHaveLength(0);
  });
});

describe("independencia entre el reproductor principal y los Shorts", () => {
  it("elegir un Short NO cambia el reproductor principal ni la URL", async () => {
    stubApi();
    renderSection("/youtube?video=VIDEOaaaaa3");
    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa3"));
    await counter("1 de 3");

    fireEvent.click(next());
    fireEvent.click(screen.getByRole("button", { name: "Ver Short: Short 3" }));
    play("Short 3");

    expect(heroId()).toBe("VIDEOaaaaa3");
    expect(url()).toBe("/youtube?video=VIDEOaaaaa3");
  });

  it("elegir un video largo NO cambia el Short seleccionado ni su reproductor", async () => {
    stubApi();
    renderSection();
    await counter("1 de 3");
    fireEvent.click(next());
    await counter("2 de 3");
    play("Short 2");
    const before = shortFrames()[0];

    fireEvent.click(screen.getByRole("button", { name: /Video 2/ }));

    expect(heroId()).toBe("VIDEOaaaaa2");
    expect(screen.getByText("2 de 3")).toBeInTheDocument();
    expect(shortFrameId()).toBe("SHORTaaaaa2");
    expect(before.isConnected).toBe(true);
    expect(shortFrames()).toHaveLength(1);
  });
});

describe("carga, vacío y fallo aislados", () => {
  it("cargando: texto de carga de Shorts (sin error ni vacío)", async () => {
    stubApi({ shorts: () => new Promise<Response>(() => {}) });
    renderSection();

    expect(await screen.findByText("Cargando Shorts…")).toBeInTheDocument();
    expect(screen.queryByText(SHORTS_ERROR)).toBeNull();
    expect(screen.queryByRole("group", { name: "Shorts" })).toBeNull();
  });

  it("vacío válido: no se pinta el grupo y no hay falso error", async () => {
    stubApi({ shorts: () => json([]) });
    renderSection();

    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa1"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByRole("heading", { name: "Shorts" })).toBeNull();
    expect(statusMessages()).toHaveLength(0);
  });

  it("fallo de Shorts: aviso propio; el reproductor principal y los videos siguen intactos", async () => {
    stubApi({ shorts: () => json({ error: "x" }, 502) });
    renderSection();

    expect(await screen.findByText(SHORTS_ERROR)).toBeInTheDocument();
    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa1"));
    fireEvent.click(screen.getByRole("button", { name: /Video 3/ }));
    expect(heroId()).toBe("VIDEOaaaaa3");
    expect(screen.queryByText(VIDEOS_ERROR)).toBeNull();
  });

  it("fallo de videos largos: el visor de Shorts sigue funcionando", async () => {
    stubApi({ videos: () => json({ error: "x" }, 502) });
    renderSection();

    expect(await screen.findByText(VIDEOS_ERROR)).toBeInTheDocument();
    await counter("1 de 3");
    fireEvent.click(next());
    expect(await counter("2 de 3")).toBeInTheDocument();
    play("Short 2");
    expect(shortFrameId()).toBe("SHORTaaaaa2");
  });

  it("fallo del último video: los Shorts siguen funcionando", async () => {
    stubApi({ latest: () => json({ error: "x" }, 502) });
    renderSection();

    await counter("1 de 3");
    fireEvent.click(next());
    expect(await counter("2 de 3")).toBeInTheDocument();
  });

  it("un Short con id no válido nunca llega a un reproductor ni a la lista", async () => {
    stubApi({ shorts: () => json([video("bad", "Malo"), SHORTS[0]]) });
    renderSection();

    expect(await counter("1 de 1")).toBeInTheDocument();
    expect(screen.queryByText("Malo")).toBeNull();
    expect(screen.queryByRole("button", { name: /Malo/ })).toBeNull();
  });

  it("solo ids no válidos: no se pinta un encabezado huérfano", async () => {
    stubApi({ shorts: () => json([video("bad", "Malo")]) });
    renderSection();

    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa1"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByRole("heading", { name: "Shorts" })).toBeNull();
  });
});

describe("enlaces a un Short", () => {
  const scrollSpy = vi.fn();

  beforeEach(() => {
    scrollSpy.mockReset();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollSpy,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("?short=<id>: elige ese Short en su visor, no toca el hero y retira el parámetro", async () => {
    stubApi();
    renderSection("/youtube?short=SHORTaaaaa3");

    expect(await counter("3 de 3")).toBeInTheDocument();
    await waitFor(() => expect(url()).toBe("/youtube"));
    expect(heroId()).toBe("VIDEOaaaaa1");
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    expect(scrollSpy).toHaveBeenCalled();
  });

  it("?short= conserva ?video= y los demás parámetros", async () => {
    stubApi();
    renderSection("/youtube?utm=a&video=VIDEOaaaaa2&short=SHORTaaaaa2");

    expect(await counter("2 de 3")).toBeInTheDocument();
    await waitFor(() => expect(url()).toContain("video=VIDEOaaaaa2"));
    expect(url()).toContain("utm=a");
    expect(url()).not.toContain("short=");
    expect(heroId()).toBe("VIDEOaaaaa2");
  });

  it.each(["ABC", "no-es-un-id!!", "SHORTaaaaa9"])(
    "?short=%s (inválido o desconocido): aviso, parámetro retirado y selección intacta",
    async (id) => {
      stubApi();
      renderSection(`/youtube?short=${id}`);

      expect(await screen.findByText(UNAVAILABLE)).toBeInTheDocument();
      await waitFor(() => expect(url()).toBe("/youtube"));
      expect(await counter("1 de 3")).toBeInTheDocument();
    },
  );

  it("mientras los Shorts cargan o si fallan, ?short= se conserva (fallo temporal)", async () => {
    stubApi({ shorts: () => json({ error: "x" }, 502) });
    renderSection("/youtube?short=SHORTaaaaa2");

    await screen.findByText(SHORTS_ERROR);
    expect(url()).toBe("/youtube?short=SHORTaaaaa2");
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
  });
});

describe("accesibilidad", () => {
  it("los controles tienen nombre accesible y son botones nativos operables con teclado", async () => {
    stubApi();
    renderSection();
    await counter("1 de 3");

    for (const button of [prev(), next()]) {
      expect(button.tagName).toBe("BUTTON");
      expect(button).toHaveAttribute("type", "button");
      expect(button.tabIndex).not.toBe(-1);
      button.focus();
      expect(document.activeElement).toBe(button);
    }
    expect(
      screen.getByRole("button", { name: "Reproducir Short: Short 1" }).tagName,
    ).toBe("BUTTON");
  });

  it("flechas izquierda/derecha navegan; otras teclas y combinaciones no", async () => {
    stubApi();
    renderSection();
    await counter("1 de 3");

    fireEvent.keyDown(next(), { key: "ArrowRight" });
    expect(await counter("2 de 3")).toBeInTheDocument();
    fireEvent.keyDown(next(), { key: "ArrowLeft" });
    expect(await counter("1 de 3")).toBeInTheDocument();

    fireEvent.keyDown(next(), { key: "ArrowDown" });
    fireEvent.keyDown(next(), { key: "ArrowUp" });
    fireEvent.keyDown(next(), { key: "ArrowRight", ctrlKey: true });
    fireEvent.keyDown(next(), { key: "ArrowRight", altKey: true });
    expect(screen.getByText("1 de 3")).toBeInTheDocument();
  });

  it("las flechas verticales no se interceptan (no se secuestra el scroll de la página)", async () => {
    stubApi();
    renderSection();
    await counter("1 de 3");

    const notPrevented = fireEvent.keyDown(next(), { key: "ArrowDown" });

    expect(notPrevented).toBe(true);
  });

  it("nombres con el título: portada, iframe y miniaturas", async () => {
    stubApi();
    renderSection();
    await counter("1 de 3");

    expect(
      screen.getByRole("button", { name: "Reproducir Short: Short 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Ver Short: Short 2" }),
    ).toBeInTheDocument();
    play("Short 1");
    expect(screen.getByTitle("Short de YouTube: Short 1")).toBeInTheDocument();
  });

  it("el contador es una región educada y el grupo se nombra por su encabezado", async () => {
    stubApi();
    renderSection();

    const count = await counter("1 de 3");
    expect(count).toHaveAttribute("aria-live", "polite");
    expect(group()).toHaveAccessibleName("Shorts");
  });

  it("foco visible y movimiento reducido (contrato estructural)", async () => {
    stubApi();
    renderSection();
    await counter("1 de 3");

    for (const button of [prev(), next()]) {
      expect(button.className).toContain("focus-visible:ring-2");
      expect(button.className).toContain("motion-reduce:transition-none");
    }
    const thumb = screen.getByRole("button", { name: "Ver Short: Short 2" });
    expect(thumb.className).toContain("focus-visible:ring-2");
  });

  it("sin trampas de teclado ni tabindex positivos", async () => {
    stubApi();
    renderSection();
    await counter("1 de 3");

    const positive = [...document.querySelectorAll("[tabindex]")].filter(
      (el) => Number(el.getAttribute("tabindex")) > 0,
    );
    expect(positive).toHaveLength(0);
  });

  it("móvil: la lista de miniaturas desplaza en horizontal DENTRO de su contenedor (sin desbordar la página)", async () => {
    stubApi();
    renderSection();
    await counter("1 de 3");

    const list = screen.getByRole("list", { name: "Lista de Shorts" });
    expect(list.className).toContain("overflow-x-auto");
    expect(list.className).toContain("max-w-full");
    expect(list.className).toContain("md:flex-wrap");
  });
});
