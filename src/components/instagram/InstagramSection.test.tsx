import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InstagramMediaItem } from "@/types";
import InstagramSection from "./InstagramSection";

// Fijan el modal de publicación: navegación entre posts (circular), navegación de
// elementos de un carrusel (independiente), regla de teclado, proporción real y
// comentarios. jsdom no implementa <dialog>.showModal ni carga imágenes: se simulan.

const IMG = "https://scontent.cdninstagram.com/v/foto.jpg";

function post(
  id: string,
  overrides: Partial<InstagramMediaItem> = {},
): InstagramMediaItem {
  return {
    id,
    mediaType: "IMAGE",
    imageUrl: IMG,
    permalink: `https://www.instagram.com/p/${id}/`,
    caption: `Caption ${id}`,
    timestamp: "2026-09-18T19:00:31+00:00",
    username: "upminaa",
    likeCount: 5,
    commentsCount: 0,
    ...overrides,
  };
}

const FEED = [
  post("1001", { mediaType: "CAROUSEL_ALBUM", caption: "Uno" }),
  post("1002", { caption: "Dos", likeCount: 7, commentsCount: 3 }),
  post("1003", { caption: "Tres", productType: "REELS" }),
];

const CHILDREN = [
  { id: "c1", mediaType: "IMAGE", imageUrl: `${IMG}?1` },
  { id: "c2", mediaType: "IMAGE", imageUrl: `${IMG}?2` },
  { id: "c3", mediaType: "IMAGE", imageUrl: `${IMG}?3` },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

type Routes = {
  feed?: () => Response;
  children?: () => Response;
  comments?: () => Response;
  profile?: () => Response;
};

const AVATAR = "https://scontent.cdninstagram.com/v/avatar.jpg";

function stubApi(routes: Routes = {}) {
  const fetchMock = vi.fn(async (input: string) => {
    if (input.startsWith("/api/instagram-feed"))
      return (routes.feed ?? (() => json(FEED)))();
    if (input.startsWith("/api/instagram-media")) {
      return (routes.children ?? (() => json({ children: CHILDREN })))();
    }
    if (input.startsWith("/api/instagram-profile")) {
      return (
        routes.profile ?? (() => json({ username: "upminaa", profilePictureUrl: AVATAR }))
      )();
    }
    if (input.startsWith("/api/instagram-comments")) {
      return (routes.comments ?? (() => json({ comments: [] })))();
    }
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <InstagramSection />
    </QueryClientProvider>,
  );
}

async function openPost(caption: string) {
  const card = await screen.findByRole("button", {
    name: new RegExp(`${caption}\\. Abrir`),
  });
  fireEvent.click(card);
  return screen.findByRole("dialog");
}

const nextPost = () =>
  fireEvent.click(screen.getAllByRole("button", { name: "Publicación siguiente" })[0]);
const prevPost = () =>
  fireEvent.click(screen.getAllByRole("button", { name: "Publicación anterior" })[0]);

const dialogCaption = () =>
  screen.getByRole("dialog").querySelector("p.whitespace-pre-line");

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
});

describe("navegación entre publicaciones", () => {
  it("siguiente y anterior cambian username, caption, likes, comentarios y permalink sin cerrar el modal", async () => {
    stubApi();
    renderSection();
    const dialog = await openPost("Uno");
    expect(dialogCaption()).toHaveTextContent("Uno");

    nextPost();
    expect(screen.getByRole("dialog")).toBe(dialog); // el mismo modal, sigue abierto
    expect(dialogCaption()).toHaveTextContent("Dos");
    expect(dialog).toHaveTextContent("7");
    expect(dialog).toHaveTextContent("Publicación 2 de 3");
    expect(screen.getByRole("link", { name: /Ver en Instagram/ })).toHaveAttribute(
      "href",
      "https://www.instagram.com/p/1002/",
    );

    prevPost();
    expect(dialogCaption()).toHaveTextContent("Uno");
  });

  it("es circular: último → siguiente → primero y primero → anterior → último", async () => {
    stubApi();
    renderSection();
    await openPost("Uno");

    prevPost(); // primero → anterior → último
    expect(dialogCaption()).toHaveTextContent("Tres");
    expect(screen.getByRole("dialog")).toHaveTextContent("Reel");

    nextPost(); // último → siguiente → primero
    expect(dialogCaption()).toHaveTextContent("Uno");
  });

  it("cambiar de post reinicia el carrusel en el elemento 1", async () => {
    stubApi();
    renderSection();
    await openPost("Uno");

    expect(await screen.findByText("1/3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Elemento siguiente" }));
    expect(screen.getByText("2/3")).toBeInTheDocument();

    nextPost();
    expect(dialogCaption()).toHaveTextContent("Dos");
    prevPost();
    expect(dialogCaption()).toHaveTextContent("Uno");
    expect(await screen.findByText("1/3")).toBeInTheDocument();
  });
});

