import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { freshContentUrl } from "@/lib/content-freshness";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

// /@username (Fase 9J-2B, ampliado en 9J-2B.1): perfil público — estados de carga/no-encontrado/
// error/vacío/contenido, jerarquía TikTok-style (avatar, display name, @username, bio, N
// publicaciones, SIN likes fabricados), galería de 3 columnas cuyas tarjetas ahora abren el
// detalle de la publicación, y — NUEVO en 9J-2B.1 — controles de dueño (Editar perfil/Nueva
// publicación/gestión ⋯ por publicación/atajo ADMIN) que SOLO aparecen cuando el visitante
// autenticado es, de verdad, el dueño de ESE perfil (derivado de useOwnProfile, nunca del
// username de la URL).

const ownProfileFakes = vi.hoisted(() => ({
  profile: null as {
    username: string;
    displayName: string | null;
    bio: string | null;
  } | null,
}));
vi.mock("@/hooks/useOwnProfile", () => ({
  useOwnProfile: () => ({
    profile: ownProfileFakes.profile,
    isLoading: false,
    hasSession: ownProfileFakes.profile !== null,
    isError: false,
    invalidate: async () => {},
  }),
}));

const adminAccessFakes = vi.hoisted(() => ({
  status: "no-session" as "no-session" | "ready",
  role: null as "admin" | "moderator" | "developer" | null,
  capabilities: [] as string[],
}));
vi.mock("@/hooks/useAdminAccess", () => ({
  useAdminAccess: () => ({
    status: adminAccessFakes.status,
    access:
      adminAccessFakes.status === "ready"
        ? {
            role: adminAccessFakes.role,
            capabilities: adminAccessFakes.capabilities,
            mfaRecent: false,
          }
        : null,
    refetch: async () => null,
    invalidate: async () => {},
  }),
}));

const communityClientMocks = vi.hoisted(() => ({
  listOwnCommunityPosts: vi.fn(),
  saveCommunityPost: vi.fn(),
  deleteCommunityPost: vi.fn(),
}));
vi.mock("@/lib/community-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community-client")>(
    "@/lib/community-client",
  );
  return {
    ...actual,
    listOwnCommunityPosts: communityClientMocks.listOwnCommunityPosts,
    saveCommunityPost: communityClientMocks.saveCommunityPost,
    deleteCommunityPost: communityClientMocks.deleteCommunityPost,
  };
});

const uploadMocks = vi.hoisted(() => ({
  addFiles: vi.fn(),
  remove: vi.fn(),
  retry: vi.fn(),
  items: [] as unknown[],
}));
vi.mock("@/hooks/useMediaUpload", () => ({
  useMediaUpload: () => ({
    items: uploadMocks.items,
    addFiles: uploadMocks.addFiles,
    remove: uploadMocks.remove,
    retry: uploadMocks.retry,
    release: vi.fn(),
  }),
}));

const { default: ProfilePage } = await import("./ProfilePage");
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    user: { id: "test-owner" },
    session: { access_token: "synthetic" },
    loading: false,
  }),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function mediaItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "media-1",
    position: 0,
    kind: "image",
    url: "https://example.test/media-1.webp",
    width: 1200,
    height: 1600,
    ...overrides,
  };
}

function post(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    text: "hola comunidad",
    createdAt: "2026-03-02T10:00:00.000Z",
    author: { username: "edwin1", displayName: null },
    media: [],
    likeCount: 0,
    ...overrides,
  };
}

function ownPost(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    text: "hola comunidad",
    status: "published",
    version: 1,
    createdAt: "2026-03-02T10:00:00.000Z",
    updatedAt: "2026-03-02T10:00:00.000Z",
    media: [],
    likeCount: 0,
    resolvedNoticeUnseen: false,
    ...overrides,
  };
}

function profilePage(overrides: Record<string, unknown> = {}) {
  return {
    profile: {
      username: "edwin1",
      displayName: null,
      bio: null,
      postCount: 0,
      totalLikes: 0,
      ...(overrides.profile as Record<string, unknown> | undefined),
    },
    posts: { items: [], nextCursor: null, ...(overrides.posts as object | undefined) },
  };
}

function stubProfile(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => json(body, status));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function ModerationDestination() {
  const location = useLocation();
  return (
    <p>
      {location.pathname} cancel:{location.state?.cancelTo}
    </p>
  );
}
function PrivatePostDestination() {
  const location = useLocation();
  return <p>Private context: {location.state?.ownerProfilePostId ?? "none"}</p>;
}

