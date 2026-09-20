import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
import { SWIPE_THRESHOLD_PX } from "./TikTokViewer";

// Fijan la presentación de los vídeos de TikTok (tarjetas 9:16 con portada, sin iframes)
// y el visor vertical: apertura en el índice correcto, ↑/↓ y swipe circulares, cierre,
// enlace seguro al TikTok original y bloqueo/restauración del scroll. jsdom no implementa
// <dialog>.showModal ni carga imágenes: se simulan.

const COVER = "https://p16-sign.tiktokcdn.com/cover-1.jpeg";

function video(id: string, overrides: Partial<TikTokVideo> = {}): TikTokVideo {
  return {
    id,
    title: `Título ${id}`,
    embedUrl: `https://www.tiktok.com/@upminaa.cos/video/${id}`,
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
  const fetchMock = vi.fn(async () => respond());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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
  const card = await cardButton(title);
  fireEvent.click(card);
  return { card, dialog: await screen.findByRole("dialog") };
}

const viewerTitle = () => screen.getByRole("dialog").querySelector("h2")?.textContent;
const key = (k: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document, { key: k, ...init });

function swipe(from: number, to: number, dx = 0) {
  const target =
    screen.getByRole("dialog").querySelector("img") ?? screen.getByRole("dialog");
  fireEvent.touchStart(target, { touches: [{ clientX: 200, clientY: from }] });
  fireEvent.touchEnd(target, { changedTouches: [{ clientX: 200 + dx, clientY: to }] });
}

beforeAll(() => {
  // jsdom no implementa showModal: basta con marcarlo como abierto.
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

describe("TikTokSection: tarjetas", () => {
  it("una tarjeta 9:16 por vídeo con la portada como imagen principal (sin iframe ni reproductor)", async () => {
    const fetchMock = stubApi();
    const { container } = renderSection();

    const cards = await screen.findAllByRole("button", { name: /Abrir TikTok/ });
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      expect(card.className).toContain("aspect-[9/16]");
      const cover = card.querySelector("img");
      expect(cover?.getAttribute("src")).toMatch(/^https:\/\/p16-sign\.tiktokcdn\.com\//);
      // Nunca se deforma: la portada rellena la tarjeta con object-cover.
      expect(cover?.className).toContain("object-cover");
      expect(cover?.className).toContain("h-full");
      expect(cover?.className).toContain("w-full");
      expect(card.getAttribute("aria-haspopup")).toBe("dialog");
    }
    expect(container.querySelector("iframe, blockquote, video, a[href]")).toBeNull();
    // Una única petición, sin N+1.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("indicación de reproducción discreta y decorativa dentro de la tarjeta", async () => {
    stubApi();
    renderSection();
    const card = await cardButton("Título 1");
    expect(card.querySelector("span[aria-hidden='true'] svg")).not.toBeNull();
  });

  it("título y fecha quedan fuera del área 9:16", async () => {
    stubApi(() =>
      json([
        video("1", { createTime: new Date(Date.now() - 3 * 3600_000).toISOString() }),
      ]),
    );
    renderSection();

    const card = await cardButton("Título 1");
    const title = screen.getByText("Título 1");
    expect(card.contains(title)).toBe(false);
    expect(title.closest("article")).toBe(card.closest("article"));
    expect(card.closest("article")?.textContent).toContain("hace 3 horas");
  });

  it("vídeo sin título: solo fecha y nombre accesible genérico", async () => {
    stubApi(() => json([video("1", { title: "   " })]));
    renderSection();
    const card = await screen.findByRole("button", { name: "Abrir video de TikTok" });
    expect(card.closest("article")?.querySelector("p.line-clamp-2")).toBeNull();
  });

  it("si la portada caduca o falla, usa un fondo degradado y la tarjeta sigue abriendo el visor", async () => {
    stubApi();
    renderSection();

    const card = await cardButton("Título 1");
    fireEvent.error(card.querySelector("img")!);

    await waitFor(() => expect(card.querySelector("img")).toBeNull());
    expect(card.className).toContain("aspect-[9/16]");
    fireEvent.click(card);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("rejilla responsive: 2 columnas en móvil, hasta 4 en escritorio, sin ancho fijo", async () => {
    stubApi();
    const { container } = renderSection();
    await screen.findAllByRole("button", { name: /Abrir TikTok/ });

    const grid = container.querySelector("section > div.grid");
    expect(grid?.className).toContain("grid-cols-2");
    expect(grid?.className).toContain("lg:grid-cols-4");
    expect(grid?.innerHTML).not.toMatch(/width:\s*\d+px/);
  });

  it("estados: cargando, vacío y error", async () => {
    stubApi(() => json([]));
    let view = renderSection();
    expect(screen.getByText("Cargando videos…")).toBeTruthy();
    expect(await screen.findByText("Todavía no hay videos para mostrar.")).toBeTruthy();
    view.unmount();

    stubApi(() => json({ error: "No se pudieron obtener los videos de TikTok" }, 503));
    view = renderSection();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/No se pudieron cargar/);
    expect(screen.queryByRole("button", { name: /Abrir/ })).toBeNull();
    view.unmount();
  });
});

describe("TikTokViewer: apertura y cierre", () => {
  it("clic en una tarjeta abre el visor interno (NO abre tiktok.com)", async () => {
    stubApi();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderSection();

    const { dialog } = await openViewer("Título 1");

    expect(dialog.hasAttribute("open")).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("abre exactamente en el vídeo seleccionado", async () => {
    stubApi();
    renderSection();

    const { dialog } = await openViewer("Título 3");

    expect(viewerTitle()).toBe("Título 3");
    expect(within(dialog).getByText("3 / 4")).toBeTruthy();
    expect(dialog.textContent).toContain("Video 3 de 4");
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(`${COVER}?3`);
  });

  it("contenido: portada 9:16 sin deformar, título, fecha, 'Ver en TikTok' y botón X", async () => {
    stubApi();
    renderSection();
    const { dialog } = await openViewer("Título 2");

    const cover = dialog.querySelector("img") as HTMLImageElement;
    expect(cover.className).toContain("object-cover");
    expect(cover.className).toContain("h-full");
    expect(cover.parentElement?.className).toContain("aspect-[9/16]");
    // Es una imagen: no se intenta reproducir nada.
    expect(dialog.querySelector("video, iframe")).toBeNull();
    expect(viewerTitle()).toBe("Título 2");
    expect(dialog.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-09-18T19:00:31.000Z",
    );
    expect(within(dialog).getByRole("link", { name: /Ver en TikTok/ })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Cerrar" })).toBeTruthy();
  });

  it("botón X cierra el visor y devuelve el foco a la tarjeta", async () => {
    stubApi();
    renderSection();
    const { card } = await openViewer("Título 2");
    card.focus();

    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(card));
  });

  it("Escape cierra el visor", async () => {
    stubApi();
    renderSection();
    await openViewer();

    key("Escape");

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clic en el fondo cierra; clic dentro del contenido no", async () => {
    stubApi();
    renderSection();
    const { dialog } = await openViewer();

    const cover = dialog.querySelector("img") as HTMLElement;
    fireEvent.mouseDown(cover);
    fireEvent.click(cover);
    expect(screen.queryByRole("dialog")).not.toBeNull();

    const backdrop = dialog.querySelector("[data-tt-backdrop]") as HTMLElement;
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("foco inicial en el botón Cerrar", async () => {
    stubApi();
    renderSection();
    await openViewer();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cerrar" }));
  });
});

describe("TikTokViewer: navegación vertical", () => {
  it("ArrowDown → siguiente y ArrowUp → anterior, en el mismo visor (sin cerrar ni reabrir)", async () => {
    stubApi();
    renderSection();
    const { dialog } = await openViewer("Título 2");

    key("ArrowDown");
    expect(viewerTitle()).toBe("Título 3");
    expect(screen.getByRole("dialog")).toBe(dialog);

    key("ArrowUp");
    key("ArrowUp");
    expect(viewerTitle()).toBe("Título 1");
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(dialog.hasAttribute("open")).toBe(true);
  });

  it("es circular: último + siguiente → primero; primero + anterior → último", async () => {
    stubApi();
    renderSection();
    await openViewer("Título 4");

    key("ArrowDown");
    expect(viewerTitle()).toBe("Título 1");
    expect(screen.getByText("1 / 4")).toBeTruthy();

    key("ArrowUp");
    expect(viewerTitle()).toBe("Título 4");
    expect(screen.getByText("4 / 4")).toBeTruthy();
  });

  it("los botones ↑ y ↓ navegan igual (circular)", async () => {
    stubApi();
    renderSection();
    await openViewer("Título 1");

    fireEvent.click(screen.getByRole("button", { name: "Video anterior" }));
    expect(viewerTitle()).toBe("Título 4");
    fireEvent.click(screen.getByRole("button", { name: "Video siguiente" }));
    expect(viewerTitle()).toBe("Título 1");
    fireEvent.click(screen.getByRole("button", { name: "Video siguiente" }));
    expect(viewerTitle()).toBe("Título 2");
  });

  it("izquierda/derecha NO navegan; tampoco con modificadores ni con la tecla mantenida", async () => {
    stubApi();
    renderSection();
    await openViewer("Título 2");

    key("ArrowRight");
    key("ArrowLeft");
    key("ArrowDown", { ctrlKey: true });
    key("ArrowDown", { shiftKey: true });
    key("ArrowDown", { repeat: true });
    expect(viewerTitle()).toBe("Título 2");
  });

  it("la flecha evita el scroll nativo de la página", async () => {
    stubApi();
    renderSection();
    await openViewer();

    const notPrevented = fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(notPrevented).toBe(false); // preventDefault llamado
  });

  it("cambia el contenido: portada, título y fecha del nuevo vídeo, con transición vertical", async () => {
    stubApi();
    renderSection();
    const { dialog } = await openViewer("Título 1");

    key("ArrowDown");
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(`${COVER}?2`);
    expect(dialog.querySelector("[class*='animate-tt-in-up']")).not.toBeNull();

    key("ArrowUp");
    expect(dialog.querySelector("[class*='animate-tt-in-down']")).not.toBeNull();
  });

  it("con un solo vídeo no hay botones ↑/↓ y las flechas y swipes no hacen nada", async () => {
    stubApi(() => json([video("1")]));
    renderSection();
    await openViewer("Título 1");

    expect(screen.queryByRole("button", { name: "Video siguiente" })).toBeNull();
    key("ArrowDown");
    swipe(400, 200);
    expect(viewerTitle()).toBe("Título 1");
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  it("no hace peticiones extra a la API al navegar (solo precarga portadas)", async () => {
    const fetchMock = stubApi();
    renderSection();
    await openViewer("Título 1");
    key("ArrowDown");
    key("ArrowDown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("TikTokViewer: gesto táctil vertical", () => {
  it("swipe hacia ARRIBA → siguiente", async () => {
    stubApi();
    renderSection();
    await openViewer("Título 2");

    swipe(500, 380);

    expect(viewerTitle()).toBe("Título 3");
  });

  it("swipe hacia ABAJO → anterior", async () => {
    stubApi();
    renderSection();
    await openViewer("Título 2");

    swipe(300, 430);

    expect(viewerTitle()).toBe("Título 1");
  });

  it("los swipes también son circulares", async () => {
    stubApi();
    renderSection();
    await openViewer("Título 4");

    swipe(500, 380); // último + arriba → primero
    expect(viewerTitle()).toBe("Título 1");
    swipe(300, 430); // primero + abajo → último
    expect(viewerTitle()).toBe("Título 4");
  });

  it("un gesto por debajo del umbral NO cambia de vídeo", async () => {
    stubApi();
    renderSection();
    await openViewer("Título 2");

    swipe(500, 500 - (SWIPE_THRESHOLD_PX - 1));
    swipe(300, 300 + (SWIPE_THRESHOLD_PX - 1));
    swipe(400, 410);
    expect(viewerTitle()).toBe("Título 2");

    // En el umbral sí cambia.
    swipe(500, 500 - SWIPE_THRESHOLD_PX);
    expect(viewerTitle()).toBe("Título 3");
  });

  it("un gesto más horizontal que vertical (diagonal) no cambia de vídeo", async () => {
    stubApi();
    renderSection();
    await openViewer("Título 2");

    swipe(500, 420, 90); // dy=80 pero dx=90: no es vertical
    swipe(500, 420, -120);
    expect(viewerTitle()).toBe("Título 2");

    swipe(500, 420, 20); // sí es claramente vertical
    expect(viewerTitle()).toBe("Título 3");
  });

  it("un gesto con dos dedos o cancelado no navega", async () => {
    stubApi();
    renderSection();
    const { dialog } = await openViewer("Título 2");

    fireEvent.touchStart(dialog, {
      touches: [
        { clientX: 100, clientY: 500 },
        { clientX: 200, clientY: 500 },
      ],
    });
    fireEvent.touchEnd(dialog, { changedTouches: [{ clientX: 100, clientY: 300 }] });
    expect(viewerTitle()).toBe("Título 2");

    fireEvent.touchStart(dialog, { touches: [{ clientX: 100, clientY: 500 }] });
    fireEvent.touchCancel(dialog);
    fireEvent.touchEnd(dialog, { changedTouches: [{ clientX: 100, clientY: 300 }] });
    expect(viewerTitle()).toBe("Título 2");
  });

  it("el visor impide que el gesto desplace la página (touch-action: none)", async () => {
    stubApi();
    renderSection();
    const { dialog } = await openViewer();
    expect(dialog.className).toContain("touch-none");
    expect(dialog.className).toContain("overscroll-contain");
  });
});

describe("TikTokViewer: 'Ver en TikTok'", () => {
  it("abre embedUrl en pestaña nueva con noopener/noreferrer", async () => {
    stubApi();
    renderSection();
    const { dialog } = await openViewer("Título 3");

    const link = within(dialog).getByRole("link", { name: /Ver en TikTok/ });
    expect(link.getAttribute("href")).toBe("https://www.tiktok.com/@upminaa.cos/video/3");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("acepta subdominios oficiales (vm.tiktok.com) y sigue al cambiar de vídeo", async () => {
    stubApi(() =>
      json([video("1", { embedUrl: "https://vm.tiktok.com/ZM123/" }), video("2")]),
    );
    renderSection();
    const { dialog } = await openViewer("Título 1");
    const href = () =>
      within(dialog)
        .getByRole("link", { name: /Ver en TikTok/ })
        .getAttribute("href");
    expect(href()).toBe("https://vm.tiktok.com/ZM123/");

    key("ArrowDown");
    expect(href()).toBe("https://www.tiktok.com/@upminaa.cos/video/2");
  });

  it("URL inválida o que no es de tiktok.com: el visor abre pero SIN botón 'Ver en TikTok'", async () => {
    const invalid = [
      "javascript:alert(1)",
      "https://evil.test/@u/video/1",
      "http://www.tiktok.com/@u/video/1",
      "https://www.tiktok.com.evil.test/@u/video/1",
      "no es una url",
    ];
    stubApi(() => json(invalid.map((embedUrl, i) => video(String(i + 1), { embedUrl }))));
    renderSection();
    const { dialog } = await openViewer("Título 1");

    for (let i = 0; i < invalid.length; i++) {
      expect(viewerTitle()).toBe(`Título ${i + 1}`);
      expect(within(dialog).queryByRole("link")).toBeNull();
      expect(dialog.querySelector("a[href]")).toBeNull();
      key("ArrowDown");
    }
  });
});

describe("TikTokViewer: scroll del documento y portada", () => {
  it("bloquea el scroll del documento al abrir y lo restaura al cerrar", async () => {
    document.body.style.overflow = "scroll";
    stubApi();
    renderSection();
    expect(document.body.style.overflow).toBe("scroll");

    await openViewer();
    expect(document.body.style.overflow).toBe("hidden");

    // Navegar no lo libera.
    key("ArrowDown");
    expect(document.body.style.overflow).toBe("hidden");

    key("Escape");
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("restaura el scroll también al cerrar con la X (valor vacío original)", async () => {
    stubApi();
    renderSection();
    await openViewer();
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(document.body.style.overflow).toBe("");
  });

  it("si la portada falla en el visor, usa el fallback neon y sigue navegando", async () => {
    stubApi();
    renderSection();
    const { dialog } = await openViewer("Título 1");

    fireEvent.error(dialog.querySelector("img")!);
    await waitFor(() => expect(dialog.querySelector("img")).toBeNull());
    expect(dialog.querySelector("[class*='aspect-[9/16]']")).not.toBeNull();
    expect(dialog.querySelector("span[class*='bg-gradient-to-br']")).not.toBeNull();

    key("ArrowDown");
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(`${COVER}?2`);
  });

  it("layout: sin anchos fijos que provoquen overflow y área 9:16 acotada", async () => {
    stubApi();
    renderSection();
    const { dialog } = await openViewer();

    expect(dialog.className).toContain("overflow-hidden");
    expect(dialog.innerHTML).not.toMatch(/width:\s*\d+px/);
    const frame = dialog.querySelector("[class*='aspect-[9/16]']") as HTMLElement;
    expect(frame.className).toContain("380px"); // tope en escritorio
    expect(frame.className).toContain("92vw"); // cabe en móvil
    expect(frame.className).toContain("short:"); // pantallas de poco alto
  });
});
