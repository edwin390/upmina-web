import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CommunityFeedPost } from "@/types";
import CommunityFeedCard from "./CommunityFeedCard";

// Fase 9J-2B: la identidad del autor (avatar + display name/@username) enlaza al perfil público
// /@username; el resto de la tarjeta (texto, media, fecha) NUNCA es un enlace de perfil.

function post(overrides: Partial<CommunityFeedPost> = {}): CommunityFeedPost {
  return {
    id: "post-1",
    text: "hola comunidad",
    createdAt: "2026-03-02T10:00:00.000Z",
    author: { username: "kirito", displayName: "Kirito" },
    media: [],
    ...overrides,
  };
}

function renderCard(p: CommunityFeedPost) {
  return render(
    <MemoryRouter>
      <ul>
        <CommunityFeedCard post={p} />
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
    const links = screen.getAllByRole("link");
    for (const link of links) {
      expect(link).toHaveAttribute("href", "/@kirito");
    }
  });

  it("la tarjeta entera NO es un enlace de perfil: solo existen los dos enlaces de identidad", () => {
    renderCard(post());
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute("href", "/@kirito");
    }
    // El texto de la publicación no está dentro de ningún <a>.
    expect(screen.getByText("hola comunidad").closest("a")).toBeNull();
  });
});
