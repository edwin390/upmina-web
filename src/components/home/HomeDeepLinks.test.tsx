import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import HomePage from "@/pages/HomePage";

// Fijan los enlaces de contenido de Home: cada tarjeta lleva al contenido concreto por URL
// (?video= / ?clip=), el LIVE/VOD de Twitch va a /twitch, y Home solo muestra un elemento por
// categoría aunque pida las mismas listas de 12 que /youtube (misma URL y caché).

const yt = (id: string, title: string) => ({
  id,
  title,
  description: "",
  thumbnailUrl: `https://i.ytimg.com/vi/${id}/hq.jpg`,
  publishedAt: "2026-09-18T19:00:31Z",
  duration: "3:00",
});
const clip = (n: number) => ({
  id: `Clip${n}-abc`,
  url: `https://www.twitch.tv/upminaa/clip/Clip${n}-abc`,
  title: `Clip ${n}`,
  creatorName: `creador${n}`,
  embedUrl: `https://clips.twitch.tv/embed?clip=Clip${n}-abc`,
  thumbnailUrl: `https://static-cdn.jtvnw.net/t${n}.jpg`,
  viewCount: n,
  createdAt: "2026-09-18T19:00:31Z",
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const DATA = {
  status: { isLive: false, channel: "upminaa" },
  twitchVideo: {
    id: "999",
    url: "https://www.twitch.tv/videos/999",
    title: "Último stream",
    createdAt: "2026-09-18T19:00:31Z",
    duration: "1h2m3s",
  },
  latest: yt("LATESTaaaa1", "Último upload"),
  videos: [yt("VIDEOaaaaa1", "Video 1"), yt("VIDEOaaaaa2", "Video 2")],
  shorts: [yt("SHORTaaaaa1", "Short 1"), yt("SHORTaaaaa2", "Short 2")],
  clips: [clip(1), clip(2), clip(3)],
};

function stubApi(overrides: Partial<Record<keyof typeof DATA, () => Response>> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const u = String(input);
    const pick = (key: keyof typeof DATA) =>
      overrides[key] ? overrides[key]!() : json(DATA[key]);
    if (u.includes("twitch-status")) return pick("status");
    if (u.includes("twitch-latest-video")) return pick("twitchVideo");
    if (u.includes("twitch-clips")) return pick("clips");
    if (u.includes("youtube-latest")) return pick("latest");
    if (u.includes("type=videos")) return pick("videos");
    if (u.includes("type=shorts")) return pick("shorts");
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const hrefOf = (badge: string) =>
  screen.getByText(badge).closest("a")?.getAttribute("href");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Home: enlaces de contenido (deep links)", () => {
  it("cada tarjeta enlaza al contenido concreto y el LIVE/VOD a /twitch", async () => {
    stubApi();
    renderHome();

    await waitFor(() =>
      expect(hrefOf("YouTube · Último video")).toBe("/youtube?video=LATESTaaaa1"),
    );
    await waitFor(() =>
      expect(hrefOf("YouTube · Video")).toBe("/youtube?video=VIDEOaaaaa1"),
    );
    await waitFor(() =>
      expect(hrefOf("YouTube · Short")).toBe("/youtube?video=SHORTaaaaa1"),
    );
    await waitFor(() => expect(hrefOf("Twitch · Clip")).toBe("/twitch?clip=Clip1-abc"));
    await waitFor(() => expect(hrefOf("Twitch · Último stream")).toBe("/twitch"));
  });

  it("en directo, la tarjeta de Twitch también va a /twitch (el reproductor decide LIVE/VOD)", async () => {
    stubApi({
      status: () => json({ isLive: true, channel: "upminaa", title: "Directo" }),
    });
    renderHome();

    await waitFor(() => expect(hrefOf("Twitch · En directo")).toBe("/twitch"));
  });

  it("Home muestra solo UN elemento por categoría y pide las mismas listas de 12 que /youtube", async () => {
    const fetchMock = stubApi();
    renderHome();
    await waitFor(() => expect(hrefOf("YouTube · Short")).toBeTruthy());
    await waitFor(() => expect(hrefOf("Twitch · Clip")).toBeTruthy());

    const links = [...document.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links.filter((h) => h?.startsWith("/youtube?video="))).toHaveLength(3);
    expect(links.filter((h) => h?.startsWith("/twitch?clip="))).toHaveLength(1);
    expect(screen.queryByText("Video 2")).toBeNull();
    expect(screen.queryByText("Short 2")).toBeNull();
    expect(screen.queryByText("Clip 2")).toBeNull();

    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls).toContain("/api/youtube-videos?maxResults=12&type=videos");
    expect(urls).toContain("/api/youtube-videos?maxResults=12&type=shorts");
    expect(urls.some((u) => u.includes("maxResults=1&"))).toBe(false);
  });

  it("sin id válido nunca genera undefined/null en la URL: enlaza a la ruta normal", async () => {
    stubApi({
      latest: () => json({ ...DATA.latest, id: "" }),
      videos: () => json([{ ...DATA.videos[0], id: "corto" }]),
      shorts: () => json([{ ...DATA.shorts[0], id: "con espacios!" }]),
      clips: () => json([{ ...DATA.clips[0], id: "../mal" }]),
    });
    renderHome();

    await waitFor(() => expect(hrefOf("YouTube · Video")).toBe("/youtube"));
    expect(hrefOf("YouTube · Último video")).toBe("/youtube");
    expect(hrefOf("YouTube · Short")).toBe("/youtube");
    expect(hrefOf("Twitch · Clip")).toBe("/twitch");
    for (const a of document.querySelectorAll("a")) {
      expect(a.getAttribute("href")).not.toMatch(/undefined|null/);
    }
  });

  it("EXPLORA y la comunidad siguen con rutas normales", async () => {
    stubApi();
    renderHome();
    await waitFor(() => expect(hrefOf("YouTube · Short")).toBeTruthy());

    const links = [...document.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const path of ["/twitch", "/youtube", "/instagram", "/tiktok", "/comunidad"]) {
      expect(links).toContain(path);
    }
  });
});
