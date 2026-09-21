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
import type { TikTokVideo } from "@/types";
import TikTokSection from "./TikTokSection";
import { PLAYER_LOAD_TIMEOUT_MS } from "./TikTokPlayer";
import { tikTokPlayerUrl, tikTokVideoId } from "./tiktokUrl";

// Fijan la reproducción dentro del visor: iframe oficial de TikTok (Embed Player) con el id
// del vídeo, un único reproductor a la vez, desmontaje al cerrar/cambiar, respaldo con la
// portada si falla y teclado/swipe operativos aunque el iframe (otro origen) tome el foco.
// jsdom no carga iframes ni implementa <dialog>.showModal: se simulan.

const COVER = "https://p16-sign.tiktokcdn.com/cover-1.jpeg";
const REAL_ID = "7687741460304645394";

function video(id: string, overrides: Partial<TikTokVideo> = {}): TikTokVideo {
  return {
    id,
    title: `Título ${id}`,
    embedUrl: `https://www.tiktok.com/@upminaa.cos/video/${id}?utm_source=x`,
    coverImageUrl: `${COVER}?${id}`,
    createTime: "2026-09-18T19:00:31.000Z",
    ...overrides,
  };
}

const FEED = [video("1"), video("2"), video("3"), video("4")];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function stubApi(respond: () => Response = () => json(FEED)) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => respond()),
  );
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TikTokSection />
    </QueryClientProvider>,
  );
}

const cardButton = (title: string) =>
  screen.findByRole("button", { name: new RegExp(`Abrir TikTok: ${title}$`) });

async function openViewer(title = "Título 1") {
  fireEvent.click(await cardButton(title));
  return screen.findByRole("dialog");
}

const viewerTitle = () => screen.getByRole("dialog").querySelector("h2")?.textContent;
const key = (k: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document, { key: k, ...init });
const playerIframes = () => [...document.querySelectorAll("iframe")];
const expirePlayerTimeout = () =>
  act(async () => {
    vi.advanceTimersByTime(PLAYER_LOAD_TIMEOUT_MS + 100);
  });
const playerId = (frame: HTMLIFrameElement) =>
  new URL(frame.src).pathname.split("/").pop();

function swipe(from: number, to: number) {
  const target = screen.getByRole("dialog").querySelector("h2") as HTMLElement;
  fireEvent.touchStart(target, { touches: [{ clientX: 200, clientY: from }] });
  fireEvent.touchEnd(target, { changedTouches: [{ clientX: 200, clientY: to }] });
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
  vi.useRealTimers();
  document.body.style.overflow = "";
});

describe("tiktokUrl: id de vídeo y URL del reproductor", () => {
  it("extrae el id numérico del share_url (con parámetros y barra final)", () => {
    expect(
      tikTokVideoId(
        `https://www.tiktok.com/@edwinramos94/video/${REAL_ID}?utm_campaign=x&a=b`,
      ),
    ).toBe(REAL_ID);
    expect(tikTokVideoId(`https://tiktok.com/@u.v/video/${REAL_ID}/`)).toBe(REAL_ID);
    expect(tikTokVideoId(`https://m.tiktok.com/@u_v/video/${REAL_ID}`)).toBe(REAL_ID);
  });

  it("sin id o inseguro → undefined", () => {
    for (const url of [
      "https://vm.tiktok.com/ZM123/",
      "https://www.tiktok.com/@u",
      "https://www.tiktok.com/@u/video/abc",
      "https://www.tiktok.com/@u/photo/123",
      "https://www.tiktok.com/@u/video/123/extra",
      `http://www.tiktok.com/@u/video/${REAL_ID}`,
      `https://evil.test/@u/video/${REAL_ID}`,
      `https://www.tiktok.com.evil.test/@u/video/${REAL_ID}`,
      "javascript:alert(1)",
      "no es url",
      "",
    ]) {
      expect(tikTokVideoId(url)).toBeUndefined();
    }
  });

  it("la URL del reproductor es el Embed Player oficial, sin autoplay", () => {
    const url = new URL(tikTokPlayerUrl(REAL_ID));
    expect(url.origin + url.pathname).toBe(`https://www.tiktok.com/player/v1/${REAL_ID}`);
    expect(url.searchParams.get("autoplay")).toBe("0");
    expect(url.searchParams.get("rel")).toBe("0");
    // El id se codifica: nada puede colarse en la ruta.
    expect(tikTokPlayerUrl("1/../../x")).not.toContain("/../");
  });
});

