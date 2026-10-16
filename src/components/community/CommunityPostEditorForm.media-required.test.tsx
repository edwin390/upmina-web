import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import CommunityPostEditorForm from "./CommunityPostEditorForm";
import { CommunityClientError, type CommunityOwnPost } from "@/lib/community-client";

// MEDIA-1: una publicación NUEVA exige al menos un archivo listo; el texto es opcional. Una publicación histórica de
// solo texto se sigue editando solo con texto; una con archivos no puede quedarse sin ninguno.

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
  readVideoMetadata: async () => ({ width: 640, height: 360, durationSeconds: 3 }),
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

const post = (media: CommunityOwnPost["media"]): CommunityOwnPost => ({
  id: "post-1",
  text: "Texto",
  status: "published",
  version: 2,
  createdAt: "x",
  updatedAt: "x",
  likeCount: 0,
  media,
});
const image = (n: number): CommunityOwnPost["media"][number] => ({
  id: `m${n}`,
  assetId: `a${n}`,
  position: n,
  assetStatus: "ready",
  kind: "image",
  width: 480,
  height: 480,
  durationSeconds: null,
  url: null,
});

let seq = 0;
beforeEach(() => {
  vi.resetAllMocks();
  seq = 0;
  mocks.reserve.mockImplementation(async () => ({
    assetId: `asset-${++seq}`,
    mode: "single",
    uploadUrl: "https://r2.test/put",
    expiresInSeconds: 900,
  }));
  mocks.put.mockResolvedValue({ etag: '"e"' });
  mocks.abort.mockResolvedValue({ status: "deleted" });
  mocks.complete.mockImplementation(async ({ assetId }) => ({
    assetId,
    status: "ready",
    variants: [],
  }));
  mocks.save.mockResolvedValue({ post: { id: "p" }, media: [] });
});

const publishButton = () => screen.getByRole("button", { name: "Publicar" });
const type = (value: string) =>
  fireEvent.change(screen.getByLabelText("Texto de la publicación"), { target: { value } });
const pick = (container: HTMLElement, ...files: File[]) =>
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files } });
const img = (name = "a.jpg") => new File(["x"], name, { type: "image/jpeg" });
const vid = (name = "a.mp4") => new File(["x"], name, { type: "video/mp4" });

describe("alta de una publicación", () => {
  it("el botón está deshabilitado sin archivos, aunque haya texto, y se explica el motivo", () => {
    render(<CommunityPostEditorForm initialPost={null} onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(publishButton()).toBeDisabled();
    type("solo texto");
    expect(publishButton()).toBeDisabled();
    expect(
      screen.getByText("Las publicaciones nuevas necesitan al menos una imagen o un video."),
    ).toBeInTheDocument();
  });

  it("se habilita con un archivo válido listo (el texto es opcional) y publica sin texto", async () => {
    mocks.complete.mockImplementation(async ({ assetId }) => ({
      assetId,
      status: "ready",
      kind: "video",
      url: "https://cdn.test/v.mp4",
      width: 640,
      height: 360,
      bytes: 1,
      durationSeconds: 3,
    }));
    const { container } = render(
      <CommunityPostEditorForm initialPost={null} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    pick(container, vid("clip.mp4"));
    await waitFor(() => expect(publishButton()).toBeEnabled());
    expect(screen.queryByText(/necesitan al menos una imagen/)).toBeNull();
    fireEvent.click(publishButton());
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save.mock.calls[0][0]).toMatchObject({ postId: null, text: null });
    expect(mocks.save.mock.calls[0][0].media).toHaveLength(1);
  });

  it("no se habilita mientras el archivo no está listo ni cuando la subida falla", async () => {
    mocks.complete.mockRejectedValue(new Error("fallo"));
    const { container } = render(
      <CommunityPostEditorForm initialPost={null} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    type("hola");
    pick(container, img());
    expect(publishButton()).toBeDisabled();
    await waitFor(() => expect(mocks.complete).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByRole("button", { name: "Quitar imagen" })).not.toBeNull();
    expect(publishButton()).toBeDisabled();
  });

  it("al retirar el último archivo vuelve a deshabilitarse", async () => {
    const { container } = render(
      <CommunityPostEditorForm initialPost={null} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    pick(container, img());
    await waitFor(() => expect(publishButton()).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Quitar imagen" }));
    await waitFor(() => expect(publishButton()).toBeDisabled());
  });

  it("mantiene el límite de vídeos en el selector", () => {
    const { container } = render(
      <CommunityPostEditorForm initialPost={null} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    pick(container, vid("a.mp4"), vid("b.mp4"));
    expect(screen.getByText(/Máximo/)).toBeInTheDocument();
    expect(publishButton()).toBeDisabled();
  });

  it("si el servidor responde media_required se muestra el mensaje localizado", async () => {
    mocks.save.mockRejectedValue(new CommunityClientError("x", 422, "media_required", null));
    const { container } = render(
      <CommunityPostEditorForm initialPost={null} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    pick(container, img());
    await waitFor(() => expect(publishButton()).toBeEnabled());
    fireEvent.click(publishButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Una publicación nueva necesita al menos una imagen o un video.",
    );
  });
});

describe("edición", () => {
  it("una publicación histórica de solo texto se puede editar sin adjuntar archivos", async () => {
    render(<CommunityPostEditorForm initialPost={post([])} onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText(/necesitan al menos una imagen/)).toBeNull();
    expect(publishButton()).toBeEnabled();
    type("Texto corregido");
    expect(publishButton()).toBeEnabled();
    fireEvent.click(publishButton());
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save.mock.calls[0][0]).toMatchObject({
      postId: "post-1",
      text: "Texto corregido",
      media: [],
    });
  });

  it("una histórica de solo texto no puede quedarse sin texto ni archivos", () => {
    render(<CommunityPostEditorForm initialPost={post([])} onSaved={vi.fn()} onCancel={vi.fn()} />);
    type("");
    expect(publishButton()).toBeDisabled();
  });

  it("una publicación con archivos no puede quedarse sin ninguno", () => {
    render(
      <CommunityPostEditorForm initialPost={post([image(0)])} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(publishButton()).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Quitar imagen" }));
    expect(publishButton()).toBeDisabled();
  });

  it("con dos archivos se puede retirar uno", () => {
    render(
      <CommunityPostEditorForm
        initialPost={post([image(0), image(1)])}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Quitar imagen" })[0]);
    expect(publishButton()).toBeEnabled();
  });
});

describe("traducciones", () => {
  it.each(["es", "en", "de"])("existen los dos textos nuevos en %s", (locale) => {
    const json = JSON.parse(
      readFileSync(resolve(`src/i18n/locales/${locale}/community.json`), "utf8"),
    );
    expect(json.form.mediaRequired.length).toBeGreaterThan(10);
    expect(json.form.errors.mediaRequired.length).toBeGreaterThan(10);
  });
});
