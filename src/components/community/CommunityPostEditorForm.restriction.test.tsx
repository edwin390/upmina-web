import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CommunityPostEditorForm from "./CommunityPostEditorForm";
import { CommunityClientError, type CommunityOwnPost } from "@/lib/community-client";
import { MediaClientError } from "@/lib/media-client";

// R5-E: el rechazo AUTORITATIVO por strike (guardado y reserva de media) se muestra con el aviso
// central, conservando el borrador, sin reintento automático y sin ocultar nada del borrado propio.

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

const RESTRICTION = {
  level: 2 as const,
  permanent: false,
  endsAt: "2026-11-20T10:00:00+00:00",
  reason: "Motivo completo del strike",
};
const restricted = (restriction: typeof RESTRICTION | null = RESTRICTION) =>
  new CommunityClientError(
    "Tu cuenta tiene una restricción",
    403,
    "author_restricted",
    null,
    restriction,
  );

const existing: CommunityOwnPost = {
  id: "post-existing",
  text: "Original",
  status: "published",
  version: 2,
  createdAt: "x",
  updatedAt: "x",
  likeCount: 0,
  media: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.put.mockResolvedValue({ etag: '"e"' });
  mocks.abort.mockResolvedValue({ status: "deleted" });
  mocks.complete.mockImplementation(async ({ assetId }) => ({
    assetId,
    status: "ready",
    variants: [],
  }));
});

const type = (value: string) =>
  fireEvent.change(screen.getByLabelText("Texto de la publicación"), {
    target: { value },
  });
const publish = () => fireEvent.click(screen.getByRole("button", { name: "Publicar" }));

describe("authoritative save rejection (create and edit)", () => {
  it("CREATE: shows the restriction notice, keeps the typed draft, never reports success, does not retry", async () => {
    mocks.save.mockRejectedValue(restricted());
    const onSaved = vi.fn();
    render(
      <CommunityPostEditorForm initialPost={null} onSaved={onSaved} onCancel={vi.fn()} />,
    );
    type("Mi borrador");
    publish();
    const notice = await screen.findByTestId("restriction-notice");
    expect(notice).toHaveTextContent("Tu cuenta tiene un Strike 2 activo en Community.");
    expect(notice).toHaveTextContent("Motivo: Motivo completo del strike");
    expect(notice).toHaveTextContent(
      "Puedes seguir eliminando tus propias publicaciones.",
    );
    expect(screen.getByLabelText("Texto de la publicación")).toHaveValue("Mi borrador");
    expect(onSaved).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/No se pudo crear la publicación/)).toBeNull();
    expect(screen.getByRole("button", { name: "Publicar" })).toBeEnabled();
  });
  it("EDIT: the editor stays open with the draft; no false 'updated' success; permanent copy", async () => {
    mocks.save.mockRejectedValue(
      new CommunityClientError("x", 403, "author_restricted", null, {
        level: 3,
        permanent: true,
        endsAt: null,
        reason: "Reincidencia",
      }),
    );
    const onSaved = vi.fn();
    render(
      <CommunityPostEditorForm
        initialPost={existing}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );
    type("Editado");
    publish();
    const notice = await screen.findByTestId("restriction-notice");
    expect(notice).toHaveTextContent("Strike 3");
    expect(notice).toHaveTextContent("de forma permanente");
    expect(screen.getByLabelText("Texto de la publicación")).toHaveValue("Editado");
    expect(onSaved).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });
  it("author_restricted without parsable detail → neutral notice (never a generic error)", async () => {
    mocks.save.mockRejectedValue(restricted(null));
    render(
      <CommunityPostEditorForm initialPost={null} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    type("x");
    publish();
    expect(await screen.findByTestId("restriction-notice")).toHaveTextContent(
      "restricción activa",
    );
  });
  it("409 author_restriction_changed: neutral stale message, NO automatic retry, draft kept", async () => {
    mocks.save.mockRejectedValue(
      new CommunityClientError("x", 409, "author_restriction_changed"),
    );
    render(
      <CommunityPostEditorForm initialPost={null} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    type("borrador");
    publish();
    expect(await screen.findByTestId("restriction-changed")).toHaveTextContent(
      "El estado de tu restricción cambió. Vuelve a intentarlo.",
    );
    expect(screen.queryByTestId("restriction-notice")).toBeNull();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Texto de la publicación")).toHaveValue("borrador");
  });
  it("an explicit second submit is a NEW attempt and succeeds normally", async () => {
    mocks.save
      .mockRejectedValueOnce(restricted())
      .mockResolvedValueOnce({ post: { id: "p" }, media: [] });
    const onSaved = vi.fn();
    render(
      <CommunityPostEditorForm initialPost={null} onSaved={onSaved} onCancel={vi.fn()} />,
    );
    type("x");
    publish();
    await screen.findByTestId("restriction-notice");
    publish();
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });
  it("other errors keep their existing messages (the new handling is additive)", async () => {
    mocks.save.mockRejectedValue(
      new CommunityClientError("x", 409, "community_version_conflict"),
    );
    render(
      <CommunityPostEditorForm
        initialPost={existing}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    publish();
    expect(await screen.findByText(/cambió mientras editabas/)).toBeInTheDocument();
    expect(screen.queryByTestId("restriction-notice")).toBeNull();
  });
  it("no moderator, case, decision or reporter information is rendered", async () => {
    mocks.save.mockRejectedValue(restricted());
    render(
      <CommunityPostEditorForm initialPost={null} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    type("x");
    publish();
    const notice = await screen.findByTestId("restriction-notice");
    expect(notice.textContent).not.toMatch(/moderador|reporte|caso|decisión|decision/i);
  });
});

describe("media reserve precheck rejection", () => {
  it("the notice appears immediately with the authoritative detail; no upload state; text draft untouched", async () => {
    mocks.reserve.mockRejectedValue(
      new MediaClientError(
        "Tu cuenta tiene una restricción",
        403,
        "author_restricted",
        null,
        RESTRICTION,
      ),
    );
    const { container } = render(
      <CommunityPostEditorForm initialPost={null} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    type("con foto");
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["bytes"], "a.jpg", { type: "image/jpeg" })] },
    });
    const notice = await screen.findByTestId("restriction-notice");
    expect(notice).toHaveTextContent("Strike 2");
    expect(notice).toHaveTextContent("Motivo: Motivo completo del strike");
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Texto de la publicación")).toHaveValue("con foto");
  });
});
