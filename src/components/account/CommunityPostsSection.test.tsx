import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Sección de Comunidad en /account (9J-1C UX follow-up): confirma que el selector de imágenes
// usa un control ESTILIZADO propio de Upmina (nunca el texto por defecto del navegador), que
// sigue admitiendo solo imágenes (nunca vídeo) y que sigue siendo accesible por teclado — y que
// el resto de la funcionalidad existente (listar/crear publicaciones propias) no se rompió al
// pulir el picker.

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
  }),
}));

const { default: CommunityPostsSection } = await import("./CommunityPostsSection");

beforeEach(() => {
  communityClientMocks.listOwnCommunityPosts.mockReset();
  communityClientMocks.listOwnCommunityPosts.mockResolvedValue({ items: [] });
  communityClientMocks.saveCommunityPost.mockReset();
  communityClientMocks.deleteCommunityPost.mockReset();
  uploadMocks.addFiles.mockReset();
  uploadMocks.items = [];
});

afterEach(() => {
  cleanup();
});

async function renderPresent() {
  const result = render(<CommunityPostsSection profileStatus="present" />);
  await waitFor(() =>
    expect(communityClientMocks.listOwnCommunityPosts).toHaveBeenCalled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Nueva publicación" }));
  return result;
}

describe("sin perfil: ni formulario ni picker", () => {
  it("profileStatus='absent': muestra el aviso, sin ningún <input type=\"file\">", () => {
    const { container } = render(<CommunityPostsSection profileStatus="absent" />);
    expect(
      screen.getByText("Configura tu @username arriba antes de publicar en Comunidad."),
    ).toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });
});

describe("selector multimedia — copy futuro-compatible, control estilizado, imágenes por ahora", () => {
  it("muestra la etiqueta 'Multimedia (máximo 10)' (terminología mixta foto+vídeo, no 'Imágenes')", async () => {
    await renderPresent();
    expect(screen.getByText("Multimedia (máximo 10)")).toBeInTheDocument();
    expect(screen.queryByText(/^Imágenes \(máximo/)).toBeNull();
  });

  it("el botón dice 'Añadir fotos o videos' (describe el control mixto final, sin crear un segundo botón de vídeo)", async () => {
    await renderPresent();
    expect(
      screen.getByRole("button", { name: "Añadir fotos o videos" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Añadir imágenes$/ })).toBeNull();
    // Ningún botón de vídeo APARTE del único trigger mixto de arriba.
    const videoButtons = screen
      .queryAllByRole("button")
      .filter(
        (btn) =>
          /video/i.test(btn.textContent ?? "") &&
          btn.textContent !== "Añadir fotos o videos",
      );
    expect(videoButtons).toHaveLength(0);
  });

  it("el helper aclara que el vídeo todavía no está disponible, sin fingir que ya funciona", async () => {
    await renderPresent();
    expect(
      screen.getByText(
        "Por ahora puedes subir fotos. Los videos estarán disponibles pronto.",
      ),
    ).toBeInTheDocument();
  });

  it("solo existe UN input de archivo (ningún segundo selector de vídeo)", async () => {
    const { container } = await renderPresent();
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
  });

  it("el input real SIGUE restringido a imágenes (accept=image/*): el vídeo no se habilita todavía, pese a la copy nueva", async () => {
    const { container } = await renderPresent();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.accept).toBe("image/*");
    expect(input.multiple).toBe(true);
  });

  it("el texto visible es el botón propio, no el control nativo del navegador", async () => {
    await renderPresent();
    // El navegador renderiza "Seleccionar archivo"/"Ningún archivo seleccionado" como texto de
    // caja del propio <input>, no como nodos de texto del DOM — pero el picker estilizado nunca
    // debe depender de (ni mostrar) ese texto por ningún otro medio.
    expect(screen.queryByText(/seleccionar archivo/i)).toBeNull();
    expect(screen.queryByText(/ning[uú]n archivo seleccionado/i)).toBeNull();
  });

  it("el input real está visualmente oculto (sr-only) pero sigue en el documento y es enfocable por teclado", async () => {
    const { container } = await renderPresent();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.className).toContain("sr-only");
    expect(input).not.toHaveAttribute("hidden");
    expect(input.tabIndex).not.toBe(-1);
    input.focus();
    expect(document.activeElement).toBe(input);
  });

  it("pulsar el botón estilizado abre el selector nativo (dispara click() del input real)", async () => {
    await renderPresent();
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click");
    fireEvent.click(screen.getByRole("button", { name: "Añadir fotos o videos" }));
    expect(clickSpy).toHaveBeenCalledTimes(1);
    clickSpy.mockRestore();
  });

  it("seleccionar archivos en el input real los envía a la cola de subida existente (addFiles), sin reimplementar la lógica", async () => {
    const { container } = await renderPresent();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "foto.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(uploadMocks.addFiles).toHaveBeenCalledTimes(1);
  });

  it("el botón se deshabilita cuando ya se alcanzó el máximo de 10 imágenes", async () => {
    uploadMocks.items = Array.from({ length: 10 }, (_, i) => ({
      localId: `item-${i}`,
      status: "ready",
      assetId: `asset-${i}`,
      variants: [
        { variant: 480, width: 1, height: 1, bytes: 1, url: `https://x/${i}.webp` },
      ],
    }));
    await renderPresent();
    expect(screen.getByRole("button", { name: "Añadir fotos o videos" })).toBeDisabled();
  });
});

describe("funcionalidad existente de Comunidad sigue intacta", () => {
  it("lista las publicaciones propias al montar (perfil presente)", async () => {
    communityClientMocks.listOwnCommunityPosts.mockResolvedValue({
      items: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          text: "hola comunidad",
          status: "published",
          version: 1,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          media: [],
        },
      ],
    });
    render(<CommunityPostsSection profileStatus="present" />);
    expect(await screen.findByText("hola comunidad")).toBeInTheDocument();
  });

  it("crear una publicación de solo texto llama a saveCommunityPost con el body esperado", async () => {
    communityClientMocks.saveCommunityPost.mockResolvedValue({
      post: {
        id: "11111111-1111-4111-8111-111111111111",
        text: "hola",
        status: "published",
        version: 1,
        createdAt: "x",
        updatedAt: "x",
      },
      media: [],
    });
    await renderPresent();

    fireEvent.change(screen.getByPlaceholderText("¿Qué quieres compartir?"), {
      target: { value: "hola" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() =>
      expect(communityClientMocks.saveCommunityPost).toHaveBeenCalledWith({
        postId: null,
        expectedVersion: null,
        text: "hola",
        media: [],
      }),
    );
  });
});
