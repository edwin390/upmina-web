import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import CommunityLikeButton from "./CommunityLikeButton";

// Fase 9J-2C: control de "me gusta" — estados visual/aria, reconciliación optimista con rollback
// en fallo, bloqueo de clics duplicados en vuelo, y el flujo de visitante (sin sesión) hacia
// /login?returnTo=/community en vez de descartar el clic en silencio.

const authFakes = vi.hoisted(() => ({
  session: null as { access_token: string; user: { id: string } } | null,
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    session: authFakes.session,
    user: null,
    loading: false,
    signOut: vi.fn(),
  }),
}));

const clientFakes = vi.hoisted(() => ({
  setLikeImpl: undefined as
    | ((input: { postId: string; liked: boolean }) => Promise<{
        postId: string;
        likeCount: number;
        likedByMe: boolean;
      }>)
    | undefined,
  calls: [] as { postId: string; liked: boolean }[],
}));
vi.mock("@/lib/community-client", () => ({
  setCommunityPostLike: async (input: { postId: string; liked: boolean }) => {
    clientFakes.calls.push(input);
    if (clientFakes.setLikeImpl) return clientFakes.setLikeImpl(input);
    return {
      postId: input.postId,
      likeCount: input.liked ? 1 : 0,
      likedByMe: input.liked,
    };
  },
}));

