import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import InstagramSection from "./instagram/InstagramSection";
import TikTokSection from "./tiktok/TikTokSection";

// Aislamiento entre proveedores (9H-3, seguimiento): reproducir un video de Instagram no altera el
// estado de TikTok y viceversa, ni la ruta. Cada sección guarda su propia selección; aquí se
// renderizan juntas con fetch simulado.

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const IG_FEED = [
  {
    id: "4001",
    mediaType: "VIDEO",
    imageUrl: "https://scontent.cdninstagram.com/v/a.jpg",
    videoUrl: "https://scontent.cdninstagram.com/v/a.mp4",
    permalink: "https://www.instagram.com/p/4001/",
    caption: "Reel IG",
    timestamp: "2026-09-18T19:00:31+00:00",
  },
];
const TT_FEED = [1, 2].map((n) => ({
  id: String(n),
  title: `Clip ${n}`,
  embedUrl: `https://www.tiktok.com/@upminaa.cos/video/${n}`,
  coverImageUrl: `https://p16-sign.tiktokcdn.com/c-${n}.jpeg`,
  createTime: "2026-09-18T19:00:31.000Z",
}));

function Location() {
  const l = useLocation();
  return <output data-testid="loc">{l.pathname + l.search}</output>;
}

function renderBoth() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/redes?video=YOUTUBEID11"]}>
        <Location />
        <InstagramSection />
        <TikTokSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const players = () => ({
  ig: document.querySelectorAll("video").length,
  tt: document.querySelectorAll("iframe").length,
});
const loc = () => screen.getByTestId("loc").textContent;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
  };
});

let playSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  playSpy = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input.startsWith("/api/instagram-feed")) return json(IG_FEED);
      if (input.startsWith("/api/tiktok-videos")) return json(TT_FEED);
      if (input.startsWith("/api/instagram-profile"))
        return json({ username: "upminaa" });
      if (input.startsWith("/api/instagram-comments")) return json({ comments: [] });
      return json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.style.overflow = "";
});

describe("Instagram y TikTok: reproducción independiente", () => {
  it("al cargar no hay ningún reproductor de ninguno de los dos", async () => {
    renderBoth();
    await screen.findByRole("button", { name: /Reel IG\. Abrir/ });
    await screen.findAllByRole("button", { name: /Abrir TikTok/ });

    expect(players()).toEqual({ ig: 0, tt: 0 });
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("reproducir Instagram no monta ni selecciona nada en TikTok, ni cambia la ruta", async () => {
    renderBoth();
    const before = loc();
    fireEvent.click(await screen.findByRole("button", { name: /Reel IG\. Abrir/ }));
    await screen.findByRole("dialog");

    expect(players()).toEqual({ ig: 1, tt: 0 });
    expect(loc()).toBe(before);

    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(players()).toEqual({ ig: 0, tt: 0 });
  });

  it("reproducir TikTok no monta ni selecciona nada en Instagram, ni cambia la ruta", async () => {
    renderBoth();
    const before = loc();
    fireEvent.click(await screen.findByRole("button", { name: /Abrir TikTok: Clip 2$/ }));
    await screen.findByRole("dialog");

    expect(players()).toEqual({ ig: 0, tt: 1 });
    expect(loc()).toBe(before);
    expect(playSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(players()).toEqual({ ig: 0, tt: 0 });
  });

  it("secuencia Instagram → cerrar → TikTok: nunca hay más de un reproductor en total", async () => {
    renderBoth();
    fireEvent.click(await screen.findByRole("button", { name: /Reel IG\. Abrir/ }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    fireEvent.click(await screen.findByRole("button", { name: /Abrir TikTok: Clip 1$/ }));
    await screen.findByRole("dialog");

    expect(players()).toEqual({ ig: 0, tt: 1 });
  });
});
