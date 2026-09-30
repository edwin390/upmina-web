import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CommunityFeedPost } from "@/types";
import CommunityFeedCard from "./CommunityFeedCard";

// Fase 9J-2B/9J-2B.1 (con like real en 9J-2C): la identidad del autor (avatar + display
// name/@username) enlaza al perfil público /@username; el contenido (texto + media) enlaza al
// detalle de la publicación (/community/post/:postId); el enlace de autor NUNCA abre la
// publicación, y la tarjeta no es un único enlace gigante (los tres enlaces son hermanos, nunca
// anidados unos dentro de otros). El control de like (CommunityLikeButton) es un <button>, no un
// <a>: no cambia el recuento de enlaces de estas pruebas, así que se cubre por separado en
// CommunityLikeButton.test.tsx.

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: null, user: null, loading: false, signOut: vi.fn() }),
}));

function post(overrides: Partial<CommunityFeedPost> = {}): CommunityFeedPost {
  return {
    id: "post-1",
    text: "hola comunidad",
    createdAt: "2026-03-02T10:00:00.000Z",
    author: { username: "kirito", displayName: "Kirito" },
    media: [],
    likeCount: 0,
    ...overrides,
  };
}

function renderCard(p: CommunityFeedPost) {
  return render(
    <MemoryRouter>
      <ul>
        <CommunityFeedCard post={p} likedByMe={false} />
      </ul>
    </MemoryRouter>,
  );
}

describe("CommunityFeedCard — enlaces de perfil", () => {
  it("el avatar enlaza a /@username", () => {
    renderCard(post());
    const avatarLink = screen.getByRole("link", { name: "Ver el perfil de @kirito" });
    expect(avatarLink).toHaveAttribute("href", "/@kirito");
  });

  it("la identidad (display name / @username) enlaza a /@username", () => {
    renderCard(post());
    const identityLink = screen.getByRole("link", { name: /Kirito/ });
    expect(identityLink).toHaveAttribute("href", "/@kirito");
  });

  it("usa el username canónico ya normalizado por el servidor, sin re-normalizar", () => {
    renderCard(post({ author: { username: "kirito", displayName: null } }));
    const profileLinks = screen
      .getAllByRole("link")
      .filter((l) => l.getAttribute("href")?.startsWith("/@"));
    expect(profileLinks.length).toBeGreaterThan(0);
    for (const link of profileLinks) {
      expect(link).toHaveAttribute("href", "/@kirito");
    }
  });
});

describe("CommunityFeedCard — abrir el detalle de la publicación", () => {
  it("el contenido (texto + media) enlaza a /community/post/:postId", () => {
    renderCard(post());
    const contentLink = screen.getByRole("link", { name: "Ver publicación completa" });
    expect(contentLink).toHaveAttribute("href", "/community/post/post-1");
  });

  it("el enlace de autor NUNCA abre la publicación (destinos distintos)", () => {
    renderCard(post());
    const profileLink = screen.getByRole("link", { name: /Kirito/ });
    expect(profileLink).toHaveAttribute("href", "/@kirito");
    expect(profileLink).not.toHaveAttribute("href", "/community/post/post-1");
  });

  it("exactamente 3 enlaces (avatar, identidad, contenido), ninguno anidado dentro de otro", () => {
    const { container } = renderCard(post());
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(3);
    for (const link of links) {
      const nestedLink = link.querySelector("a");
      expect(nestedLink).toBeNull();
    }
    expect(container.querySelectorAll("a")).toHaveLength(3);
  });
});

describe("CommunityFeedCard — media de vídeo (Fase 9J-3)", () => {
  it("publicación solo-imagen: sin cambios, sigue renderizando <img>, nunca <video>", () => {
    const { container } = renderCard(
      post({
        media: [
          {
            id: "m1",
            position: 0,
            kind: "image",
            url: "https://example.test/m1.webp",
            width: 1200,
            height: 1600,
            durationSeconds: null,
          },
        ],
      }),
    );
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelectorAll("video")).toHaveLength(0);
  });

  it("post solo-vídeo: renderiza <video> silenciado, playsInline, sin controles en el feed (la reproducción real vive en el detalle)", () => {
    const { container } = renderCard(
      post({
        media: [
          {
            id: "m1",
            position: 0,
            kind: "video",
            url: "https://example.test/m1.mp4",
            width: 1280,
            height: 720,
            durationSeconds: 10,
          },
        ],
      }),
    );
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video).toHaveProperty("muted", true);
    expect(video).toHaveProperty("playsInline", true);
    expect(video).not.toHaveAttribute("controls");
    expect(video).toHaveAttribute("src", "https://example.test/m1.mp4");
  });

  it("post mixto: renderiza imagen Y vídeo, respetando el orden por position (no muestra solo el primero)", () => {
    const { container } = renderCard(
      post({
        media: [
          {
            id: "m1",
            position: 0,
            kind: "image",
            url: "https://example.test/m1.webp",
            width: 800,
            height: 800,
            durationSeconds: null,
          },
          {
            id: "m2",
            position: 1,
            kind: "video",
            url: "https://example.test/m2.mp4",
            width: 800,
            height: 800,
            durationSeconds: 4,
          },
        ],
      }),
    );
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelectorAll("video")).toHaveLength(1);
  });

  it("el clic sobre la grilla de media sigue navegando al detalle (video no añade un enlace propio)", () => {
    renderCard(
      post({
        media: [
          {
            id: "m1",
            position: 0,
            kind: "video",
            url: "https://example.test/m1.mp4",
            width: 1280,
            height: 720,
            durationSeconds: null,
          },
        ],
      }),
    );
    // Sigue habiendo exactamente 3 enlaces (avatar/identidad/contenido) — el <video> nunca crea uno.
    expect(screen.getAllByRole("link")).toHaveLength(3);
  });
});

