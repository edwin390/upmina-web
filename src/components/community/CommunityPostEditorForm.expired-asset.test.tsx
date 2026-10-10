import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CommunityPostEditorForm from "./CommunityPostEditorForm";
import { CommunityClientError } from "@/lib/community-client";

// R5-S1: un archivo ya subido (ready) puede caducar si nunca se publicó (limpieza de abandonados) o
// descartarse en otra pestaña. Al publicar, el servidor responde invalid_asset / asset_not_ready. El
// formulario debe explicarlo con un mensaje comprensible y conservar el texto y los archivos que
// siguen siendo válidos, sin éxito falso y sin reintento automático.

const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  complete: vi.fn(),
  abort: vi.fn(),
  put: vi.fn(),
  save: vi.fn(),
  success: vi.fn(),
}));
vi.mock("@/lib/action-notice", () => ({ showActionSuccess: mocks.success }));
vi.mock("@/lib/media-client", async () => ({
  ...(await vi.importActual("@/lib/media-client")),
  reserveMediaUpload: mocks.reserve,
  completeMediaUpload: mocks.complete,
  abortMediaUpload: mocks.abort,
  uploadWithProgress: mocks.put,
}));
vi.mock("@/lib/media-transport", () => ({
  prepareUploadBlob: async (file: File) => ({
    blob: file,
    mime: file.type,
    bytes: file.size,
    strategy: "original",
    width: null,
    height: null,
  }),
}));
vi.mock("@/lib/community-client", async () => ({
  ...(await vi.importActual("@/lib/community-client")),
  saveCommunityPost: mocks.save,
}));

let nextId = 0;
beforeEach(() => {
  vi.resetAllMocks();
  nextId = 0;
  mocks.reserve.mockImplementation(async () => ({
    assetId: `asset-${++nextId}`,
    mode: "single",
    uploadUrl: "https://r2.test/put",
    expiresInSeconds: 900,
  }));
  mocks.put.mockResolvedValue({ etag: '"e"' });
  mocks.abort.mockResolvedValue({ assetId: "x", status: "deleted" });
  mocks.complete.mockImplementation(async ({ assetId }) => ({
    assetId,
    status: "ready",
    variants: [],
  }));
});

const MESSAGE = "Alguna foto o video ya no está disponible.";

async function renderWithTwoReadyImages() {
  const onSaved = vi.fn();
  const { container } = render(
    <CommunityPostEditorForm initialPost={null} onSaved={onSaved} onCancel={vi.fn()} />,
  );
  fireEvent.change(screen.getByLabelText("Texto de la publicación"), {
    target: { value: "Mi borrador con fotos" },
  });
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: {
      files: [
        new File(["a"], "a.jpg", { type: "image/jpeg" }),
        new File(["b"], "b.jpg", { type: "image/jpeg" }),
      ],
    },
  });
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Quitar imagen" })).toHaveLength(2),
  );
  await waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Publicar" })).toBeEnabled(),
  );
  return { onSaved };
}

describe.each(["invalid_asset", "asset_not_ready"])(
  "publicar con un archivo caducado (%s)",
  (code) => {
    it("muestra un mensaje comprensible y conserva el texto y todos los archivos para poder corregir", async () => {
      const { onSaved } = await renderWithTwoReadyImages();
      mocks.save.mockRejectedValue(
        new CommunityClientError("Solicitud inválida", 400, code),
      );
      fireEvent.click(screen.getByRole("button", { name: "Publicar" }));

      const alert = await screen.findByText(/No se pudo crear la publicación/);
      expect(alert).toHaveTextContent(MESSAGE);
      expect(alert).toHaveTextContent("vuelve a subirlos");
      expect(alert).not.toHaveTextContent("Solicitud inválida");
      // Borrador intacto: texto y ambos archivos, sin éxito falso ni reintento automático.
      expect(screen.getByLabelText("Texto de la publicación")).toHaveValue(
        "Mi borrador con fotos",
      );
      expect(screen.getAllByRole("button", { name: "Quitar imagen" })).toHaveLength(2);
      expect(onSaved).not.toHaveBeenCalled();
      expect(mocks.success).not.toHaveBeenCalled();
      expect(mocks.save).toHaveBeenCalledTimes(1);
      expect(mocks.abort).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Publicar" })).toBeEnabled();
    });

    it("recuperación: quitar el archivo afectado y publicar de nuevo envía solo los archivos que siguen válidos", async () => {
      const { onSaved } = await renderWithTwoReadyImages();
      mocks.save.mockRejectedValueOnce(
        new CommunityClientError("Solicitud inválida", 400, code),
      );
      fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
      await screen.findByText(/ya no está disponible/);

      fireEvent.click(screen.getAllByRole("button", { name: "Quitar imagen" })[0]);
      await waitFor(() =>
        expect(screen.getAllByRole("button", { name: "Quitar imagen" })).toHaveLength(1),
      );
      mocks.save.mockResolvedValue({ post: { id: "p" }, media: [] });
      fireEvent.click(screen.getByRole("button", { name: "Publicar" }));

      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      const second = mocks.save.mock.calls[1][0] as {
        text: string;
        media: { assetId: string; position: number }[];
      };
      expect(second.text).toBe("Mi borrador con fotos");
      expect(second.media).toEqual([{ assetId: "asset-2", position: 0 }]);
    });
  },
);

describe("otros errores de guardado no cambian", () => {
  it("un error genérico sigue mostrando el texto del servidor", async () => {
    await renderWithTwoReadyImages();
    mocks.save.mockRejectedValue(new CommunityClientError("Error del servidor", 500));
    fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
    const alert = await screen.findByText(/No se pudo crear la publicación/);
    expect(alert).toHaveTextContent("Error del servidor");
    expect(alert).not.toHaveTextContent(MESSAGE);
  });
});