function renderProfile(
  entry = "/@edwin1",
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/:usernameParam" element={<ProfilePage />} />
          <Route path="/community" element={<p>Comunidad stub</p>} />
          <Route path="/account" element={<p>Account stub</p>} />
          <Route
            path="/admin"
            element={
              <>
                <p>Admin stub</p>
                <ModerationDestination />
              </>
            }
          />
          <Route path="/admin/moderation" element={<ModerationDestination />} />
          <Route
            path="/community/post/:postId"
            element={
              <>
                <p>Post detail stub</p>
                <PrivatePostDestination />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  ownProfileFakes.profile = null;
  adminAccessFakes.status = "no-session";
  adminAccessFakes.role = null;
  adminAccessFakes.capabilities = [];
  communityClientMocks.listOwnCommunityPosts.mockReset();
  communityClientMocks.listOwnCommunityPosts.mockResolvedValue({ items: [] });
  communityClientMocks.saveCommunityPost.mockReset();
  communityClientMocks.deleteCommunityPost.mockReset();
  uploadMocks.addFiles.mockReset();
  uploadMocks.items = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/@username — estados", () => {
  it.each([
    ["hidden_pending_review", "Publicación pausada"],
    ["removed_pending_purge", "Retirada"],
  ])("owner discovers %s privately with delete but no edit", async (status, label) => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    communityClientMocks.listOwnCommunityPosts.mockResolvedValue({
      items: [ownPost("private-post", { status })],
    });
    stubProfile(profilePage());
    renderProfile();
    await screen.findByText(label);
    fireEvent.click(screen.getByRole("button", { name: "Gestionar esta publicación" }));
    expect(screen.queryByRole("menuitem", { name: "Editar" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Eliminar" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: /Publicación de texto/ }));
    expect(await screen.findByText("Private context: private-post")).toBeInTheDocument();
  });
  it("R4-C: own Profile shows 'Caso resuelto' only for a published post with an unseen valid notice", async () => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    communityClientMocks.listOwnCommunityPosts.mockResolvedValue({
      items: [ownPost("resolved-post", { resolvedNoticeUnseen: true })],
    });
    stubProfile(profilePage());
    renderProfile();
    expect(await screen.findByText("Caso resuelto")).toBeInTheDocument();
    expect(screen.queryByText("Retirada")).toBeNull();
    expect(screen.queryByText("Publicación pausada")).toBeNull();
  });
  it("R4-C: seen notice or normal post (flag false) shows no 'Caso resuelto'", async () => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    communityClientMocks.listOwnCommunityPosts.mockResolvedValue({
      items: [ownPost("normal-post", { resolvedNoticeUnseen: false })],
    });
    stubProfile(profilePage());
    renderProfile();
    await screen.findByRole("link", { name: /Publicación de texto/ });
    expect(screen.queryByText("Caso resuelto")).toBeNull();
  });
  it("R4-C: restrictive states take priority over the informative chip", async () => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    communityClientMocks.listOwnCommunityPosts.mockResolvedValue({
      items: [
        ownPost("p1", { status: "removed_pending_purge", resolvedNoticeUnseen: true }),
      ],
    });
    stubProfile(profilePage());
    renderProfile();
    await screen.findByText("Retirada");
    expect(screen.queryByText("Caso resuelto")).toBeNull();
  });
  it("R4-C: a fresh own-posts read after the ACK no longer shows the chip", async () => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    communityClientMocks.listOwnCommunityPosts
      .mockResolvedValueOnce({ items: [ownPost("p1", { resolvedNoticeUnseen: true })] })
      .mockResolvedValue({ items: [ownPost("p1", { resolvedNoticeUnseen: false })] });
    stubProfile(profilePage());
    const first = renderProfile();
    await screen.findByText("Caso resuelto");
    first.unmount();
    stubProfile(profilePage());
    renderProfile();
    await screen.findByRole("link", { name: /Publicación de texto/ });
    expect(screen.queryByText("Caso resuelto")).toBeNull();
  });
  it("R4-C: another user's profile never reads or renders the private flag", async () => {
    ownProfileFakes.profile = { username: "otro-usuario", displayName: null, bio: null };
    communityClientMocks.listOwnCommunityPosts.mockResolvedValue({
      items: [ownPost("p1", { resolvedNoticeUnseen: true })],
    });
    stubProfile(
      profilePage({
        posts: {
          items: [
            post("p1", { resolvedNoticeUnseen: true, text: "publicación pública" }),
          ],
        },
      }),
    );
    renderProfile();
    await screen.findByText("publicación pública");
    expect(screen.queryByText("Caso resuelto")).toBeNull();
    expect(communityClientMocks.listOwnCommunityPosts).not.toHaveBeenCalled();
  });
  it("owner list failure does not claim empty profile", async () => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    communityClientMocks.listOwnCommunityPosts.mockRejectedValue(
      new Error("invalid_response"),
    );
    stubProfile(profilePage());
    renderProfile();
    await screen.findByText("No se pudieron cargar tus publicaciones.");
    expect(screen.queryByText("Todavía no hay publicaciones")).toBeNull();
  });
  it("carga: muestra un estado de carga", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    renderProfile();
    expect(screen.getByText("Cargando perfil…")).toBeInTheDocument();
  });

  it("perfil inexistente (404): estado específico de no-encontrado, no un 404 genérico del sitio", async () => {
    stubProfile({ error: "Perfil no encontrado" }, 404);
    renderProfile();
    expect(await screen.findByText("Este perfil no existe")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver a Comunidad" })).toHaveAttribute(
      "href",
      "/community",
    );
  });

  it("error de servidor: estado con reintento", async () => {
    stubProfile({ error: "Error interno" }, 500);
    renderProfile();
    expect(await screen.findByText("No se pudo cargar este perfil.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
  });

  it("perfil existente sin publicaciones: estado vacío específico", async () => {
    stubProfile(profilePage());
    renderProfile();
    expect(await screen.findByText("Todavía no hay publicaciones")).toBeInTheDocument();
  });
});