describe("navegación de elementos del carrusel (nivel independiente)", () => {
  it("las flechas del visor y los puntos cambian de elemento sin cambiar de publicación", async () => {
    stubApi();
    renderSection();
    await openPost("Uno");
    await screen.findByText("1/3");

    fireEvent.click(screen.getByRole("button", { name: "Elemento siguiente" }));
    expect(screen.getByText("2/3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Elemento anterior" }));
    fireEvent.click(screen.getByRole("button", { name: "Elemento anterior" })); // circular
    expect(screen.getByText("3/3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ir al elemento 2 de 3" }));
    expect(screen.getByText("2/3")).toBeInTheDocument();

    expect(dialogCaption()).toHaveTextContent("Uno"); // el post no cambió
  });
});

describe("teclado ← →", () => {
  it("fuera del visor de un carrusel cambian de publicación", async () => {
    stubApi();
    renderSection();
    await openPost("Uno");

    fireEvent.keyDown(screen.getByRole("button", { name: "Cerrar" }), {
      key: "ArrowRight",
    });
    expect(dialogCaption()).toHaveTextContent("Dos");

    fireEvent.keyDown(screen.getByRole("button", { name: "Cerrar" }), {
      key: "ArrowLeft",
    });
    expect(dialogCaption()).toHaveTextContent("Uno");
  });

  it("con el foco en el visor de un carrusel cambian de elemento y NO de publicación", async () => {
    stubApi();
    renderSection();
    await openPost("Uno");
    await screen.findByText("1/3");

    const viewer = screen.getByRole("group", { name: "Uno" });
    fireEvent.keyDown(viewer, { key: "ArrowRight" });
    expect(screen.getByText("2/3")).toBeInTheDocument();
    expect(dialogCaption()).toHaveTextContent("Uno");

    fireEvent.keyDown(viewer, { key: "ArrowLeft" });
    expect(screen.getByText("1/3")).toBeInTheDocument();
    expect(dialogCaption()).toHaveTextContent("Uno");
  });

  it("con el foco en el visor de una publicación de un solo elemento sí cambian de publicación", async () => {
    stubApi();
    renderSection();
    await openPost("Dos");

    fireEvent.keyDown(screen.getByRole("group", { name: "Dos" }), { key: "ArrowRight" });
    expect(dialogCaption()).toHaveTextContent("Tres");
  });

  it("se ignoran con modificadores (Alt, Ctrl...)", async () => {
    stubApi();
    renderSection();
    await openPost("Dos");

    fireEvent.keyDown(screen.getByRole("button", { name: "Cerrar" }), {
      key: "ArrowRight",
      altKey: true,
    });
    expect(dialogCaption()).toHaveTextContent("Dos");
  });

  it("Escape cierra el modal", async () => {
    stubApi();
    renderSection();
    await openPost("Uno");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("proporción real del contenido", () => {
  function loadImage(width: number, height: number) {
    const img = screen.getByRole("dialog").querySelector("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
    fireEvent.load(img);
  }
  const paneRatio = () =>
    (screen.getByRole("group").parentElement as HTMLElement).style.getPropertyValue(
      "--ig-ratio",
    );

  it("vertical 4:5 → 0,8 (sin recortar ni forzar cuadrado)", async () => {
    stubApi();
    renderSection();
    await openPost("Dos");
    loadImage(1080, 1350);
    expect(Number(paneRatio())).toBeCloseTo(0.8);
    expect(screen.getByRole("dialog").querySelector("img")).toHaveClass("object-contain");
  });

  it("cuadrado 1:1 → 1", async () => {
    stubApi();
    renderSection();
    await openPost("Dos");
    loadImage(1080, 1080);
    expect(Number(paneRatio())).toBe(1);
  });

  it("horizontal → mayor que 1", async () => {
    stubApi();
    renderSection();
    await openPost("Dos");
    loadImage(1080, 566);
    expect(Number(paneRatio())).toBeGreaterThan(1.5);
  });
});

describe("comentarios en el modal", () => {
  it("comments_count > 0 y comentarios disponibles: muestra username, texto, fecha y like_count", async () => {
    const fetchMock = stubApi({
      comments: () =>
        json({
          comments: [
            {
              id: "k1",
              text: "Qué buena",
              username: "fan",
              timestamp: "2026-09-19T10:00:00+00:00",
              likeCount: 2,
            },
          ],
        }),
    });
    renderSection();
    const dialog = await openPost("Dos");

    expect(await screen.findByText("Qué buena")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("fan");
    expect(dialog).toHaveTextContent("3"); // comments_count del feed
    expect(fetchMock).toHaveBeenCalledWith("/api/instagram-comments?id=1002");
  });

  it("0 comentarios: lo dice y no consulta a Meta", async () => {
    const fetchMock = stubApi();
    renderSection();
    await openPost("Tres");

    expect(screen.getByText("Todavía no hay comentarios.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/instagram-comments"),
    );
  });

  it("permiso insuficiente (403): mensaje claro con el contador, sin comentarios inventados", async () => {
    stubApi({
      comments: () => json({ reason: "insufficient_permission" }, 403),
    });
    renderSection();
    const dialog = await openPost("Dos");

    expect(await screen.findByText(/3 comentarios en Instagram/)).toBeInTheDocument();
    expect(dialog).toHaveTextContent("instagram_business_manage_comments"); // aviso solo en dev
    expect(dialog.querySelectorAll("ul li")).toHaveLength(0);
  });

  it("error real del proveedor (502): mensaje genérico distinto del de permisos", async () => {
    stubApi({ comments: () => json({ error: "x" }, 502) });
    renderSection();
    await openPost("Dos");

    expect(
      await screen.findByText(
        "No se pudieron cargar los comentarios.",
        {},
        { timeout: 4000 },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/instagram_business_manage_comments/)).toBeNull();
  });
});

describe("comentarios: HTTP 200 con data:[] y comments_count > 0", () => {
  it("muestra el número y 'Ver comentarios en Instagram' con el permalink; NO habla de permisos", async () => {
    stubApi(); // /instagram-comments → { comments: [] } (200)
    renderSection();
    const dialog = await openPost("Dos");

    const link = await screen.findByRole("link", {
      name: /Ver comentarios en Instagram/,
    });
    expect(link).toHaveAttribute("href", "https://www.instagram.com/p/1002/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(dialog).toHaveTextContent("3 comentarios");
    expect(dialog).not.toHaveTextContent("instagram_business_manage_comments");
    expect(dialog).not.toHaveTextContent(/permiso/i);
    expect(dialog.querySelectorAll("section[aria-label=Comentarios] ul li")).toHaveLength(
      0,
    );
  });

  it("con 0 comentarios no aparece el enlace", async () => {
    stubApi();
    renderSection();
    await openPost("Tres");
    expect(
      screen.queryByRole("link", { name: /Ver comentarios en Instagram/ }),
    ).toBeNull();
  });

  it("solo un 403 explícito habla de permisos (y también ofrece el enlace)", async () => {
    stubApi({ comments: () => json({ reason: "insufficient_permission" }, 403) });
    renderSection();
    const dialog = await openPost("Dos");

    expect(
      await screen.findByText(/no se pueden mostrar aquí todavía/),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent("instagram_business_manage_comments");
    expect(
      screen.getByRole("link", { name: /Ver comentarios en Instagram/ }),
    ).toBeInTheDocument();
  });
});

describe("foto de perfil", () => {
  const avatarIn = (root: ParentNode) =>
    root.querySelector<HTMLImageElement>(`img[src="${AVATAR}"]`);

  it("se muestra junto al username en el modal y en la cabecera de la sección", async () => {
    stubApi();
    renderSection();
    await screen.findAllByRole("button", { name: /Abrir publicación/ });
    await waitFor(() => expect(avatarIn(document.body)).not.toBeNull());
    expect(avatarIn(document.body)).toHaveClass("rounded-full");

    const dialog = await openPost("Uno");
    const header = dialog.querySelector("header") as HTMLElement;
    expect(avatarIn(header)).not.toBeNull();
    expect(avatarIn(header)).toHaveClass("rounded-full");
    expect(header).toHaveTextContent("upminaa");
  });

  it("una sola petición de perfil aunque se abran y recorran varias publicaciones", async () => {
    const fetchMock = stubApi();
    renderSection();
    await openPost("Uno");
    nextPost();
    nextPost();
    prevPost();

    await waitFor(() => expect(avatarIn(screen.getByRole("dialog"))).not.toBeNull());
    const profileCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith("/api/instagram-profile"),
    );
    expect(profileCalls).toHaveLength(1);
  });

  it("sin foto (Meta solo devuelve username) usa el fallback con la inicial", async () => {
    stubApi({ profile: () => json({ username: "upminaa" }) });
    renderSection();
    const dialog = await openPost("Uno");

    const header = dialog.querySelector("header") as HTMLElement;
    expect(header.querySelector("img")).toBeNull();
    expect(header.querySelector("span[aria-hidden=true]")).toHaveTextContent("u");
    expect(header).toHaveTextContent("upminaa");
  });

  it("si el perfil falla (502) el modal y la sección siguen funcionando con el fallback", async () => {
    stubApi({ profile: () => json({ error: "x" }, 502) });
    renderSection();
    const dialog = await openPost("Uno");

    const header = dialog.querySelector("header") as HTMLElement;
    expect(header.querySelector("img")).toBeNull();
    expect(header).toHaveTextContent("upminaa"); // el username sale del feed
    expect(dialogCaption()).toHaveTextContent("Uno");
  });

  it("si la imagen no carga, cae al fallback sin romper la UI", async () => {
    stubApi();
    renderSection();
    const dialog = await openPost("Uno");

    const header = dialog.querySelector("header") as HTMLElement;
    await waitFor(() => expect(avatarIn(header)).not.toBeNull());
    fireEvent.error(avatarIn(header) as HTMLImageElement);
    expect(avatarIn(header)).toBeNull();
    expect(header.querySelector("span[aria-hidden=true]")).toHaveTextContent("u");
  });
});

describe("comentarios: estado DESCONOCIDO (commentsCount ausente)", () => {
  // Meta rechazó los campos extendidos y el feed llegó sin `comments_count`.
  const unknownFeed = () =>
    json([post("2001", { caption: "Sin dato", commentsCount: undefined })]);

  it("no afirma que no haya comentarios ni habla de permisos: neutral + enlace a Instagram", async () => {
    const fetchMock = stubApi({ feed: unknownFeed }); // /comments → 200 con lista vacía
    renderSection();
    const dialog = await openPost("Sin dato");

    expect(
      await screen.findByText("Los comentarios pueden consultarse en Instagram."),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Ver comentarios en Instagram/ });
    expect(link).toHaveAttribute("href", "https://www.instagram.com/p/2001/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.queryByText(/Todavía no hay comentarios/)).toBeNull();
    expect(dialog).not.toHaveTextContent(/permiso/i);
    expect(dialog).not.toHaveTextContent("instagram_business_manage_comments");
    expect(dialog).not.toHaveTextContent(/\d+ comentarios?/); // no inventa ningún número
    // Como no se conoce el total, sí se consulta a Meta.
    expect(fetchMock).toHaveBeenCalledWith("/api/instagram-comments?id=2001");
  });

  it("con comentarios reales disponibles los muestra (el estado neutral no aparece)", async () => {
    stubApi({
      feed: unknownFeed,
      comments: () => json({ comments: [{ id: "k1", text: "Genial", username: "fan" }] }),
    });
    renderSection();
    await openPost("Sin dato");

    expect(await screen.findByText("Genial")).toBeInTheDocument();
    expect(
      screen.queryByText("Los comentarios pueden consultarse en Instagram."),
    ).toBeNull();
  });

  it("un 403 explícito sigue siendo el único caso que habla de permisos (caso A intacto)", async () => {
    stubApi({
      feed: unknownFeed,
      comments: () => json({ reason: "insufficient_permission" }, 403),
    });
    renderSection();
    const dialog = await openPost("Sin dato");

    expect(
      await screen.findByText(/no se pueden mostrar aquí todavía/),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent("instagram_business_manage_comments"); // aviso solo en dev
    expect(screen.queryByText(/Todavía no hay comentarios/)).toBeNull();
  });

  it("un error del proveedor (502) sigue siendo un fallo genérico (caso B intacto)", async () => {
    stubApi({ feed: unknownFeed, comments: () => json({ error: "x" }, 502) });
    renderSection();
    await openPost("Sin dato");

    expect(
      await screen.findByText(
        "No se pudieron cargar los comentarios.",
        {},
        { timeout: 4000 },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Todavía no hay comentarios/)).toBeNull();
    expect(
      screen.queryByText("Los comentarios pueden consultarse en Instagram."),
    ).toBeNull();
  });

  it("con commentsCount === 0 (caso D) sigue diciendo que no hay comentarios y no consulta a Meta", async () => {
    const fetchMock = stubApi({
      feed: () => json([post("2002", { caption: "Cero", commentsCount: 0 })]),
    });
    renderSection();
    await openPost("Cero");

    expect(screen.getByText("Todavía no hay comentarios.")).toBeInTheDocument();
    expect(
      screen.queryByText("Los comentarios pueden consultarse en Instagram."),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/instagram-comments"),
    );
  });
});

describe("modal: scroll, foco, desmontaje y video", () => {
  afterEach(() => {
    document.body.style.overflow = "";
  });

  it("bloquea el scroll del documento al abrir y lo restaura tal cual estaba al cerrar", async () => {
    stubApi();
    document.body.style.overflow = "scroll";
    renderSection();
    await openPost("Dos");
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("navegar entre publicaciones no toca el bloqueo; Escape lo restaura", async () => {
    stubApi();
    renderSection();
    await openPost("Uno");

    nextPost();
    nextPost();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("foco inicial en el botón Cerrar y, al cerrar, vuelve a la tarjeta que abrió el modal", async () => {
    stubApi();
    renderSection();
    const card = await screen.findByRole("button", { name: /Dos\. Abrir/ });
    fireEvent.click(card);
    await screen.findByRole("dialog");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cerrar" }));

    nextPost(); // navegar no cambia la tarjeta de retorno
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));

    await waitFor(() => expect(document.activeElement).toBe(card));
  });

  it("desmontar la sección con el modal abierto restaura el scroll, quita el diálogo y sus listeners", async () => {
    stubApi();
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    const view = renderSection();
    await openPost("Dos");
    expect(document.body.style.overflow).toBe("hidden");

    view.unmount();

    expect(document.querySelector("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    const count = (spy: typeof added, type: string) =>
      spy.mock.calls.filter(([t]) => t === type).length;
    expect(count(removed, "keydown")).toBe(count(added, "keydown"));
  });

  it("cerrar deja el DOM sin imágenes ni videos del modal", async () => {
    stubApi();
    renderSection();
    await openPost("Uno");
    expect(screen.getByRole("dialog").querySelector("img")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));

    expect(document.querySelector("dialog")).toBeNull();
    expect(document.querySelector("video")).toBeNull();
  });

  describe("video", () => {
    const VIDEO_FILE = "https://scontent.cdninstagram.com/v/video.mp4";
    const videoFeed = () =>
      json([
        post("4001", {
          mediaType: "VIDEO",
          videoUrl: VIDEO_FILE,
          productType: "REELS",
          caption: "Reel",
        }),
        post("4002", { caption: "Foto" }),
      ]);

    it("un Reel se reproduce con controles nativos, sin autoplay y solo carga los metadatos", async () => {
      stubApi({ feed: videoFeed });
      renderSection();
      const dialog = await openPost("Reel");

      const video = dialog.querySelector("video") as HTMLVideoElement;
      expect(video.getAttribute("src")).toBe(VIDEO_FILE);
      expect(video.controls).toBe(true);
      expect(video.autoplay).toBe(false);
      expect(video.hasAttribute("autoplay")).toBe(false);
      expect(video.getAttribute("preload")).toBe("metadata");
      expect(video.getAttribute("poster")).toBe(IMG);
    });

    it("el video se desmonta al cambiar de publicación y al cerrar", async () => {
      stubApi({ feed: videoFeed });
      renderSection();
      const dialog = await openPost("Reel");
      const video = dialog.querySelector("video") as HTMLVideoElement;

      nextPost();
      expect(video.isConnected).toBe(false);
      expect(document.querySelector("video")).toBeNull();

      prevPost();
      const again = document.querySelector("video") as HTMLVideoElement;
      expect(again).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
      expect(again.isConnected).toBe(false);
      expect(document.querySelector("video")).toBeNull();
    });

    it("en un carrusel, el video de un elemento se desmonta al pasar al siguiente", async () => {
      stubApi({
        children: () =>
          json({
            children: [
              { id: "v1", mediaType: "VIDEO", imageUrl: IMG, videoUrl: VIDEO_FILE },
              { id: "i2", mediaType: "IMAGE", imageUrl: `${IMG}?2` },
            ],
          }),
      });
      renderSection();
      const dialog = await openPost("Uno");

      await waitFor(() => expect(dialog.querySelector("video")).not.toBeNull());
      const video = dialog.querySelector("video") as HTMLVideoElement;
      expect(video.autoplay).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Elemento siguiente" }));

      expect(video.isConnected).toBe(false);
      expect(dialog.querySelector("video")).toBeNull();
    });
  });
});