describe("TikTokViewer: reproductor oficial de TikTok", () => {
  it("renderiza el reproductor oficial con el id del vídeo (sin autoplay ni top-navigation)", async () => {
    stubApi();
    renderSection();
    const dialog = await openViewer("Título 2");

    const frame = dialog.querySelector("iframe") as HTMLIFrameElement;
    const url = new URL(frame.src);
    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/player/v1/2");
    expect(url.searchParams.get("autoplay")).toBe("0");
    expect(frame.title).toContain("Título 2");
    expect(frame.hasAttribute("allowfullscreen")).toBe(true);
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-top-navigation");
    // Vive DENTRO del área 9:16 y la llena (sin recortes ni escalados).
    expect(frame.parentElement?.className).toContain("aspect-[9/16]");
    expect(frame.className).toContain("absolute inset-0 h-full w-full");
  });

  it("el vídeo del reproductor corresponde a la tarjeta abierta (índice correcto)", async () => {
    stubApi();
    renderSection();

    await openViewer("Título 3");
    expect(playerIframes().map(playerId)).toEqual(["3"]);
  });

  it("al cambiar de vídeo (teclado, botones y swipe) el anterior se desmonta y carga el nuevo", async () => {
    stubApi();
    renderSection();
    await openViewer("Título 1");
    const first = playerIframes()[0];

    key("ArrowDown");
    expect(playerIframes().map(playerId)).toEqual(["2"]);
    expect(first.isConnected).toBe(false); // el reproductor anterior ya no existe

    fireEvent.click(screen.getByRole("button", { name: "Video siguiente" }));
    expect(playerIframes().map(playerId)).toEqual(["3"]);

    swipe(500, 380); // arriba → siguiente
    expect(playerIframes().map(playerId)).toEqual(["4"]);

    swipe(300, 430); // abajo → anterior
    expect(playerIframes().map(playerId)).toEqual(["3"]);

    key("ArrowUp");
    key("ArrowUp");
    key("ArrowUp"); // circular: 1 → 4
    expect(playerIframes().map(playerId)).toEqual(["4"]);
  });

  it("nunca hay varios reproductores a la vez (tampoco en la rejilla)", async () => {
    stubApi();
    const { container } = renderSection();
    await screen.findAllByRole("button", { name: /Abrir TikTok/ });
    expect(container.querySelectorAll("iframe")).toHaveLength(0);

    await openViewer("Título 1");
    for (let i = 0; i < 6; i++) {
      key("ArrowDown");
      expect(document.querySelectorAll("iframe")).toHaveLength(1);
    }
  });

  it("al cerrar el visor se desmonta el reproductor (con la X y con Escape)", async () => {
    stubApi();
    renderSection();

    await openViewer("Título 1");
    expect(playerIframes()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(playerIframes()).toHaveLength(0);

    await openViewer("Título 2");
    expect(playerIframes()).toHaveLength(1);
    key("Escape");
    expect(playerIframes()).toHaveLength(0);
  });

  it("mientras carga se ve la portada; al cargar el reproductor la portada se retira", async () => {
    stubApi();
    renderSection();
    const dialog = await openViewer("Título 1");

    const frame = dialog.querySelector("iframe") as HTMLIFrameElement;
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(`${COVER}?1`);
    expect(frame.className).toContain("opacity-0");

    fireEvent.load(frame);

    expect(dialog.querySelector("img")).toBeNull();
    expect(frame.className).toContain("opacity-100");
    expect(dialog.querySelector("[role='status']")).toBeNull();
  });

  it("si el reproductor no responde: vuelve la portada como contenido principal, aviso y 'Ver en TikTok'", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi();
    renderSection();
    const dialog = await openViewer("Título 2");

    await expirePlayerTimeout();

    await waitFor(() => expect(dialog.querySelector("iframe")).toBeNull());
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(`${COVER}?2`);
    expect(within(dialog).getByRole("status").textContent).toMatch(/No se pudo cargar/);
    expect(within(dialog).getByRole("link", { name: /Ver en TikTok/ })).toBeTruthy();
    expect(dialog.querySelector("[class*='aspect-[9/16]']")).not.toBeNull();
    // La navegación sigue funcionando y el siguiente vídeo intenta su propio reproductor.
    key("ArrowDown");
    expect(playerIframes().map(playerId)).toEqual(["3"]);
  });

  it("si el reproductor no carga en el tiempo límite, se usa el respaldo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi();
    renderSection();
    const dialog = await openViewer("Título 1");
    expect(dialog.querySelector("iframe")).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(PLAYER_LOAD_TIMEOUT_MS + 100);
    });

    expect(dialog.querySelector("iframe")).toBeNull();
    expect(within(dialog).getByRole("status")).toBeTruthy();
    expect(dialog.querySelector("img")).not.toBeNull();
  });

  it("un reproductor que carga a tiempo no cae al respaldo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi();
    renderSection();
    const dialog = await openViewer("Título 1");
    fireEvent.load(dialog.querySelector("iframe") as HTMLIFrameElement);

    await act(async () => {
      vi.advanceTimersByTime(PLAYER_LOAD_TIMEOUT_MS * 2);
    });

    expect(dialog.querySelector("iframe")).not.toBeNull();
    expect(dialog.querySelector("[role='status']")).toBeNull();
  });

  it("enlaces cortos sin id de vídeo (vm.tiktok.com): solo portada, sin iframe", async () => {
    stubApi(() =>
      json([video("1", { embedUrl: "https://vm.tiktok.com/ZM123/" }), video("2")]),
    );
    renderSection();
    const dialog = await openViewer("Título 1");

    expect(playerIframes()).toHaveLength(0);
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(`${COVER}?1`);
    expect(within(dialog).getByRole("link", { name: /Ver en TikTok/ })).toBeTruthy();

    key("ArrowDown");
    expect(playerIframes().map(playerId)).toEqual(["2"]);
  });

  it("URLs inválidas nunca llegan al reproductor", async () => {
    stubApi(() =>
      json([
        video("1", { embedUrl: "javascript:alert(1)" }),
        video("2", { embedUrl: "https://evil.test/@u/video/2" }),
        video("3", { embedUrl: "https://www.tiktok.com.evil.test/@u/video/3" }),
      ]),
    );
    renderSection();
    await openViewer("Título 1");

    for (let i = 0; i < 3; i++) {
      expect(playerIframes()).toHaveLength(0);
      key("ArrowDown");
    }
  });

  it("swipe táctil: las franjas laterales (fuera de la zona Play) recogen el gesto sobre el reproductor", async () => {
    stubApi();
    renderSection();
    const dialog = await openViewer("Título 2");

    const zones = dialog.querySelectorAll("[data-tt-swipe-zone]");
    expect(zones).toHaveLength(2);
    // Solo en pantallas táctiles y sin cubrir el centro ni las barras superior/inferior.
    for (const zone of zones) {
      expect(zone.className).toContain("[@media(pointer:coarse)]:block");
      expect(zone.className).toContain("hidden");
      expect(zone.className).toMatch(/w-\[16%\]/);
      expect(zone.className).toMatch(/top-\[9%\]/);
      expect(zone.className).toMatch(/bottom-\[10%\]/);
    }

    const zone = zones[1] as HTMLElement;
    fireEvent.touchStart(zone, { touches: [{ clientX: 300, clientY: 500 }] });
    fireEvent.touchEnd(zone, { changedTouches: [{ clientX: 300, clientY: 380 }] });
    expect(viewerTitle()).toBe("Título 3");
  });

  it("si el reproductor no responde ya no hay franjas de swipe que estorben", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi();
    renderSection();
    const dialog = await openViewer("Título 1");
    await expirePlayerTimeout();
    await waitFor(() => expect(dialog.querySelector("[data-tt-swipe-zone]")).toBeNull());
  });

  it("teclado: si el foco queda en el iframe tras un clic, vuelve al visor y ↓/↑/Escape funcionan", async () => {
    stubApi();
    renderSection();
    const dialog = await openViewer("Título 2");
    const frame = dialog.querySelector("iframe") as HTMLIFrameElement;

    // El clic en el reproductor (otro origen) deja el foco en el iframe.
    frame.focus();
    expect(document.activeElement).toBe(frame);
    fireEvent.blur(window);

    await waitFor(() => expect(document.activeElement).toBe(dialog));
    key("ArrowDown");
    expect(viewerTitle()).toBe("Título 3");
    key("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("navegación con Tab hacia el reproductor: no se le roba el foco", async () => {
    stubApi();
    renderSection();
    const dialog = await openViewer("Título 2");
    const frame = dialog.querySelector("iframe") as HTMLIFrameElement;

    key("Tab");
    frame.focus();
    fireEvent.blur(window);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(document.activeElement).toBe(frame);
  });
});