describe("/@username — encabezado (jerarquía tipo TikTok)", () => {
  it("muestra @username, displayName y bio cuando existen", async () => {
    stubProfile(
      profilePage({
        profile: { displayName: "Edwin", bio: "Fan de Mina", postCount: 3 },
      }),
    );
    renderProfile();
    expect(await screen.findByText("Edwin")).toBeInTheDocument();
    expect(screen.getByText("@edwin1")).toBeInTheDocument();
    expect(screen.getByText("Fan de Mina")).toBeInTheDocument();
    expect(screen.getByText("3 publicaciones")).toBeInTheDocument();
  });

  it("displayName ausente: no se inventa un nombre, solo @username", async () => {
    stubProfile(profilePage());
    renderProfile();
    await screen.findByText("@edwin1");
    expect(screen.getAllByText("@edwin1")).toHaveLength(1);
  });

  it("1 publicación: singular correcto", async () => {
    stubProfile(profilePage({ profile: { postCount: 1 } }));
    renderProfile();
    expect(await screen.findByText("1 publicación")).toBeInTheDocument();
  });
});

describe("/@username — total de likes (Fase 9J-2C)", () => {
  it("muestra el total REAL de likes junto al recuento de publicaciones", async () => {
    stubProfile(profilePage({ profile: { postCount: 5, totalLikes: 347 } }));
    renderProfile();
    await screen.findByText("5 publicaciones");
    expect(screen.getByText("347 Me gusta")).toBeInTheDocument();
  });

  it("0 likes es un valor válido: se muestra, nunca se omite ni se fabrica otro número", async () => {
    stubProfile(profilePage({ profile: { postCount: 2, totalLikes: 0 } }));
    renderProfile();
    await screen.findByText("2 publicaciones");
    expect(screen.getByText("0 Me gusta")).toBeInTheDocument();
  });

  it("1 like: singular correcto", async () => {
    stubProfile(profilePage({ profile: { totalLikes: 1 } }));
    renderProfile();
    expect(await screen.findByText("1 Me gusta")).toBeInTheDocument();
  });

  it("nunca muestra contador de seguidores/siguiendo (fuera de alcance)", async () => {
    stubProfile(profilePage({ profile: { postCount: 5, totalLikes: 347 } }));
    renderProfile();
    await screen.findByText("347 Me gusta");
    expect(screen.queryByText(/seguidor|siguiendo|follower/i)).toBeNull();
  });
});