function renderButton(
  props: Partial<React.ComponentProps<typeof CommunityLikeButton>> = {},
) {
  return render(
    <MemoryRouter initialEntries={["/community"]}>
      <Routes>
        <Route
          path="/community"
          element={
            <CommunityLikeButton
              postId="post-1"
              likeCount={3}
              likedByMe={false}
              {...props}
            />
          }
        />
        <Route path="/login" element={<p>Login stub</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  authFakes.session = null;
  clientFakes.setLikeImpl = undefined;
  clientFakes.calls = [];
});

afterEach(() => {
  cleanup();
});

describe("CommunityLikeButton — estados visuales/aria", () => {
  it("no liked: aria-pressed=false y muestra el recuento", () => {
    renderButton({ likeCount: 3, likedByMe: false });
    const button = screen.getByRole("button", { name: /me gusta \(3\)/i });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveTextContent("3");
  });

  it("liked: aria-pressed=true y aria-label distinto (quitar)", () => {
    renderButton({ likeCount: 4, likedByMe: true });
    const button = screen.getByRole("button", { name: /quitar me gusta \(4\)/i });
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("es un <button>, no un <a> (accesible por teclado por defecto, sin duplicar semántica)", () => {
    renderButton();
    const button = screen.getByRole("button");
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
  });
});

describe("CommunityLikeButton — usuario autenticado", () => {
  beforeEach(() => {
    authFakes.session = { access_token: "t", user: { id: "user-1" } };
  });

  it("clic llama al backend con {postId, liked:true} al dar like", async () => {
    renderButton({ postId: "post-1", likeCount: 0, likedByMe: false });
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(clientFakes.calls).toHaveLength(1));
    expect(clientFakes.calls[0]).toEqual({ postId: "post-1", liked: true });
  });

  it("clic en estado liked llama al backend con liked:false", async () => {
    renderButton({ postId: "post-1", likeCount: 1, likedByMe: true });
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(clientFakes.calls).toHaveLength(1));
    expect(clientFakes.calls[0]).toEqual({ postId: "post-1", liked: false });
  });

  it("optimista: el recuento sube de inmediato al dar like, antes de que resuelva el backend", async () => {
    let resolveFn!: (v: {
      postId: string;
      likeCount: number;
      likedByMe: boolean;
    }) => void;
    clientFakes.setLikeImpl = () => new Promise((resolve) => (resolveFn = resolve));
    renderButton({ postId: "post-1", likeCount: 3, likedByMe: false });

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("4");
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");

    await act(async () => resolveFn({ postId: "post-1", likeCount: 4, likedByMe: true }));
    expect(screen.getByRole("button")).toHaveTextContent("4");
  });

  it("optimista: el recuento baja de inmediato al quitar el like", () => {
    clientFakes.setLikeImpl = () => new Promise(() => {});
    renderButton({ postId: "post-1", likeCount: 3, likedByMe: true });
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("2");
  });

  it("el recuento mostrado nunca baja de 0", () => {
    clientFakes.setLikeImpl = () => new Promise(() => {});
    renderButton({ postId: "post-1", likeCount: 0, likedByMe: true });
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("0");
  });

  it("fallo del backend: revierte recuento Y estado liked a los valores previos al clic", async () => {
    clientFakes.setLikeImpl = () => Promise.reject(new Error("fallo de red"));
    renderButton({ postId: "post-1", likeCount: 3, likedByMe: false });

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("4");

    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent("3"));
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
  });

  it("clics rápidos repetidos mientras una mutación sigue en vuelo: una sola llamada al backend", async () => {
    clientFakes.setLikeImpl = () => new Promise(() => {});
    renderButton({ postId: "post-1", likeCount: 0, likedByMe: false });
    const button = screen.getByRole("button");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(clientFakes.calls).toHaveLength(1);
  });

  it("el botón se deshabilita (aria-busy) mientras la mutación sigue en vuelo, y se reactiva al resolver", async () => {
    let resolveFn!: (v: {
      postId: string;
      likeCount: number;
      likedByMe: boolean;
    }) => void;
    clientFakes.setLikeImpl = () => new Promise((resolve) => (resolveFn = resolve));
    renderButton({ postId: "post-1", likeCount: 0, likedByMe: false });

    const button = screen.getByRole("button");
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    // El heart/count optimista ya es suficiente feedback (9J-2C follow-up de pulido): sin cursor
    // de espera ni atenuación visual mientras está pendiente.
    expect(button.className).not.toMatch(/cursor-wait/);
    expect(button.className).not.toMatch(/opacity-70/);
    expect(button).toHaveTextContent("1");
    expect(button).toHaveAttribute("aria-pressed", "true");

    await act(async () => resolveFn({ postId: "post-1", likeCount: 1, likedByMe: true }));
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "false");
  });

  it("dar like: tras confirmar el clic, un dato obsoleto/tardío de liked-by-me (props) no revierte el toggle", async () => {
    clientFakes.setLikeImpl = async () => ({
      postId: "post-1",
      likeCount: 1,
      likedByMe: true,
    });
    const { rerender } = renderButton({
      postId: "post-1",
      likeCount: 0,
      likedByMe: false,
    });

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.getByRole("button")).toHaveTextContent("1");

    // Simula la consulta por lote useCommunityLikedByMe resolviendo TARDE, con datos capturados
    // ANTES del clic (todavía "no le dio like"): el padre re-renderiza con los mismos props
    // obsoletos que tenía al montar.
    rerender(
      <MemoryRouter initialEntries={["/community"]}>
        <Routes>
          <Route
            path="/community"
            element={
              <CommunityLikeButton postId="post-1" likeCount={0} likedByMe={false} />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button")).toHaveTextContent("1");
  });

  it("quitar el like: tras confirmar el clic, un dato obsoleto/tardío (props) no revierte el toggle", async () => {
    clientFakes.setLikeImpl = async () => ({
      postId: "post-1",
      likeCount: 4,
      likedByMe: false,
    });
    const { rerender } = renderButton({
      postId: "post-1",
      likeCount: 5,
      likedByMe: true,
    });

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false"),
    );
    expect(screen.getByRole("button")).toHaveTextContent("4");

    // Props obsoletos (todavía "liked=true, count=5") llegan tras el clic ya confirmado.
    rerender(
      <MemoryRouter initialEntries={["/community"]}>
        <Routes>
          <Route
            path="/community"
            element={
              <CommunityLikeButton postId="post-1" likeCount={5} likedByMe={true} />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button")).toHaveTextContent("4");
  });

  it("el clic detiene su propagación por defecto (no abre un contenedor ancestro)", async () => {
    const onAncestorClick = vi.fn();
    render(
      <MemoryRouter>
        <div onClick={onAncestorClick}>
          <CommunityLikeButton postId="post-1" likeCount={0} likedByMe={false} />
        </div>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(clientFakes.calls).toHaveLength(1));
    expect(onAncestorClick).not.toHaveBeenCalled();
  });
});

describe("CommunityLikeButton — visitante (sin sesión)", () => {
  it("clic navega a /login?returnTo=/community, sin llamar al backend", async () => {
    renderButton({ postId: "post-1", likeCount: 2, likedByMe: false });
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByText("Login stub")).toBeInTheDocument();
    expect(clientFakes.calls).toHaveLength(0);
  });

  it("el estado visual no cambia antes de navegar (el clic no se descarta en silencio ni muta nada local)", () => {
    renderButton({ postId: "post-1", likeCount: 2, likedByMe: false });
    const button = screen.getByRole("button");
    fireEvent.click(button);
    // La navegación ya reemplazó la pantalla por "Login stub"; el botón visitante nunca llegó a
    // marcar aria-pressed=true localmente antes de eso.
    expect(screen.queryByRole("button", { name: /quitar me gusta/i })).toBeNull();
  });
});