describe("CommunityFeedCard — media compacta en el feed (9J-3 follow-up)", () => {
  it("un único media vertical (9:16) NO hereda su alto natural: el contenedor usa una altura acotada, no el aspect-ratio del archivo", () => {
    const { container } = renderCard(
      post({
        media: [
          {
            id: "m1",
            position: 0,
            kind: "video",
            url: "https://example.test/vertical.mp4",
            width: 1080,
            height: 1920,
            durationSeconds: 20,
          },
        ],
      }),
    );
    const video = container.querySelector("video")!;
    // object-cover (no object-contain): llena la altura acotada del contenedor recortando en vez
    // de hacer letterboxing a un alto gigante.
    expect(video.className).toContain("object-cover");
    expect(video.className).toContain("h-full");
    expect(video.className).not.toContain("object-contain");
    // El contenedor (padre directo del <video>) lleva las clases de altura acotada y responsiva,
    // nunca una altura derivada del 1080x1920 del archivo.
    const wrapper = video.parentElement!;
    expect(wrapper.className).toMatch(/\bh-72\b/);
    expect(wrapper.className).toMatch(/\bsm:h-80\b/);
    expect(wrapper.className).toMatch(/\bmd:h-96\b/);
  });

  it("una única imagen vertical también usa la altura acotada (mismo tratamiento que vídeo)", () => {
    const { container } = renderCard(
      post({
        media: [
          {
            id: "m1",
            position: 0,
            kind: "image",
            url: "https://example.test/vertical.webp",
            width: 900,
            height: 1600,
            durationSeconds: null,
          },
        ],
      }),
    );
    const img = container.querySelector("img")!;
    expect(img.className).toContain("object-cover");
    expect(img.parentElement!.className).toMatch(/\bh-72\b/);
  });

  it("no fuerza una altura fija de escritorio en móvil: usa clases responsivas (h-72 base, crece con sm:/md:)", () => {
    const { container } = renderCard(
      post({
        media: [
          {
            id: "m1",
            position: 0,
            kind: "image",
            url: "https://example.test/m1.webp",
            width: 1200,
            height: 1600,
            durationSeconds: null,
          },
        ],
      }),
    );
    const wrapper = container.querySelector("img")!.parentElement!;
    // La clase base (móvil, sin prefijo de breakpoint) es MENOR que la de md: — nunca al revés.
    expect(wrapper.className).toMatch(/\bh-72\b/);
    expect(wrapper.className).not.toMatch(/\bh-96\b(?!\s*$)/); // h-96 solo debe aparecer prefijado (md:h-96)
    expect(wrapper.className).toMatch(/\bmd:h-96\b/);
  });

  it("post multi-imagen: la grilla sigue siendo de tiles cuadrados (ya compacta, sin regresión de este follow-up)", () => {
    const { container } = renderCard(
      post({
        media: [
          {
            id: "m1",
            position: 0,
            kind: "image",
            url: "https://example.test/m1.webp",
            width: 1200,
            height: 1600,
            durationSeconds: null,
          },
          {
            id: "m2",
            position: 1,
            kind: "video",
            url: "https://example.test/m2.mp4",
            width: 1080,
            height: 1920,
            durationSeconds: 5,
          },
        ],
      }),
    );
    const tiles = container.querySelectorAll("img, video");
    expect(tiles).toHaveLength(2);
    for (const tile of tiles) {
      expect(tile.parentElement!.className).toContain("aspect-square");
    }
  });

  it("el like sigue funcionando sin cambios junto a media compacta (regresión 9J-2C)", () => {
    renderCard(
      post({
        media: [
          {
            id: "m1",
            position: 0,
            kind: "video",
            url: "https://example.test/vertical.mp4",
            width: 1080,
            height: 1920,
            durationSeconds: 20,
          },
        ],
        likeCount: 5,
      }),
    );
    expect(screen.getByRole("button", { name: /me gusta \(5\)/i })).toBeInTheDocument();
  });
});