describe("/@username — galería", () => {
  it("grid de 3 columnas en desktop", async () => {
    stubProfile(profilePage({ posts: { items: [post("p1")], nextCursor: null } }));
    const { container } = renderProfile();
    await screen.findByRole("list");
    expect(container.querySelector("ul.grid-cols-3")).not.toBeNull();
  });

  it("publicación con imagen: usa la primera media ready como cover (object-cover permitido aquí)", async () => {
    stubProfile(
      profilePage({
        posts: {
          items: [post("p1", { text: null, media: [mediaItem()] })],
          nextCursor: null,
        },
      }),
    );
    const { container } = renderProfile();
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(1));
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("src", "https://example.test/media-1.webp");
    expect(img.className).toContain("object-cover");
  });

  it("publicación con varias imágenes: indicador multi-media con el recuento", async () => {
    stubProfile(
      profilePage({
        posts: {
          items: [
            post("p1", {
              text: null,
              media: [
                mediaItem({ id: "m1" }),
                mediaItem({ id: "m2", url: "https://example.test/media-2.webp" }),
                mediaItem({ id: "m3", url: "https://example.test/media-3.webp" }),
              ],
            }),
          ],
          nextCursor: null,
        },
      }),
    );
    renderProfile();
    expect(await screen.findByText("+3")).toBeInTheDocument();
  });

  it("publicación cuyo primer/único media es vídeo: tile de vídeo (<video>) con indicador, sin autoplay (Fase 9J-3)", async () => {
    stubProfile(
      profilePage({
        posts: {
          items: [
            post("p1", {
              text: null,
              media: [
                mediaItem({
                  id: "m1",
                  kind: "video",
                  url: "https://example.test/media-1.mp4",
                }),
              ],
            }),
          ],
          nextCursor: null,
        },
      }),
    );
    const { container } = renderProfile();
    await waitFor(() => expect(container.querySelectorAll("video")).toHaveLength(1));
    const video = container.querySelector("video")!;
    expect(video).toHaveAttribute("src", "https://example.test/media-1.mp4");
    expect(video).not.toHaveAttribute("autoplay");
    expect(video).toHaveProperty("muted", true);
    // Indicador sutil de vídeo (nunca un botón de reproducción interactivo en la galería).
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("publicación mixta que EMPIEZA con imagen: sigue usando esa imagen como cover, nunca reordena para preferir el vídeo", async () => {
    stubProfile(
      profilePage({
        posts: {
          items: [
            post("p1", {
              text: null,
              media: [
                mediaItem({ id: "m1", url: "https://example.test/cover.webp" }),
                mediaItem({
                  id: "m2",
                  position: 1,
                  kind: "video",
                  url: "https://example.test/media-2.mp4",
                }),
              ],
            }),
          ],
          nextCursor: null,
        },
      }),
    );
    const { container } = renderProfile();
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(1));
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/cover.webp",
    );
    expect(container.querySelectorAll("video")).toHaveLength(0);
  });

  it("clicar un tile de vídeo sigue abriendo el detalle de la publicación", async () => {
    stubProfile(
      profilePage({
        posts: {
          items: [
            post("p1", {
              text: null,
              media: [mediaItem({ id: "m1", kind: "video" })],
            }),
          ],
          nextCursor: null,
        },
      }),
    );
    renderProfile();
    const tile = await screen.findByRole("link", { name: /1 video/ });
    expect(tile).toHaveAttribute("href", "/community/post/p1");
  });

  it("publicación de solo texto: tile de texto estilizado, nunca en blanco", async () => {
    stubProfile(
      profilePage({
        posts: { items: [post("p1", { text: "solo texto aquí" })], nextCursor: null },
      }),
    );
    renderProfile();
    expect(await screen.findByText("solo texto aquí")).toBeInTheDocument();
  });

  it("cada tile es un enlace enfocable por teclado que abre el detalle de la publicación", async () => {
    stubProfile(
      profilePage({
        posts: {
          items: [post("p1", { text: null, media: [mediaItem()] })],
          nextCursor: null,
        },
      }),
    );
    renderProfile();
    const tile = await screen.findByRole("link", { name: /1 imagen/ });
    expect(tile).toHaveAttribute("href", "/community/post/p1");
    tile.focus();
    expect(document.activeElement).toBe(tile);
  });

  it("cada tile muestra su likeCount de forma sutil, solo lectura (Fase 9J-2C)", async () => {
    stubProfile(
      profilePage({
        posts: {
          items: [post("p1", { text: null, media: [mediaItem()], likeCount: 8 })],
          nextCursor: null,
        },
      }),
    );
    const { container } = renderProfile();
    await screen.findByRole("list");
    expect(container.textContent).toContain("8");
    // Solo lectura a nivel de galería: el badge no es un control interactivo (nunca un <button>
    // de like en el grid — eso vive en el feed/detalle).
    expect(screen.queryByRole("button", { name: /me gusta/i })).toBeNull();
  });

  it("activar el tile sigue abriendo el detalle (el badge de likes nunca lo intercepta)", async () => {
    stubProfile(
      profilePage({
        posts: {
          items: [post("p1", { text: null, media: [mediaItem()], likeCount: 8 })],
          nextCursor: null,
        },
      }),
    );
    renderProfile();
    const tile = await screen.findByRole("link", { name: /1 imagen/ });
    expect(tile).toHaveAttribute("href", "/community/post/p1");
  });
});

