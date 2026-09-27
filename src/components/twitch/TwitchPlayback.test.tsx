import { StrictMode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { TwitchClip } from "@/types";
import TwitchSection from "./TwitchSection";
import { FakeTwitchPlayer, installFakeTwitch, removeFakeTwitch } from "./twitchTestUtils";
import { TWITCH_PLAYER_SCRIPT_URL } from "./twitchPlayerApi";

// Reproducción de Twitch (9H-3, seguimiento): reproductor principal (directo y VOD) con la API
// oficial y clips con un solo clic. Se usa un doble de `Twitch.Player` (jsdom no carga el script).

const clip = (n: number, overrides: Partial<TwitchClip> = {}): TwitchClip => ({
  id: `Clip${n}-abc`,
  url: `https://www.twitch.tv/upminaa/clip/Clip${n}-abc`,
  title: `Clip ${n}`,
  creatorName: `creador${n}`,
  embedUrl: `https://clips.twitch.tv/embed?clip=Clip${n}-abc`,
  thumbnailUrl: `https://static-cdn.jtvnw.net/x/thumb-${n}.jpg`,
  viewCount: n,
  createdAt: "2026-09-18T19:00:31Z",
  ...overrides,
});
const FEED = Array.from({ length: 4 }, (_, i) => clip(i + 1));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

let live = false;
function stubApi(feed: TwitchClip[] = FEED) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("twitch-clips")) return json(feed);
      if (url.includes("twitch-status"))
        return json(
          live
            ? { isLive: true, channel: "upminaa", title: "Directo" }
            : { isLive: false, channel: "upminaa" },
        );
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
    }),
  );
}

function renderSection(entries = ["/twitch"], strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={entries}>
        <Routes>
          <Route path="/twitch" element={<TwitchSection />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { ...view, client };
}

const players = () => FakeTwitchPlayer.instances;
const clipIframes = () => [
  ...document.querySelectorAll("iframe[src*='clips.twitch.tv']"),
];
const key = (k: string) => fireEvent.keyDown(document, { key: k });
async function primary(index = 0): Promise<FakeTwitchPlayer> {
  await waitFor(() => expect(players().length).toBeGreaterThan(index));
  return players()[index];
}
/** Clic del usuario dentro del iframe (otro origen): el foco entra en él y la ventana pierde el foco. */
function clickInto(frame: HTMLIFrameElement) {
  frame.focus();
  fireEvent.blur(window);
}
async function openClip(title = "Clip 1") {
  fireEvent.click(
    await screen.findByRole("button", { name: `Reproducir clip: ${title}` }),
  );
  return screen.findByRole("dialog");
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
  live = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
  installFakeTwitch();
});
afterEach(() => {
  cleanup();
  removeFakeTwitch();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.querySelectorAll("script").forEach((s) => s.remove());
  document.body.style.overflow = "";
});

describe("Twitch principal: sin sonido sorpresa", () => {
  for (const kind of ["VOD", "LIVE"] as const) {
    it(`${kind}: al cargar nace silenciado y no se envía ningún comando`, async () => {
      live = kind === "LIVE";
      stubApi();
      renderSection();
      const p = await primary();

      expect(p.options.muted).toBe(true);
      expect(p.options.autoplay).toBe(true);
      expect(p.options.parent).toEqual(["localhost"]);
      if (live) expect(p.options.channel).toBe("upminaa");
      else expect(p.options.video).toBe("123");
      expect(p.calls).toEqual([]);
      // Ni siquiera un READY provoca sonido sin interacción.
      p.emit(FakeTwitchPlayer.READY);
      expect(p.calls).toEqual([]);
      expect(players()).toHaveLength(1);
    });
  }

  it("el polling de estado offline → live sustituye el reproductor SILENCIADO (sin sonido)", async () => {
    stubApi();
    const { client } = renderSection();
    const first = await primary();
    first.emit(FakeTwitchPlayer.READY);

    live = true;
    await act(async () => {
      await client.invalidateQueries();
    });
    const second = await primary(1);

    expect(second.options.channel).toBe("upminaa");
    expect(second.options.muted).toBe(true);
    second.emit(FakeTwitchPlayer.READY);
    expect(second.calls).toEqual([]);
    expect(first.calls).toEqual([]);
    expect(first.frame.isConnected).toBe(false);
  });

  it("sin script oficial (bloqueado): iframe simple silenciado, como antes", async () => {
    removeFakeTwitch();
    stubApi();
    renderSection();
    await waitFor(() =>
      expect(
        document.head.querySelector(`script[src='${TWITCH_PLAYER_SCRIPT_URL}']`),
      ).not.toBeNull(),
    );
    act(() => {
      document.head.querySelector("script")?.dispatchEvent(new Event("error"));
    });

    const frame = await screen.findByTitle("Último stream de Twitch");
    expect(frame.getAttribute("src")).toBe(
      "https://player.twitch.tv/?video=123&parent=localhost&muted=true",
    );
  });
});

