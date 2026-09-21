import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router-dom";
import type { TwitchClip } from "@/types";
import TwitchSection from "./TwitchSection";
import TwitchClipPlayer, { PLAYER_LOAD_TIMEOUT_MS } from "./TwitchClipPlayer";
import { SWIPE_THRESHOLD_PX } from "./TwitchClipViewer";
import { safeTwitchUrl, twitchClipEmbedUrl } from "./twitchUrl";

// Fijan la presentación de los clips (tarjetas con miniatura, SIN iframe) y el visor interno:
// un único reproductor a la vez, navegación circular por teclado/botones/swipe, cierre,
// foco, bloqueo de scroll y desmontaje total. jsdom no implementa <dialog>.showModal: se simula.

const THUMB = "https://static-cdn.jtvnw.net/twitch-video-assets/x/landscape/thumb/thumb";

function clip(n: number, overrides: Partial<TwitchClip> = {}): TwitchClip {
  return {
    id: `Clip${n}-abc`,
    url: `https://www.twitch.tv/upminaa/clip/Clip${n}-abc`,
    title: `Clip ${n}`,
    creatorName: `creador${n}`,
    embedUrl: `https://clips.twitch.tv/embed?clip=Clip${n}-abc`,
    thumbnailUrl: `${THUMB}-${n}-480x272.jpg`,
    viewCount: n,
    createdAt: "2026-09-18T19:00:31Z",
    ...overrides,
  };
}

const FEED = Array.from({ length: 12 }, (_, i) => clip(i + 1));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function stubApi(clips: () => Response | Promise<Response> = () => json(FEED)) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("twitch-clips")) return clips();
    if (url.includes("twitch-status")) return json({ isLive: false, channel: "upminaa" });
    if (url.includes("twitch-latest-video")) {
      return json({
        id: "123",
        url: "https://www.twitch.tv/videos/123",
        title: "Último stream",
        createdAt: "2026-09-18T19:00:31Z",
        duration: "1h2m3s",
      });
    }
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// La selección vive en la URL (?clip=): cada test renderiza bajo un MemoryRouter con un probe que
// expone la ubicación, el tipo de la última navegación (PUSH/REPLACE) y un botón "atrás".
function RouterProbe() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  return (
    <div>
      <output data-testid="url">{location.pathname + location.search}</output>
      <output data-testid="navtype">{navigationType}</output>
      <button type="button" onClick={() => navigate(-1)}>
        __atrás
      </button>
    </div>
  );
}
const url = () => screen.getByTestId("url").textContent;
const navType = () => screen.getByTestId("navtype").textContent;
const goBack = () => fireEvent.click(screen.getByRole("button", { name: "__atrás" }));

function renderSection(entries: string[] = ["/twitch"], initialIndex?: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={entries} initialIndex={initialIndex}>
        <RouterProbe />
        <Routes>
          <Route path="/" element={<p>Inicio</p>} />
          <Route path="/twitch" element={<TwitchSection />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

const cardButton = (title: string) =>
  screen.findByRole("button", { name: `Reproducir clip: ${title}` });

async function openViewer(title = "Clip 1") {
  const card = await cardButton(title);
  fireEvent.click(card);
  return { card, dialog: await screen.findByRole("dialog") };
}

const viewerTitle = () => screen.getByRole("dialog").querySelector("h2")?.textContent;
const key = (k: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document, { key: k, ...init });
// Iframes de CLIPS (el reproductor principal de Twitch es otro iframe distinto).
const clipIframes = () => document.querySelectorAll("iframe[src*='clips.twitch.tv']");

function swipe(from: number, to: number, dy = 0, target?: Element) {
  const el =
    target ??
    screen.getByRole("dialog").querySelector("img") ??
    screen.getByRole("dialog");
  fireEvent.touchStart(el, { touches: [{ clientX: from, clientY: 300 }] });
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: to, clientY: 300 + dy }] });
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.style.overflow = "";
});