describe("/@username — visitante: sin controles de dueño", () => {
  it("no expone Editar perfil, Nueva publicación, gestión ⋯ ni atajo ADMIN", async () => {
    stubProfile(
      profilePage({
        profile: { postCount: 1 },
        posts: { items: [post("p1")], nextCursor: null },
      }),
    );
    renderProfile();
    await screen.findByText("1 publicación");
    expect(screen.queryByRole("link", { name: "Editar perfil" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Nueva publicación" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Gestionar esta publicación" }),
    ).toBeNull();
    expect(screen.queryByText(/panel de administración/i)).toBeNull();
  });

  it("un ADMIN visitando OTRO perfil no ve su propio atajo inyectado ahí", async () => {
    ownProfileFakes.profile = { username: "kirito", displayName: null, bio: null };
    adminAccessFakes.status = "ready";
    adminAccessFakes.role = "admin";
    stubProfile(profilePage({ profile: { postCount: 1 } }));
    renderProfile("/@edwin1");
    await screen.findByText("1 publicación");
    expect(screen.queryByText(/panel de administración/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Nueva publicación" })).toBeNull();
  });
});

describe("/@username — dueño: controles propios", () => {
  it("muestra Editar perfil (-> /account) y Nueva publicación", async () => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    stubProfile(profilePage());
    renderProfile();
    await screen.findByText("Todavía no hay publicaciones");
    expect(screen.getByRole("link", { name: "Editar perfil" })).toHaveAttribute(
      "href",
      "/account",
    );
    expect(screen.getByRole("button", { name: "Nueva publicación" })).toBeInTheDocument();
  });

  it("ownership se deriva de la identidad autenticada, no del username de la URL (manipular la URL no otorga controles)", async () => {
    // El propio usuario es "kirito", pero visita /@edwin1 (otro perfil): sin controles de dueño.
    ownProfileFakes.profile = { username: "kirito", displayName: null, bio: null };
    stubProfile(profilePage({ profile: { username: "edwin1" } }));
    renderProfile("/@edwin1");
    await screen.findByText("Todavía no hay publicaciones");
    expect(screen.queryByRole("link", { name: "Editar perfil" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Nueva publicación" })).toBeNull();
  });

  it("ADMIN viendo su PROPIO perfil ve el atajo Panel de administración -> /admin", async () => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    adminAccessFakes.status = "ready";
    adminAccessFakes.role = "admin";
    stubProfile(profilePage());
    renderProfile();
    const link = await screen.findByRole("link", { name: "Panel de administración" });
    expect(link).toHaveAttribute("href", "/admin");
    fireEvent.click(link);
    expect(await screen.findByText("/admin cancel:/@edwin1")).toBeInTheDocument();
  });
  it.each(["admin", "moderator", "developer"] as const)(
    "own profile moderation shortcut is independent and stacked (%s)",
    async (role) => {
      ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
      adminAccessFakes.status = "ready";
      adminAccessFakes.role = role;
      adminAccessFakes.capabilities = ["moderation"];
      stubProfile(profilePage());
      renderProfile();
      const link = await screen.findByRole("link", { name: "Panel de moderación" });
      expect(link).toHaveAttribute("href", "/admin/moderation");
      expect(link.parentElement).toHaveClass("flex-col");
      if (role === "admin")
        expect(link.previousElementSibling).toHaveTextContent("Panel de administración");
      else
        expect(
          screen.queryByRole("link", { name: "Panel de administración" }),
        ).toBeNull();
      fireEvent.click(link);
      expect(
        await screen.findByText("/admin/moderation cancel:/@edwin1"),
      ).toBeInTheDocument();
    },
  );

  it("un usuario normal (no ADMIN) no ve el atajo", async () => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    adminAccessFakes.status = "ready";
    adminAccessFakes.role = null;
    stubProfile(profilePage());
    renderProfile();
    await screen.findByText("Todavía no hay publicaciones");
    expect(screen.queryByText(/panel de administración/i)).toBeNull();
    expect(screen.queryByRole("link", { name: "Panel de moderación" })).toBeNull();
  });

  it("nunca inventa un panel de moderador o desarrollador", async () => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    adminAccessFakes.status = "ready";
    adminAccessFakes.role = "moderator";
    stubProfile(profilePage());
    renderProfile();
    await screen.findByText("Todavía no hay publicaciones");
    expect(screen.queryByText(/panel de moderador/i)).toBeNull();
    expect(screen.queryByText(/panel de desarroll/i)).toBeNull();
    expect(screen.queryByText(/panel de administración/i)).toBeNull();
  });

  it("la galería del dueño usa listOwnCommunityPosts (con ⋯ de gestión), no el feed público paginado", async () => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    communityClientMocks.listOwnCommunityPosts.mockResolvedValue({
      items: [ownPost("own-1")],
    });
    stubProfile(profilePage());
    renderProfile();
    await waitFor(() =>
      expect(communityClientMocks.listOwnCommunityPosts).toHaveBeenCalled(),
    );
    expect(
      await screen.findByRole("button", { name: "Gestionar esta publicación" }),
    ).toBeInTheDocument();
  });
});