describe("Twitch principal: interacción explícita → play + sonido", () => {
  for (const kind of ["VOD", "LIVE"] as const) {
    it(`${kind}: un clic en el reproductor solicita play y sonido (una sola vez, sin segundo Play)`, async () => {
      live = kind === "LIVE";
      stubApi();
      renderSection();
      const p = await primary();
      p.emit(FakeTwitchPlayer.READY);

      clickInto(p.frame);
      expect(p.calls).toEqual(["play", "setMuted:false"]);

      // Más eventos y más clics: nada se repite.
      p.emit(FakeTwitchPlayer.READY);
      clickInto(p.frame);
      expect(p.calls).toEqual(["play", "setMuted:false"]);
      expect(
        screen.queryByRole("button", { name: /^(Reproducir|Activar sonido)$/ }),
      ).toBeNull();
    });
  }

  it("si el volumen estaba a 0 se restablece a un valor razonable", async () => {
    stubApi();
    renderSection();
    const p = await primary();
    p.emit(FakeTwitchPlayer.READY);
    p.seedVolume(0);

    clickInto(p.frame);

    expect(p.calls).toEqual(["play", "setMuted:false", "setVolume:0.5"]);
  });

  it("una interacción antes de READY se aplica al estar listo (una vez)", async () => {
    stubApi();
    renderSection();
    const p = await primary();

    clickInto(p.frame);
    expect(p.calls).toEqual([]);
    p.emit(FakeTwitchPlayer.READY);

    expect(p.calls).toEqual(["play", "setMuted:false"]);
  });

  it("perder el foco por otra causa (no es el reproductor) no pide sonido", async () => {
    stubApi();
    renderSection();
    const p = await primary();
    p.emit(FakeTwitchPlayer.READY);

    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.blur(window);

    expect(p.calls).toEqual([]);
  });

  it("recorrer la página con Tab hasta el iframe NO es una interacción: sin play ni sonido", async () => {
    stubApi();
    renderSection();
    const p = await primary();
    p.emit(FakeTwitchPlayer.READY);

    key("Tab");
    clickInto(p.frame); // el foco llega justo tras la tecla

    expect(p.calls).toEqual([]);
  });

  it("tras pasar por teclado, un clic posterior sí solicita play y sonido (una vez)", async () => {
    stubApi();
    renderSection();
    const p = await primary();
    p.emit(FakeTwitchPlayer.READY);
    key("Tab");
    clickInto(p.frame);
    expect(p.calls).toEqual([]);

    const now = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(now + 5_000);
    (document.activeElement as HTMLElement | null)?.blur();
    clickInto(p.frame);

    expect(p.calls).toEqual(["play", "setMuted:false"]);
  });

  it("si el navegador rechaza el sonido no hay bucle ni remontaje (PLAYBACK_BLOCKED)", async () => {
    stubApi();
    renderSection();
    const p = await primary();
    p.emit(FakeTwitchPlayer.READY);
    clickInto(p.frame);

    for (let i = 0; i < 5; i++) {
      p.emit("playbackBlocked");
      clickInto(p.frame);
    }

    expect(p.calls).toEqual(["play", "setMuted:false"]);
    expect(players()).toHaveLength(1);
    expect(p.frame.isConnected).toBe(true);
  });

  it("si un comando lanza no rompe la página", async () => {
    stubApi();
    renderSection();
    const p = await primary();
    p.emit(FakeTwitchPlayer.READY);
    vi.spyOn(p, "setMuted").mockImplementation(() => {
      throw new Error("rechazado");
    });

    expect(() => clickInto(p.frame)).not.toThrow();
    expect(players()).toHaveLength(1);
  });

  it("desmontar limpia: sin comandos ni eventos posteriores", async () => {
    stubApi();
    const view = renderSection();
    const p = await primary();
    p.emit(FakeTwitchPlayer.READY);
    view.unmount();

    clickInto(p.frame);
    p.emit(FakeTwitchPlayer.READY);

    expect(p.calls).toEqual([]);
    expect(p.frame.isConnected).toBe(false);
  });

  it("sustitución de fuente: el reproductor viejo ya no recibe comandos ni eventos", async () => {
    stubApi();
    const { client } = renderSection();
    const first = await primary();

    live = true;
    await act(async () => {
      await client.invalidateQueries();
    });
    const second = await primary(1);
    first.emit(FakeTwitchPlayer.READY); // READY tardío del viejo
    second.emit(FakeTwitchPlayer.READY);
    clickInto(second.frame);

    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual(["play", "setMuted:false"]);
  });

  it("una interacción pendiente del reproductor viejo no se aplica cuando su READY llega tarde", async () => {
    stubApi();
    const { client } = renderSection();
    const first = await primary();
    clickInto(first.frame); // antes de READY: queda pendiente

    live = true;
    await act(async () => {
      await client.invalidateQueries();
    });
    const second = await primary(1);
    first.emit(FakeTwitchPlayer.READY);
    second.emit(FakeTwitchPlayer.READY);

    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual([]);
  });

  it("StrictMode: una sola instancia efectiva y un único play/sonido", async () => {
    stubApi();
    renderSection(["/twitch"], true);
    const p = await primary();
    await act(async () => {});
    expect(players()).toHaveLength(1);
    expect(document.querySelectorAll("iframe[src*='player.twitch.tv']")).toHaveLength(1);
    p.emit(FakeTwitchPlayer.READY);

    clickInto(p.frame);
    clickInto(p.frame);

    expect(p.calls).toEqual(["play", "setMuted:false"]);
  });
});

