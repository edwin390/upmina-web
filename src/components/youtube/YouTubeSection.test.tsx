import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router-dom";
import type { YouTubeVideo } from "@/types";
import YouTubeSection from "./YouTubeSection";

// Fijan la selección por URL (/youtube?video=<id>): sin parámetro sigue mandando el último video;
// con parámetro se reproduce exactamente ese (video normal o Short) si es del canal; los ids
// malformados o ya no disponibles limpian la URL con un aviso; mientras carga o si la consulta
// falla, el deep link se conserva.

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
const SHORTS = ["SHORTaaaaa1", "SHORTaaaaa2"].map((id, i) => video(id, `Short ${i + 1}`));
// El último upload coincide con el primer video de la lista (lo normal).
const LATEST = VIDEOS[0];

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
    latest: () => json(LATEST),
    videos: () => json(VIDEOS),
    shorts: () => json(SHORTS),
    ...overrides,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("youtube-latest")) return api.latest();
    if (url.includes("type=videos")) return api.videos();
    if (url.includes("type=shorts")) return api.shorts();
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

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

function renderSection(entries: string[] = ["/youtube"], initialIndex?: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={entries} initialIndex={initialIndex}>
        <RouterProbe />
        <Routes>
          <Route path="/" element={<p>Inicio</p>} />
          <Route path="/youtube" element={<YouTubeSection />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const heroFrame = () =>
  document.querySelector<HTMLIFrameElement>(
    "iframe[src^='https://www.youtube.com/embed/']",
  );
const heroId = () => heroFrame()?.getAttribute("src")?.split("/embed/")[1];
const UNAVAILABLE = /Este contenido ya no está disponible entre los más recientes\./;
const card = (title: string) => screen.getByRole("button", { name: new RegExp(title) });
const playing = () =>
  screen
    .queryAllByText("Reproduciendo")
    .map((el) => el.closest("button")?.textContent ?? "");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("YouTubeSection sin ?video=", () => {
  it("comportamiento actual: el último video en el hero, URL intacta, sin aviso", async () => {
    stubApi();
    renderSection(["/youtube"]);

    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa1"));
    expect(url()).toBe("/youtube");
    expect(navType()).toBe("POP");
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    expect(playing()).toHaveLength(1);
    expect(playing()[0]).toContain("Video 1");
  });
});

describe("YouTubeSection con ?video=<id>", () => {
  it("video normal: reproduce exactamente ese y lo marca como 'Reproduciendo'", async () => {
    stubApi();
    renderSection(["/youtube?video=VIDEOaaaaa3"]);

    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa3"));
    expect(screen.getAllByText("Video 3").length).toBeGreaterThan(0);
    expect(playing()).toHaveLength(1);
    expect(playing()[0]).toContain("Video 3");
    expect(url()).toBe("/youtube?video=VIDEOaaaaa3");
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
  });

  it("Short: reproduce exactamente ese Short en el hero", async () => {
    stubApi();
    renderSection(["/youtube?video=SHORTaaaaa2"]);

    await waitFor(() => expect(heroId()).toBe("SHORTaaaaa2"));
    expect(playing()).toHaveLength(1);
    expect(playing()[0]).toContain("Short 2");
    expect(url()).toBe("/youtube?video=SHORTaaaaa2");
  });

  it("el último upload aún fuera de las listas (caché desfasada) también se reproduce", async () => {
    const fresh = video("NUEVOaaaaa1", "Recién publicado");
    stubApi({ latest: () => json(fresh) });
    renderSection(["/youtube?video=NUEVOaaaaa1"]);

    await waitFor(() => expect(heroId()).toBe("NUEVOaaaaa1"));
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    expect(url()).toBe("/youtube?video=NUEVOaaaaa1");
  });

  it("recargar o pegar la URL en otra pestaña conserva la selección", async () => {
    stubApi();
    const first = renderSection(["/youtube"]);
    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa1"));
    fireEvent.click(await screen.findByRole("button", { name: /Short 1/ }));
    const lastUrl = url() as string;
    expect(lastUrl).toBe("/youtube?video=SHORTaaaaa1");
    first.unmount();

    renderSection([lastUrl]);
    await waitFor(() => expect(heroId()).toBe("SHORTaaaaa1"));
  });

  it("clic en una tarjeta actualiza la URL con REPLACE y mueve 'Reproduciendo'", async () => {
    stubApi();
    renderSection(["/youtube"]);
    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa1"));

    fireEvent.click(card("Video 3"));

    expect(url()).toBe("/youtube?video=VIDEOaaaaa3");
    expect(navType()).toBe("REPLACE");
    expect(heroId()).toBe("VIDEOaaaaa3");
    expect(playing()).toHaveLength(1);
    expect(playing()[0]).toContain("Video 3");
  });

  it("cada video usa un iframe nuevo: cambiar el src de uno cargado añadiría entradas al historial del navegador", async () => {
    stubApi();
    renderSection(["/youtube"]);
    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa1"));
    const before = heroFrame();

    fireEvent.click(card("Video 3"));

    expect(heroId()).toBe("VIDEOaaaaa3");
    expect(before?.isConnected).toBe(false);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("los cambios de selección no llenan el historial: Atrás vuelve a Home", async () => {
    stubApi();
    renderSection(["/", "/youtube?video=VIDEOaaaaa2"], 1);
    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa2"));

    fireEvent.click(card("Video 3"));
    fireEvent.click(card("Short 1"));
    fireEvent.click(card("Video 1"));
    fireEvent.click(screen.getByRole("button", { name: "__atrás" }));

    expect(url()).toBe("/");
    expect(screen.getByText("Inicio")).toBeTruthy();
    expect(heroFrame()).toBeNull();
  });

  it("conserva los demás parámetros al seleccionar y al limpiar", async () => {
    stubApi();
    renderSection(["/youtube?utm=a&video=VIDEOaaaaa2&x=1"]);
    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa2"));

    fireEvent.click(card("Video 3"));
    expect(url()).toContain("utm=a");
    expect(url()).toContain("x=1");
    expect(url()).toContain("video=VIDEOaaaaa3");
  });
});

describe("YouTubeSection: ids no válidos o no disponibles", () => {
  it("id malformado: aviso, parámetro eliminado y vuelve al último video", async () => {
    stubApi();
    renderSection(["/youtube?a=1&video=INVALID"]);

    expect(await screen.findByText(UNAVAILABLE)).toBeTruthy();
    await waitFor(() => expect(url()).toBe("/youtube?a=1"));
    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa1"));
    expect(navType()).toBe("REPLACE");
  });

  it("id válido pero que no es del canal: NO se reproduce; aviso, limpieza y último video", async () => {
    stubApi();
    renderSection(["/youtube?video=AJENOaaaaa1"]);

    expect(await screen.findByText(UNAVAILABLE)).toBeTruthy();
    await waitFor(() => expect(url()).toBe("/youtube"));
    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa1"));
    expect(document.querySelector("iframe[src*='AJENOaaaaa1']")).toBeNull();
  });

  it("mientras las consultas cargan NO se limpia el parámetro ni se monta otro video", async () => {
    let release: (value: Response) => void = () => {};
    stubApi({ shorts: () => new Promise<Response>((resolve) => (release = resolve)) });
    renderSection(["/youtube?video=SHORTaaaaa1"]);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(url()).toBe("/youtube?video=SHORTaaaaa1");
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    expect(heroFrame()).toBeNull(); // ni el último video ni el pedido: solo un marcador
    expect(playing()).toHaveLength(0);

    await act(async () => release(json(SHORTS)));
    await waitFor(() => expect(heroId()).toBe("SHORTaaaaa1"));
    expect(url()).toBe("/youtube?video=SHORTaaaaa1");
  });

  it("si una consulta falla NO se destruye el deep link (fallo temporal)", async () => {
    stubApi({ shorts: () => json({ error: "x" }, 502) });
    renderSection(["/youtube?video=SHORTaaaaa1"]);

    await waitFor(() => expect(heroId()).toBe("VIDEOaaaaa1")); // respaldo: el último
    expect(url()).toBe("/youtube?video=SHORTaaaaa1");
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    expect(navType()).toBe("POP");
  });

  it("si falla la consulta del último video tampoco se limpia un id que no está en las listas", async () => {
    stubApi({ latest: () => json({ error: "x" }, 502) });
    renderSection(["/youtube?video=NUEVOaaaaa1"]);

    await screen.findByText("Más videos");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(url()).toBe("/youtube?video=NUEVOaaaaa1");
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
  });

  it("sin bucles: se limpia una sola vez y la URL se estabiliza", async () => {
    stubApi();
    renderSection(["/youtube?video=AJENOaaaaa1"]);
    await screen.findByText(UNAVAILABLE);
    await waitFor(() => expect(url()).toBe("/youtube"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(url()).toBe("/youtube");
    expect(navType()).toBe("REPLACE");
    expect(console.error).not.toHaveBeenCalled();
  });
});
