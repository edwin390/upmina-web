import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import CommunityPostEditorForm from "./CommunityPostEditorForm";
import type { CommunityOwnPost } from "@/lib/community-client";

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

beforeEach(() => {
  vi.resetAllMocks();
  let id = 0;
  mocks.reserve.mockImplementation(async () => ({
    assetId: `asset-${++id}`,
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
  mocks.save.mockResolvedValue({ post: { id: "post" }, media: [] });
});

const existing: CommunityOwnPost = {
  id: "post-existing",
  text: "Original",
  status: "published",
  version: 2,
  createdAt: "x",
  updatedAt: "x",
  likeCount: 0,
  media: [
    {
      id: "image-existing",
      assetId: "existing",
      position: 0,
      assetStatus: "ready",
      kind: "image",
      width: 480,
      height: 480,
      durationSeconds: null,
      url: null,
    },
  ],
};

async function selectFour(container: HTMLElement) {
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: {
      files: Array.from(
        { length: 4 },
        (_, i) => new File(["bytes"], `${i}.jpg`, { type: "image/jpeg" }),
      ),
    },
  });
  await waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(4));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Publicar" })).toBeEnabled(),
  );
}

describe("Community ownership tras persistencia", () => {
  it("cancel after local persisted removal performs no save, detach or abort", () => {
    const cancel = vi.fn();
    render(
      <CommunityPostEditorForm
        initialPost={existing}
        onSaved={vi.fn()}
        onCancel={cancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Quitar imagen" }));
    expect(mocks.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.abort).not.toHaveBeenCalled();
  });
  it("failed removal save retains attachment-ID intent for retry and never reports false success", async () => {
    mocks.save.mockRejectedValueOnce(new Error("failed"));
    render(
      <CommunityPostEditorForm
        initialPost={existing}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Quitar imagen" }));
    fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
    await screen.findByRole("alert");
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.save.mock.calls[0][0]).toMatchObject({
      postId: existing.id,
      expectedVersion: 2,
      removedMediaIds: ["image-existing"],
      media: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce());
    expect(mocks.save.mock.calls[1][0]).toEqual(mocks.save.mock.calls[0][0]);
    expect(mocks.abort).not.toHaveBeenCalled();
  });
  it("edit failed reports update failure without success", async () => {
    mocks.save.mockRejectedValueOnce(new Error("network"));
    render(
      <CommunityPostEditorForm
        initialPost={existing}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudo actualizar la publicación",
    );
    expect(mocks.success).not.toHaveBeenCalled();
  });
  it.each([false, true])("copy idle/pending distingue edit=%s", async (edit) => {
    let resolveSave!: (value: unknown) => void;
    mocks.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(
      <CommunityPostEditorForm
        initialPost={edit ? existing : null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("¿Qué quieres compartir?"), {
      target: { value: "Contenido" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
    expect(screen.getByRole("button", { name: "Publicando…" })).toBeDisabled();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0]![0]).toMatchObject({
      postId: edit ? existing.id : null,
      expectedVersion: edit ? existing.version : null,
    });
    expect(mocks.success).not.toHaveBeenCalled();
    await act(async () => resolveSave({ post: { id: "post" }, media: [] }));
    expect(mocks.success).toHaveBeenCalledTimes(1);
    expect(mocks.success).toHaveBeenCalledWith(
      edit ? "Publicación actualizada correctamente" : "Publicación creada correctamente",
    );
    expect(screen.getByRole("button", { name: "Publicar" })).toBeInTheDocument();
  });
  it.each([false, true])(
    "create/edit=%s: cuatro imágenes persistidas se liberan sin abort; copy distingue modos",
    async (edit) => {
      const onSaved = vi.fn();
      const { container, unmount } = render(
        <CommunityPostEditorForm
          initialPost={edit ? existing : null}
          onSaved={onSaved}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByRole("button", { name: "Publicar" })).toBeInTheDocument();
      await selectFour(container);
      fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      const payload = mocks.save.mock.calls[0]![0];
      expect(mocks.save).toHaveBeenCalledTimes(1);
      expect(payload).toMatchObject({
        postId: edit ? existing.id : null,
        expectedVersion: edit ? existing.version : null,
      });
      expect(payload.media.map((m: { position: number }) => m.position)).toEqual(
        edit ? [0, 1, 2, 3, 4] : [0, 1, 2, 3],
      );
      if (edit) expect(payload.media[0]).toEqual({ assetId: "existing", position: 0 });
      expect(screen.queryAllByRole("button", { name: "Quitar imagen" })).toHaveLength(
        edit ? 1 : 0,
      );
      fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
      unmount();
      expect(mocks.abort).not.toHaveBeenCalled();
    },
  );

  it("save fallido mantiene cuatro items recuperables; retry exitoso no aborta", async () => {
    mocks.save.mockRejectedValueOnce(new Error("save failed"));
    const onSaved = vi.fn();
    const { container } = render(
      <CommunityPostEditorForm initialPost={null} onSaved={onSaved} onCancel={vi.fn()} />,
    );
    await selectFour(container);
    fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "No se pudo crear la publicación",
    );
    expect(mocks.success).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: "Quitar imagen" })).toHaveLength(4);
    expect(onSaved).not.toHaveBeenCalled();
    expect(mocks.abort).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(mocks.abort).not.toHaveBeenCalled();
  });

  it("save fallido permite cancelar items todavía propiedad del uploader", async () => {
    mocks.save.mockRejectedValueOnce(new Error("save failed"));
    const { container } = render(
      <CommunityPostEditorForm initialPost={null} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    await selectFour(container);
    fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(mocks.abort).toHaveBeenCalledTimes(4);
  });
});