describe("Clips de Twitch: un clic reproduce", () => {
  it("INICIAL: cero reproductores de clips y ningún autoplay de clip", async () => {
    stubApi();
    renderSection();
    await screen.findAllByRole("button", { name: /^Reproducir clip:/ });

    expect(clipIframes()).toHaveLength(0);
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("UN clic monta el clip elegido con autoplay solicitado y sin Play propio de la aplicación", async () => {
    stubApi();
    renderSection();
    const dialog = await openClip("Clip 3");

    const frames = clipIframes() as HTMLIFrameElement[];
    expect(frames).toHaveLength(1);
    const url = new URL(frames[0].src);
    expect(url.origin + url.pathname).toBe("https://clips.twitch.tv/embed");
    expect(url.searchParams.get("clip")).toBe("Clip3-abc");
    expect(url.searchParams.get("parent")).toBe("localhost");
    expect(url.searchParams.get("autoplay")).toBe("true");
    expect(url.searchParams.has("muted")).toBe(false);
    expect(frames[0].getAttribute("allow")).toContain("autoplay");
    expect(frames[0].getAttribute("sandbox")).toBeNull();
    expect(dialog.querySelector("button[aria-label^='Reproducir']")).toBeNull();
  });

  it("abrir otro clip: el anterior se desmonta y queda exactamente uno", async () => {
    stubApi();
    renderSection();
    await openClip("Clip 1");
    const first = clipIframes()[0];

    key("ArrowRight");

    expect(first.isConnected).toBe(false);
    expect(clipIframes()).toHaveLength(1);
    expect((clipIframes()[0] as HTMLIFrameElement).src).toContain("clip=Clip2-abc");
    expect((clipIframes()[0] as HTMLIFrameElement).src).toContain("autoplay=true");
    key("ArrowLeft");
    expect((clipIframes()[0] as HTMLIFrameElement).src).toContain("clip=Clip1-abc");
    expect(clipIframes()).toHaveLength(1);
  });

  it("cerrar (X) y Escape: cero clips", async () => {
    stubApi();
    renderSection();
    await openClip("Clip 1");
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(clipIframes()).toHaveLength(0);

    await openClip("Clip 2");
    key("Escape");
    expect(clipIframes()).toHaveLength(0);
  });

  it("un embedUrl no oficial nunca llega al iframe (se reconstruye con el id)", async () => {
    stubApi([clip(1, { embedUrl: "https://evil.test/embed?clip=x&muted=true" })]);
    renderSection();
    await openClip("Clip 1");

    const src = (clipIframes()[0] as HTMLIFrameElement).src;
    expect(src.startsWith("https://clips.twitch.tv/embed?")).toBe(true);
    expect(src).not.toContain("evil");
    expect(src).not.toContain("muted");
  });
});

describe("Coordinación: principal y clip nunca compiten", () => {
  it("con el principal listo, abrir un clip lo pausa y lo silencia", async () => {
    stubApi();
    renderSection();
    const p = await primary();
    p.emit(FakeTwitchPlayer.READY);
    clickInto(p.frame); // el usuario estaba escuchando el principal
    p.calls.length = 0;

    await openClip("Clip 1");

    expect(p.calls).toEqual(["pause", "setMuted:true"]);
    expect(clipIframes()).toHaveLength(1);
  });

  it("cerrar el clip NO reanuda el principal (sin sonido sorpresa)", async () => {
    stubApi();
    renderSection();
    const p = await primary();
    p.emit(FakeTwitchPlayer.READY);
    clickInto(p.frame);
    await openClip("Clip 1");
    p.calls.length = 0;

    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    await act(async () => {});

    expect(clipIframes()).toHaveLength(0);
    expect(p.calls).toEqual([]);
    expect(p.getMuted()).toBe(true);
  });

  it("tras cerrar el clip, activar el principal vuelve a pedir play y sonido", async () => {
    stubApi();
    renderSection();
    const p = await primary();
    p.emit(FakeTwitchPlayer.READY);
    clickInto(p.frame);
    await openClip("Clip 1");
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    p.calls.length = 0;

    clickInto(p.frame);

    expect(p.calls).toEqual(["play", "setMuted:false"]);
  });

  it("activar el principal con un clip abierto cierra el clip (queda un solo reproductor activo)", async () => {
    stubApi();
    renderSection();
    const p = await primary();
    p.emit(FakeTwitchPlayer.READY);
    await openClip("Clip 2");
    expect(clipIframes()).toHaveLength(1);
    p.calls.length = 0;

    clickInto(p.frame);

    await waitFor(() => expect(clipIframes()).toHaveLength(0));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(p.calls).toEqual(["play", "setMuted:false"]);
  });

  it("enlace directo ?clip=: el principal, aún silenciado, se detiene al estar listo y no suena", async () => {
    stubApi();
    renderSection(["/twitch?clip=Clip2-abc"]);
    await screen.findByRole("dialog");
    const p = await primary();

    p.emit(FakeTwitchPlayer.READY);

    expect(p.calls).toEqual(["pause", "setMuted:true"]);
    expect(clipIframes()).toHaveLength(1);
  });
});