describe("/@username — Nueva publicación (dueño)", () => {
  it("publicar actualiza un feed previamente fresh a través del callback real del perfil", async () => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    communityClientMocks.saveCommunityPost.mockResolvedValue({
      post: { id: "new" },
      media: [],
    });
    stubProfile(profilePage());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(client, {
      queryKey: ["community", "feed", "recent"],
      staleTime: 60_000,
      queryFn: async () =>
        freshContentUrl(client, "community", "/api/content/community-feed").includes(
          "_r=",
        )
          ? ["new"]
          : [],
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await observer.refetch();
    renderProfile("/@edwin1", client);
    fireEvent.click(await screen.findByRole("button", { name: "Nueva publicación" }));
    fireEvent.change(screen.getByPlaceholderText("¿Qué quieres compartir?"), {
      target: { value: "Nueva" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
    await waitFor(() => expect(observer.getCurrentResult().data).toEqual(["new"]));
    unsubscribe();
  });
  it("abre el editor reutilizado y crea la publicación con la API existente", async () => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    communityClientMocks.saveCommunityPost.mockResolvedValue({
      post: {
        id: "new-1",
        text: "recién creada",
        status: "published",
        version: 1,
        createdAt: "x",
        updatedAt: "x",
      },
      media: [],
    });
    stubProfile(profilePage());
    renderProfile();
    await screen.findByText("Todavía no hay publicaciones");

    fireEvent.click(screen.getByRole("button", { name: "Nueva publicación" }));
    expect(screen.getByRole("dialog", { name: "Nueva publicación" })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("¿Qué quieres compartir?"), {
      target: { value: "recién creada" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publicar" }));

    await waitFor(() =>
      expect(communityClientMocks.saveCommunityPost).toHaveBeenCalledWith({
        postId: null,
        expectedVersion: null,
        text: "recién creada",
        media: [],
        removedMediaIds: [],
      }),
    );
    // Tras guardar, el diálogo se cierra y se refresca la galería propia.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nueva publicación" })).toBeNull(),
    );
    expect(communityClientMocks.listOwnCommunityPosts).toHaveBeenCalledTimes(2);
  });

  it("el picker admite imagen Y video (Fase 9J-3), un único control mixto", async () => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    stubProfile(profilePage());
    renderProfile();
    await screen.findByText("Todavía no hay publicaciones");
    fireEvent.click(screen.getByRole("button", { name: "Nueva publicación" }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toContain("image/*");
    expect(input.accept).toContain("video/mp4");
    expect(input.accept).toContain("video/quicktime");
    expect(input.accept).toContain("video/webm");
    // Un único picker: nunca dos inputs/botones separados "Añadir imágenes"/"Añadir video".
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
  });

  it("nunca se muestra el formulario completo permanentemente bajo el encabezado", async () => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    stubProfile(profilePage());
    renderProfile();
    await screen.findByText("Todavía no hay publicaciones");
    expect(screen.queryByPlaceholderText("¿Qué quieres compartir?")).toBeNull();
  });
});

describe("/@username — gestión de publicaciones propias (⋯)", () => {
  it("Editar abre el editor con la publicación precargada", async () => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    communityClientMocks.listOwnCommunityPosts.mockResolvedValue({
      items: [ownPost("own-1", { text: "texto original" })],
    });
    stubProfile(profilePage());
    renderProfile();
    await screen.findByRole("button", { name: "Gestionar esta publicación" });

    fireEvent.click(screen.getByRole("button", { name: "Gestionar esta publicación" }));
    const menu = screen.getByRole("menu");
    const anchor = menu.parentElement?.parentElement;
    const card = anchor?.parentElement;
    expect(anchor).toHaveClass("inset-x-1.5");
    expect(anchor).toHaveClass("z-20", "has-[[aria-expanded=true]]:z-30");
    expect(
      screen.getByRole("button", { name: "Gestionar esta publicación" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(card).not.toHaveClass("overflow-hidden");
    expect(card?.querySelector(".pointer-events-none")).toHaveClass("overflow-hidden");
    fireEvent.click(screen.getByRole("menuitem", { name: "Editar" }));

    expect(
      screen.getByRole("dialog", { name: "Editar publicación" }),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("texto original")).toBeInTheDocument();
  });

  it("Eliminar exige confirmación explícita antes de borrar", async () => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    communityClientMocks.listOwnCommunityPosts.mockResolvedValue({
      items: [ownPost("own-1")],
    });
    stubProfile(profilePage());
    renderProfile();
    await screen.findByRole("button", { name: "Gestionar esta publicación" });

    fireEvent.click(screen.getByRole("button", { name: "Gestionar esta publicación" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Eliminar" }));

    expect(communityClientMocks.deleteCommunityPost).not.toHaveBeenCalled();
    expect(screen.getByText("¿Borrar esta publicación?")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog", { name: "¿Borrar esta publicación?" });
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog).toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(communityClientMocks.deleteCommunityPost).not.toHaveBeenCalled();
  });

  it("confirmar Eliminar usa la API existente de borrado propio", async () => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    communityClientMocks.listOwnCommunityPosts.mockResolvedValue({
      items: [ownPost("own-1")],
    });
    communityClientMocks.deleteCommunityPost.mockResolvedValue({
      postId: "own-1",
      deletedAssets: [],
      allCleaned: true,
    });
    stubProfile(profilePage());
    renderProfile();
    await screen.findByRole("button", { name: "Gestionar esta publicación" });

    fireEvent.click(screen.getByRole("button", { name: "Gestionar esta publicación" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Eliminar" }));
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));

    await waitFor(() =>
      expect(communityClientMocks.deleteCommunityPost).toHaveBeenCalledWith({
        postId: "own-1",
        expectedVersion: 1,
      }),
    );
  });

  it("interactuar con el menú ⋯ NUNCA abre la publicación subyacente", async () => {
    ownProfileFakes.profile = { username: "edwin1", displayName: null, bio: null };
    communityClientMocks.listOwnCommunityPosts.mockResolvedValue({
      items: [ownPost("own-1")],
    });
    stubProfile(profilePage());
    renderProfile();
    await screen.findByRole("button", { name: "Gestionar esta publicación" });

    fireEvent.click(screen.getByRole("button", { name: "Gestionar esta publicación" }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.queryByText("Post detail stub")).toBeNull();
  });

  it("un visitante nunca ve el control ⋯ en las tarjetas de otro perfil", async () => {
    stubProfile(profilePage({ posts: { items: [post("p1")], nextCursor: null } }));
    renderProfile();
    await screen.findByText("hola comunidad");
    expect(
      screen.queryByRole("button", { name: "Gestionar esta publicación" }),
    ).toBeNull();
  });
});