describe("TwitchSection: tarjetas de clips", () => {
  it("12 clips = 12 tarjetas con miniatura y 0 iframes de clips", async () => {
    const fetchMock = stubApi();
    renderSection();

    const cards = await screen.findAllByRole("button", { name: /^Reproducir clip:/ });
    expect(cards).toHaveLength(12);
    expect(clipIframes()).toHaveLength(0);
    // Solo queda el reproductor principal (último stream); ningún iframe por clip.
    await waitFor(() => expect(document.querySelectorAll("iframe")).toHaveLength(1));
    expect(document.querySelector("iframe")?.getAttribute("src")).toContain(
      "player.twitch.tv",
    );
    for (const [i, card] of cards.entries()) {
      const img = card.querySelector("img");
      expect(img?.getAttribute("src")).toBe(`${THUMB}-${i + 1}-480x272.jpg`);
      expect(img?.className).toContain("object-cover");
      expect(card.className).toContain("aspect-video");
      expect(card.getAttribute("aria-haspopup")).toBe("dialog");
      expect(card.querySelector("svg")).not.toBeNull(); // indicador de reproducción
    }
    // /twitch-clips se pide una sola vez (status, último vídeo y clips: 3 peticiones en total).
    expect(
      fetchMock.mock.calls.filter(([u]) => String(u).includes("clips")),
    ).toHaveLength(1);
  });

  it("conserva todos los metadatos: título, creador, vistas, fecha y 'Ver en Twitch'", async () => {
    stubApi(() =>
      json([
        clip(1, {
          viewCount: 1,
          createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
        }),
        clip(2, { viewCount: 1234 }),
      ]),
    );
    renderSection();

    const card = (await cardButton("Clip 1")).parentElement as HTMLElement;
    expect(within(card).getByText("Clip 1")).toBeTruthy();
    expect(card.textContent).toContain("creador1 · 1 vista · hace 3 horas");
    const link = within(card).getByRole("link", { name: "Ver en Twitch" });
    expect(link.getAttribute("href")).toBe(
      "https://www.twitch.tv/upminaa/clip/Clip1-abc",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText(/creador2 · 1\.?234 vistas/)).toBeTruthy();
  });

  it("no enlaza a una URL de clip que no sea https de twitch.tv", async () => {
    stubApi(() => json([clip(1, { url: "javascript:alert(1)" })]));
    renderSection();
    const card = (await cardButton("Clip 1")).parentElement as HTMLElement;
    expect(within(card).queryByRole("link")).toBeNull();
  });

  it("si la miniatura falla usa un fondo degradado y la tarjeta sigue abriendo el visor", async () => {
    stubApi();
    renderSection();
    const card = await cardButton("Clip 1");
    fireEvent.error(card.querySelector("img")!);

    await waitFor(() => expect(card.querySelector("img")).toBeNull());
    fireEvent.click(card);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("mantiene la rejilla responsive y los estados de carga, vacío y error", async () => {
    stubApi(() => json([]));
    let view = renderSection();
    expect(screen.getByText("Cargando clips…")).toBeTruthy();
    expect(await screen.findByText("Todavía no hay clips disponibles.")).toBeTruthy();
    view.unmount();

    stubApi(() => json({ error: "x" }, 502));
    view = renderSection();
    expect(await screen.findByText(/No se pudieron cargar los clips/)).toBeTruthy();
    view.unmount();

    stubApi();
    const { container } = renderSection();
    await screen.findAllByRole("button", { name: /^Reproducir clip:/ });
    const grid = container.querySelector("div.grid.grid-cols-1");
    expect(grid?.className).toContain("sm:grid-cols-2");
    expect(grid?.className).toContain("lg:grid-cols-3");
  });
});

describe("TwitchSection: reproductor principal (sin cambios)", () => {
  it("offline: reproduce dentro de la web el último stream grabado (VOD)", async () => {
    stubApi();
    renderSection();

    const player = await screen.findByTitle("Último stream de Twitch");
    expect(player.getAttribute("src")).toBe(
      "https://player.twitch.tv/?video=123&parent=localhost&muted=true",
    );
  });

  it("en directo: reproduce el canal en vivo dentro de la web", async () => {
    stubApi();
    const base = vi.mocked(fetch);
    vi.stubGlobal("fetch", (input: RequestInfo | URL) =>
      String(input).includes("twitch-status")
        ? Promise.resolve(json({ isLive: true, channel: "upminaa", title: "Directo" }))
        : base(input),
    );
    renderSection();

    const player = await screen.findByTitle("Directo de Twitch");
    expect(player.getAttribute("src")).toBe(
      "https://player.twitch.tv/?channel=upminaa&parent=localhost&muted=true",
    );
  });
});

describe("TwitchClipViewer: apertura, un único iframe y cierre", () => {
  it("clic abre el visor interno con exactamente 1 iframe de clip (NO abre twitch.tv)", async () => {
    stubApi();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderSection();
    await screen.findAllByRole("button", { name: /^Reproducir clip:/ });
    expect(clipIframes()).toHaveLength(0);

    const { dialog } = await openViewer("Clip 3");

    expect(dialog.hasAttribute("open")).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(clipIframes()).toHaveLength(1);
    expect(dialog.querySelectorAll("iframe")).toHaveLength(1);
    const frame = dialog.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(
      "https://clips.twitch.tv/embed?clip=Clip3-abc&parent=localhost",
    );
    expect(frame.getAttribute("src")).not.toContain("autoplay");
    expect(frame.getAttribute("allow")).not.toContain("autoplay");
    expect(frame.getAttribute("allow")).toContain("fullscreen");
    expect(frame.getAttribute("title")).toBe("Clip de Twitch: Clip 3");
    expect(viewerTitle()).toBe("Clip 3");
    expect(dialog.textContent).toContain("Clip 3 de 12");
    expect(within(dialog).getByRole("link", { name: /Ver en Twitch/ })).toBeTruthy();
  });

  it("cambiar de clip mantiene exactamente 1 iframe: el anterior se desmonta", async () => {
    stubApi();
    renderSection();
    await openViewer("Clip 1");

    const seen: HTMLIFrameElement[] = [];
    for (let i = 0; i < 5; i++) {
      seen.push(clipIframes()[0] as HTMLIFrameElement);
      key("ArrowRight");
      expect(clipIframes()).toHaveLength(1);
    }
    fireEvent.click(screen.getByRole("button", { name: "Clip siguiente" }));
    expect(clipIframes()).toHaveLength(1);
    // Ningún iframe anterior sigue en el documento.
    expect(seen.every((frame) => !frame.isConnected)).toBe(true);
    expect(viewerTitle()).toBe("Clip 7");
    expect(clipIframes()[0].getAttribute("src")).toContain("clip=Clip7-abc");
  });

  it("cerrar deja 0 iframes de clip (botón X, Escape y clic en el fondo)", async () => {
    stubApi();
    renderSection();

    await openViewer("Clip 2");
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(clipIframes()).toHaveLength(0);

    await openViewer("Clip 2");
    key("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(clipIframes()).toHaveLength(0);

    const { dialog } = await openViewer("Clip 2");
    const cover = dialog.querySelector("iframe") as HTMLElement;
    fireEvent.mouseDown(cover);
    fireEvent.click(cover);
    expect(screen.queryByRole("dialog")).not.toBeNull(); // dentro del contenido: no cierra
    const backdrop = dialog.querySelector("[data-tw-backdrop]") as HTMLElement;
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(clipIframes()).toHaveLength(0);
  });

  it("no precarga reproductores vecinos: solo miniaturas de anterior y siguiente", async () => {
    stubApi();
    const preloaded: string[] = [];
    class FakeImage {
      set src(value: string) {
        preloaded.push(value);
      }
    }
    vi.stubGlobal("Image", FakeImage);
    renderSection();

    await openViewer("Clip 1");

    expect(clipIframes()).toHaveLength(1);
    expect(preloaded.sort()).toEqual(
      [`${THUMB}-2-480x272.jpg`, `${THUMB}-12-480x272.jpg`].sort(),
    );
  });

  it("el reproductor solo pide el clip a Twitch al abrir y no hace peticiones extra a la API", async () => {
    const fetchMock = stubApi();
    renderSection();
    await openViewer("Clip 1");
    const calls = fetchMock.mock.calls.length;
    key("ArrowRight");
    key("ArrowRight");
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });
});

describe("TwitchClipViewer: navegación circular", () => {
  it("→ siguiente y ← anterior en el mismo visor (sin cerrar ni reabrir)", async () => {
    stubApi();
    renderSection();
    const { dialog } = await openViewer("Clip 2");

    key("ArrowRight");
    expect(viewerTitle()).toBe("Clip 3");
    expect(screen.getByRole("dialog")).toBe(dialog);
    key("ArrowLeft");
    key("ArrowLeft");
    expect(viewerTitle()).toBe("Clip 1");
    expect(dialog.hasAttribute("open")).toBe(true);
  });

  it("es circular: último → primero; primero → último", async () => {
    stubApi();
    renderSection();
    await openViewer("Clip 12");

    key("ArrowRight");
    expect(viewerTitle()).toBe("Clip 1");
    expect(screen.getByText("1 / 12", { selector: "p.hidden" })).toBeTruthy();
    key("ArrowLeft");
    expect(viewerTitle()).toBe("Clip 12");
  });

  it("los botones ← y → navegan igual (circular) y tienen nombre accesible", async () => {
    stubApi();
    renderSection();
    await openViewer("Clip 1");

    fireEvent.click(screen.getByRole("button", { name: "Clip anterior" }));
    expect(viewerTitle()).toBe("Clip 12");
    fireEvent.click(screen.getByRole("button", { name: "Clip siguiente" }));
    fireEvent.click(screen.getByRole("button", { name: "Clip siguiente" }));
    expect(viewerTitle()).toBe("Clip 2");
  });

  it("↑/↓ NO navegan; tampoco con modificadores, tecla mantenida ni dentro de un input", async () => {
    stubApi();
    renderSection();
    await openViewer("Clip 2");

    key("ArrowUp");
    key("ArrowDown");
    key("ArrowRight", { ctrlKey: true });
    key("ArrowRight", { shiftKey: true });
    key("ArrowRight", { repeat: true });
    expect(viewerTitle()).toBe("Clip 2");
    expect(fireEvent.keyDown(document, { key: "ArrowRight" })).toBe(false); // evita el scroll nativo
  });

  it("con un solo clip no hay botones ← / → y las flechas y swipes no hacen nada", async () => {
    stubApi(() => json([clip(1)]));
    renderSection();
    await openViewer("Clip 1");

    expect(screen.queryByRole("button", { name: "Clip siguiente" })).toBeNull();
    key("ArrowRight");
    swipe(300, 100);
    expect(viewerTitle()).toBe("Clip 1");
    expect(clipIframes()).toHaveLength(1);
  });
});

describe("TwitchClipViewer: swipe horizontal (táctil)", () => {
  it("hacia la IZQUIERDA → siguiente; hacia la DERECHA → anterior; circular", async () => {
    stubApi();
    renderSection();
    await openViewer("Clip 1");

    swipe(300, 180); // izquierda
    expect(viewerTitle()).toBe("Clip 2");
    swipe(180, 300); // derecha
    swipe(180, 300);
    expect(viewerTitle()).toBe("Clip 12");
    expect(clipIframes()).toHaveLength(1);
  });

  it("recorrido corto, diagonal o vertical no cambian de clip", async () => {
    stubApi();
    renderSection();
    await openViewer("Clip 2");

    swipe(300, 300 - (SWIPE_THRESHOLD_PX - 5));
    swipe(300, 200, 90); // diagonal: |dx| < 1,5 × |dy|
    swipe(300, 300, -200); // vertical
    expect(viewerTitle()).toBe("Clip 2");
  });

  it("funciona sobre las franjas laterales transparentes que cubren el iframe (táctil)", async () => {
    stubApi();
    renderSection();
    const { dialog } = await openViewer("Clip 1");

    const zones = dialog.querySelectorAll("[data-tw-swipe-zone]");
    expect(zones).toHaveLength(2);
    for (const zone of zones) expect(zone.className).toContain("touch-none");
    swipe(300, 150, 0, zones[0]);
    expect(viewerTitle()).toBe("Clip 2");
    // El centro del reproductor no lo cubre ninguna capa: sigue siendo interactuable.
    const frame = dialog.querySelector("iframe") as HTMLElement;
    const overlays = [...(frame.parentElement?.children ?? [])].filter(
      (el) => el !== frame && el.tagName === "DIV",
    );
    expect(overlays.every((el) => el.className.includes("w-[14%]"))).toBe(true);
  });
});

describe("TwitchClipViewer: accesibilidad, foco y scroll", () => {
  it("es un <dialog> modal etiquetado por el título del clip, con anuncio de posición", async () => {
    stubApi();
    renderSection();
    const { dialog } = await openViewer("Clip 4");

    expect(dialog.tagName).toBe("DIALOG");
    const labelledBy = dialog.getAttribute("aria-labelledby") as string;
    expect(document.getElementById(labelledBy)?.textContent).toBe("Clip 4");
    expect(dialog.querySelector("[aria-live='polite']")?.textContent).toBe(
      "Clip 4 de 12",
    );
    key("ArrowRight");
    expect(dialog.querySelector("[aria-live='polite']")?.textContent).toBe(
      "Clip 5 de 12",
    );
  });

  it("foco inicial en Cerrar y, al cerrar, vuelve a la tarjeta que lo abrió", async () => {
    stubApi();
    renderSection();
    const { card } = await openViewer("Clip 5");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cerrar" }));

    key("ArrowRight"); // navegar no cambia la tarjeta de retorno
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));

    await waitFor(() => expect(document.activeElement).toBe(card));
  });

  it("si el iframe (otro origen) se queda con el foco, el visor lo recupera para el teclado", async () => {
    stubApi();
    renderSection();
    const { dialog } = await openViewer("Clip 1");
    const frame = dialog.querySelector("iframe") as HTMLIFrameElement;

    frame.focus();
    expect(document.activeElement).toBe(frame);
    window.dispatchEvent(new Event("blur"));

    await waitFor(() => expect(document.activeElement).toBe(dialog));
  });

  it("bloquea el scroll del documento mientras está abierto y lo restaura al cerrar", async () => {
    stubApi();
    renderSection();
    document.body.style.overflow = "scroll";
    await openViewer("Clip 1");
    expect(document.body.style.overflow).toBe("hidden");

    key("ArrowRight"); // navegar no toca el bloqueo
    expect(document.body.style.overflow).toBe("hidden");
    key("Escape");
    expect(document.body.style.overflow).toBe("scroll");
  });
});

describe("Salir de /twitch: desmontaje real", () => {
  it("con el visor abierto, desmontar la sección deja 0 iframes, sin scroll bloqueado ni listeners", async () => {
    stubApi();
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    const winAdded = vi.spyOn(window, "addEventListener");
    const winRemoved = vi.spyOn(window, "removeEventListener");
    const view = renderSection();
    await openViewer("Clip 1");
    expect(document.querySelectorAll("iframe").length).toBeGreaterThan(1); // principal + clip

    view.unmount();

    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    const count = (spy: ReturnType<typeof vi.spyOn>, type: string) =>
      spy.mock.calls.filter(([t]) => t === type).length;
    expect(count(removed, "keydown")).toBe(count(added, "keydown"));
    expect(count(winRemoved, "blur")).toBe(count(winAdded, "blur"));
  });

  it("sin visor, la sección desmontada no deja ningún iframe", async () => {
    stubApi();
    const view = renderSection();
    await screen.findAllByRole("button", { name: /^Reproducir clip:/ });
    await waitFor(() => expect(document.querySelectorAll("iframe")).toHaveLength(1));

    view.unmount();

    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });
});

describe("TwitchClipPlayer", () => {
  afterEach(() => vi.useRealTimers());

  it("muestra la miniatura hasta que el iframe carga", () => {
    const { container } = render(<TwitchClipPlayer clip={clip(1)} />);
    expect(container.querySelector("img")).not.toBeNull();
    fireEvent.load(container.querySelector("iframe")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("iframe")?.className).toContain("opacity-100");
  });

  it("si no carga en el tiempo límite, quita el iframe y ofrece verlo en Twitch", () => {
    vi.useFakeTimers();
    const { container } = render(<TwitchClipPlayer clip={clip(1)} />);
    expect(container.querySelectorAll("iframe")).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(PLAYER_LOAD_TIMEOUT_MS);
    });

    expect(container.querySelectorAll("iframe")).toHaveLength(0);
    expect(container.querySelector("img")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Puedes verlo en Twitch/);
  });

  it("desmontar cancela el temporizador de carga", () => {
    vi.useFakeTimers();
    const { unmount } = render(<TwitchClipPlayer clip={clip(1)} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("URLs de Twitch", () => {
  it("safeTwitchUrl solo admite https en twitch.tv y subdominios", () => {
    expect(safeTwitchUrl("https://www.twitch.tv/upminaa/clip/x")).toBe(
      "https://www.twitch.tv/upminaa/clip/x",
    );
    expect(safeTwitchUrl("https://twitch.tv/upminaa")).toBeTruthy();
    expect(safeTwitchUrl("http://www.twitch.tv/upminaa")).toBeUndefined();
    expect(safeTwitchUrl("https://twitch.tv.evil.com/x")).toBeUndefined();
    expect(safeTwitchUrl("https://evil.com/twitch.tv")).toBeUndefined();
    expect(safeTwitchUrl("https://nottwitch.tv/x")).toBeUndefined();
    expect(safeTwitchUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeTwitchUrl("")).toBeUndefined();
  });

  it("twitchClipEmbedUrl usa el embed oficial con parent y SIN autoplay, y reconstruye si no es oficial", () => {
    expect(
      twitchClipEmbedUrl(
        { id: "A", embedUrl: "https://clips.twitch.tv/embed?clip=A" },
        "upmina-web.vercel.app",
      ),
    ).toBe("https://clips.twitch.tv/embed?clip=A&parent=upmina-web.vercel.app");
    for (const bad of [
      "https://evil.com/embed?clip=A",
      "http://clips.twitch.tv/embed?clip=A",
      "",
    ]) {
      expect(twitchClipEmbedUrl({ id: "A/B", embedUrl: bad }, "localhost")).toBe(
        "https://clips.twitch.tv/embed?clip=A%2FB&parent=localhost",
      );
    }
  });
});

// ---------- Deep links: /twitch?clip=<id> (la URL es la única fuente de verdad) ----------

const UNAVAILABLE = /Este contenido ya no está disponible entre los más recientes\./;
const noticeVisible = () => screen.queryByText(UNAVAILABLE) !== null;

describe("Deep link /twitch?clip=<id>", () => {
  it("sin parámetro: 0 iframes de clips, sin visor ni aviso, y la URL no cambia", async () => {
    stubApi();
    renderSection(["/twitch"]);
    await screen.findAllByRole("button", { name: /^Reproducir clip:/ });

    expect(clipIframes()).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(noticeVisible()).toBe(false);
    expect(url()).toBe("/twitch");
    expect(navType()).toBe("POP");
  });

  it("abre el visor con exactamente ese clip (1 iframe, autoplay OFF) al cargar la URL", async () => {
    stubApi();
    renderSection(["/twitch?clip=Clip3-abc"]);

    const dialog = await screen.findByRole("dialog");
    expect(viewerTitle()).toBe("Clip 3");
    expect(clipIframes()).toHaveLength(1);
    const frame = dialog.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(
      "https://clips.twitch.tv/embed?clip=Clip3-abc&parent=localhost",
    );
    expect(frame.getAttribute("src")).not.toContain("autoplay");
    expect(url()).toBe("/twitch?clip=Clip3-abc");
    expect(noticeVisible()).toBe(false);
  });

  it("recargar o pegar la URL en otra pestaña abre el mismo clip (montaje nuevo)", async () => {
    stubApi();
    const first = renderSection(["/twitch?clip=Clip2-abc"]);
    await screen.findByRole("dialog");
    key("ArrowRight");
    key("ArrowRight");
    expect(url()).toBe("/twitch?clip=Clip4-abc");
    const lastUrl = url() as string;
    first.unmount();

    // "Recarga": se monta de cero con la URL que quedó.
    renderSection([lastUrl]);
    await screen.findByRole("dialog");
    expect(viewerTitle()).toBe("Clip 4");
    expect(clipIframes()).toHaveLength(1);
  });

  it("anterior/siguiente actualizan ?clip= con REPLACE, también en modo circular", async () => {
    stubApi();
    renderSection(["/twitch?clip=Clip12-abc"]);
    await screen.findByRole("dialog");

    key("ArrowRight");
    expect(url()).toBe("/twitch?clip=Clip1-abc");
    expect(navType()).toBe("REPLACE");
    expect(viewerTitle()).toBe("Clip 1");
    key("ArrowLeft");
    expect(url()).toBe("/twitch?clip=Clip12-abc");
    fireEvent.click(screen.getByRole("button", { name: "Clip siguiente" }));
    expect(url()).toBe("/twitch?clip=Clip1-abc");
    fireEvent.click(screen.getByRole("button", { name: "Clip anterior" }));
    expect(url()).toBe("/twitch?clip=Clip12-abc");
    swipe(300, 150);
    expect(url()).toBe("/twitch?clip=Clip1-abc");
    expect(clipIframes()).toHaveLength(1);
  });

  it("abrir por tarjeta pone ?clip= (REPLACE) y cerrar con X o Escape lo elimina (REPLACE)", async () => {
    stubApi();
    renderSection(["/twitch"]);

    await openViewer("Clip 5");
    expect(url()).toBe("/twitch?clip=Clip5-abc");
    expect(navType()).toBe("REPLACE");

    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(url()).toBe("/twitch");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(clipIframes()).toHaveLength(0);
    expect(navType()).toBe("REPLACE");

    await openViewer("Clip 6");
    key("Escape");
    expect(url()).toBe("/twitch");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(clipIframes()).toHaveLength(0);
  });

  it("los cambios internos no llenan el historial: Atrás vuelve a Home", async () => {
    stubApi();
    renderSection(["/", "/twitch?clip=Clip1-abc"], 1);
    await screen.findByRole("dialog");

    for (let i = 0; i < 5; i++) key("ArrowRight");
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    await openViewer("Clip 8");
    expect(url()).toBe("/twitch?clip=Clip8-abc");

    goBack();
    expect(url()).toBe("/");
    expect(screen.getByText("Inicio")).toBeTruthy();
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    expect(document.body.style.overflow).toBe("");
  });

  it("apertura por tarjeta: al cerrar el foco vuelve a la tarjeta (con la URL como fuente)", async () => {
    stubApi();
    renderSection(["/twitch"]);
    const { card } = await openViewer("Clip 2");

    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));

    await waitFor(() => expect(document.activeElement).toBe(card));
  });

  it("apertura directa (sin tarjeta que la abriera): cerrar no falla", async () => {
    stubApi();
    renderSection(["/twitch?clip=Clip2-abc"]);
    await screen.findByRole("dialog");

    key("Escape");
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(url()).toBe("/twitch");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("id malformado: aviso discreto, parámetro eliminado y sin visor", async () => {
    stubApi();
    renderSection(["/twitch?clip=../mal id"]);

    expect(await screen.findByText(UNAVAILABLE)).toBeTruthy();
    await waitFor(() => expect(url()).toBe("/twitch"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(clipIframes()).toHaveLength(0);
    // No bloquea nada: siguen las tarjetas.
    expect(
      await screen.findAllByRole("button", { name: /^Reproducir clip:/ }),
    ).toHaveLength(12);
    expect(navType()).toBe("REPLACE");
  });

  it("id válido pero fuera de los 12 actuales: aviso, parámetro eliminado y sin visor", async () => {
    stubApi();
    renderSection(["/twitch?clip=ViejoClipYaFuera-XYZ"]);

    expect(await screen.findByText(UNAVAILABLE)).toBeTruthy();
    await waitFor(() => expect(url()).toBe("/twitch"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(clipIframes()).toHaveLength(0);
    expect(document.body.style.overflow).toBe("");
  });

  it("mientras los clips cargan NO se limpia el parámetro; al llegar, se abre el clip", async () => {
    let release: (value: Response) => void = () => {};
    stubApi(() => new Promise<Response>((resolve) => (release = resolve)));
    renderSection(["/twitch?clip=Clip7-abc"]);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(url()).toBe("/twitch?clip=Clip7-abc");
    expect(noticeVisible()).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(navType()).toBe("POP");

    await act(async () => release(json(FEED)));
    await screen.findByRole("dialog");
    expect(viewerTitle()).toBe("Clip 7");
    expect(clipIframes()).toHaveLength(1);
  });

  it("si la consulta falla NO se destruye el deep link (fallo temporal)", async () => {
    stubApi(() => json({ error: "x" }, 502));
    renderSection(["/twitch?clip=Clip7-abc"]);

    expect(await screen.findByText(/No se pudieron cargar los clips/)).toBeTruthy();
    expect(url()).toBe("/twitch?clip=Clip7-abc");
    expect(noticeVisible()).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(navType()).toBe("POP");
  });

  it("conserva los demás parámetros al navegar y al cerrar", async () => {
    stubApi();
    renderSection(["/twitch?utm=a&clip=Clip2-abc&x=1"]);
    await screen.findByRole("dialog");

    key("ArrowRight");
    expect(new URLSearchParams(url()!.split("?")[1]).get("clip")).toBe("Clip3-abc");
    expect(url()).toContain("utm=a");
    expect(url()).toContain("x=1");
    key("Escape");
    expect(url()).toBe("/twitch?utm=a&x=1");
  });

  it("al limpiar un id no disponible también conserva los demás parámetros", async () => {
    stubApi();
    renderSection(["/twitch?a=1&clip=NoExiste123&b=2"]);
    await screen.findByText(UNAVAILABLE);
    await waitFor(() => expect(url()).toBe("/twitch?a=1&b=2"));
  });

  it("sin bucles: URL → selección → URL se estabiliza (una sola limpieza, sin errores)", async () => {
    stubApi();
    renderSection(["/twitch?clip=NoExiste123"]);
    await screen.findByText(UNAVAILABLE);
    await waitFor(() => expect(url()).toBe("/twitch"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(url()).toBe("/twitch");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("salir de /twitch con el visor abierto desmonta TODOS los iframes de Twitch", async () => {
    stubApi();
    renderSection(["/", "/twitch?clip=Clip1-abc"], 1);
    await screen.findByRole("dialog");
    await waitFor(() => expect(document.querySelectorAll("iframe").length).toBe(2)); // principal + clip

    goBack();

    expect(url()).toBe("/");
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
