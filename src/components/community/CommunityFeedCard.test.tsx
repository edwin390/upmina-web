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
