import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import PostDetailPage from "@/pages/PostDetailPage";
import {
  NO_PROCEDE_NOTICE,
  type AuthorPostsResponse,
} from "@/lib/community-author-contract";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  ack: vi.fn(),
  remove: vi.fn(),
  session: true,
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    user: mocks.session ? { id: "owner" } : null,
    session: mocks.session ? { access_token: "synthetic" } : null,
    loading: false,
  }),
}));
vi.mock("@/hooks/useCommunityLikedByMe", () => ({
  useCommunityLikedByMe: () => ({ likedByMe: new Set() }),
}));
vi.mock("@/lib/community-client", async () => ({
  ...(await vi.importActual<typeof import("@/lib/community-client")>(
    "@/lib/community-client",
  )),
  fetchAuthorPost: mocks.read,
  acknowledgeAuthorNotice: mocks.ack,
  deleteCommunityPost: mocks.remove,
}));
const id = "24655b41-1bc7-487c-834e-d1715a596e9e";
function payload(
  kind: "none" | "paused" | "withdrawn" = "none",
  notice = false,
): AuthorPostsResponse {
  return {
    serverNow: "2026-10-04T18:00:00Z",
    noticeId: notice ? "11111111-1111-4111-8111-111111111111" : null,
    items: [
      {
        id,
        text: "Contenido privado",
        status:
          kind === "paused"
            ? "hidden_pending_review"
            : kind === "withdrawn"
              ? "removed_pending_purge"
              : "published",
        version: 3,
        createdAt: "2026-10-04T17:00:00Z",
        updatedAt: "2026-10-04T18:00:00Z",
        likeCount: 0,
        resolvedNoticeUnseen: false,
        author: { username: "author_test", displayName: null },
        media: [],
        moderation: {
          kind,
          deadline: kind === "withdrawn" ? "2026-10-07T18:00:00Z" : null,
          message: kind === "withdrawn" ? "<script>alert(1)</script>" : null,
        },
      },
    ],
  };
}
function open() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter
        initialEntries={[
          { pathname: `/community/post/${id}`, state: { ownerProfilePostId: id } },
        ]}
      >
        <Routes>
          <Route path="/community/post/:postId" element={<PostDetailPage />} />
          <Route path="/:usernameParam" element={<p>Perfil</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  mocks.session = true;
  mocks.read.mockReset();
  mocks.ack.mockReset();
  mocks.remove.mockReset();
  mocks.ack.mockResolvedValue({ acknowledged: true });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it.each([0, 1, 2])(
  "%i reports resulting in published state have no moderation signal",
  async () => {
    mocks.read.mockResolvedValue(payload());
    open();
    await screen.findByText("Contenido privado");
    expect(screen.queryByLabelText("Estado de la publicación")).toBeNull();
    expect(screen.queryByText(NO_PROCEDE_NOTICE)).toBeNull();
    expect(mocks.ack).not.toHaveBeenCalled();
  },
);
it("paused detail neutral; no identities/reasons/counts/edit; own Delete remains", async () => {
  mocks.read.mockResolvedValue(payload("paused"));
  open();
  await screen.findByText("Publicación pausada");
  expect(screen.getByText(/ocultada temporalmente/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Gestionar esta publicación" }));
  expect(screen.queryByRole("menuitem", { name: "Editar" })).toBeNull();
  expect(screen.getByRole("menuitem", { name: "Eliminar" })).toBeEnabled();
  expect(document.body.textContent).not.toMatch(
    /spam|reporter|caseId|3 reportes|strike/i,
  );
});
it("withdrawn warning/deadline and XSS-looking message are plain text", async () => {
  mocks.read.mockResolvedValue(payload("withdrawn"));
  open();
  await screen.findByText("Publicación retirada");
  expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
  expect(document.querySelector("script")).toBeNull();
  expect(screen.getByText(/retención inicial es de 72 horas/)).toBeInTheDocument();
  expect(document.querySelector('time[datetime="2026-10-07T18:00:00Z"]')).not.toBeNull();
  expect(screen.queryByRole("button", { name: /Editar/ })).toBeNull();
  expect(mocks.ack).not.toHaveBeenCalled();
});
it("ack is sent only after the notice is presented; current content remains", async () => {
  mocks.read.mockResolvedValue(payload("none", true));
  mocks.ack.mockImplementation(async () => {
    expect(screen.getByText(NO_PROCEDE_NOTICE)).toBeInTheDocument();
    return { acknowledged: true };
  });
  open();
  await waitFor(() => expect(mocks.ack).toHaveBeenCalledOnce());
  expect(mocks.ack).toHaveBeenCalledWith(id, "11111111-1111-4111-8111-111111111111");
  expect(screen.getByText("Contenido privado")).toBeInTheDocument();
});
const ownPostsInvalidations = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(
    (c) =>
      JSON.stringify((c[0] as { queryKey?: unknown } | undefined)?.queryKey) ===
      JSON.stringify(["community", "own-posts"]),
  );
it("R4-C: own-posts is refreshed only after the server confirms the ACK (never optimistic)", async () => {
  const spy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
  let confirm!: (v: { acknowledged: true }) => void;
  mocks.read.mockResolvedValue(payload("none", true));
  mocks.ack.mockImplementation(
    () =>
      new Promise((resolve) => {
        confirm = resolve;
      }),
  );
  open();
  await waitFor(() => expect(mocks.ack).toHaveBeenCalledOnce());
  expect(ownPostsInvalidations(spy)).toHaveLength(0);
  expect(screen.getByText(NO_PROCEDE_NOTICE)).toBeInTheDocument();
  confirm({ acknowledged: true });
  await waitFor(() => expect(ownPostsInvalidations(spy)).toHaveLength(1));
  expect(screen.getByText(NO_PROCEDE_NOTICE)).toBeInTheDocument();
  expect(
    spy.mock.calls.some((c) =>
      JSON.stringify((c[0] as { queryKey?: unknown } | undefined)?.queryKey).includes(
        "author-detail",
      ),
    ),
  ).toBe(false);
});
it("R4-C: ACK failure does not refresh own-posts, so the pending state is not lost", async () => {
  const spy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
  mocks.read.mockResolvedValue(payload("none", true));
  mocks.ack.mockRejectedValue(new Error("synthetic failure"));
  open();
  await waitFor(() => expect(mocks.ack).toHaveBeenCalledOnce());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(ownPostsInvalidations(spy)).toHaveLength(0);
});
it("R4-C: the No procede message text is unchanged", () => {
  expect(NO_PROCEDE_NOTICE).toBe(
    "El caso se revisó y no se encontró ningún incumplimiento de las reglas de la comunidad.",
  );
});
it("ack failure leaves content usable and does not hide the notice", async () => {
  mocks.read.mockResolvedValue(payload("none", true));
  mocks.ack.mockRejectedValue(new Error("synthetic failure"));
  open();
  await waitFor(() => expect(mocks.ack).toHaveBeenCalledOnce());
  expect(screen.getByText(NO_PROCEDE_NOTICE)).toBeInTheDocument();
  expect(screen.getByText("Contenido privado")).toBeInTheDocument();
});
it("future fresh load after server ack contains no notice", async () => {
  mocks.read.mockResolvedValue(payload());
  open();
  await screen.findByText("Contenido privado");
  expect(screen.queryByText(NO_PROCEDE_NOTICE)).toBeNull();
  expect(mocks.ack).not.toHaveBeenCalled();
});
it("hidden tab does not ack before visible presentation", async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  mocks.read.mockResolvedValue(payload("none", true));
  open();
  await screen.findByText(NO_PROCEDE_NOTICE);
  expect(mocks.ack).not.toHaveBeenCalled();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => expect(mocks.ack).toHaveBeenCalledOnce());
});
it("pending or failed navigation never acknowledges", async () => {
  mocks.read.mockImplementation(() => new Promise(() => {}));
  open();
  expect(screen.getByRole("status")).toHaveTextContent("Cargando");
  cleanup();
  expect(mocks.ack).not.toHaveBeenCalled();
});
it("expired/deleted/non-owned server response is unavailable without detail", async () => {
  mocks.read.mockResolvedValue(null);
  open();
  await screen.findByText("Esta publicación no está disponible.");
  expect(screen.queryByText("Contenido privado")).toBeNull();
  expect(mocks.ack).not.toHaveBeenCalled();
});
it("server-derived deadline clears retained detail and re-reads without polling", async () => {
  const r = payload("withdrawn");
  r.items[0].moderation.deadline = "2026-10-04T18:00:00.250Z";
  mocks.read.mockResolvedValueOnce(r).mockResolvedValue(null);
  open();
  await screen.findByText("Contenido privado");
  await screen.findByText("Esta publicación no está disponible.");
  expect(screen.queryByText("Contenido privado")).toBeNull();
  expect(mocks.read).toHaveBeenCalledTimes(2);
});
it("invalid response produces a controlled error without ack", async () => {
  mocks.read.mockRejectedValue(new Error("invalid_response"));
  open();
  expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cargar");
  expect(mocks.ack).not.toHaveBeenCalled();
});
it("signed-out profile context never fetches private data", async () => {
  mocks.session = false;
  open();
  await screen.findByText(/Inicia sesión para acceder/);
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.ack).not.toHaveBeenCalled();
});
