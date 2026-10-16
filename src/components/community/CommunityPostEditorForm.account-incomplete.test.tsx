import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CommunityPostEditorForm from "./CommunityPostEditorForm";
import { CommunityClientError } from "@/lib/community-client";

// AUTH-2: una cuenta incompleta (email sin verificar / username pendiente) NO está sancionada. El
// editor muestra su propio aviso, conserva el borrador, no simula éxito, no reintenta y no usa el
// modelo de strikes.

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  success: vi.fn(),
  reserve: vi.fn(),
  complete: vi.fn(),
  abort: vi.fn(),
  put: vi.fn(),
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

const incomplete = (reason: "email_unverified" | "username_missing") =>
  new CommunityClientError(
    "Cuenta incompleta",
    403,
    "account_incomplete",
    null,
    null,
    reason,
  );

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem("upmina:locale", "en");
  let assetSeq = 0;
  mocks.reserve.mockImplementation(async () => ({
    assetId: `asset-${++assetSeq}`,
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
});

function renderEditor(onSaved = vi.fn()) {
  render(
    <MemoryRouter>
      <CommunityPostEditorForm initialPost={null} onSaved={onSaved} onCancel={vi.fn()} />
    </MemoryRouter>,
  );
  return onSaved;
}
const type = (value: string) =>
  fireEvent.change(screen.getByLabelText("Texto de la publicación"), {
    target: { value },
  });
// MEDIA-1: una publicación nueva exige un archivo; las pruebas que ejercen el guardado de un alta adjuntan uno listo.
async function attach() {
  fireEvent.change(document.querySelector('input[type="file"]')!, {
    target: { files: [new File(["bytes"], "a.jpg", { type: "image/jpeg" })] },
  });
  await waitFor(() => expect(mocks.complete).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByRole("button", { name: "Publicar" })).toBeEnabled());
}

const publish = () => fireEvent.click(screen.getByRole("button", { name: "Publicar" }));

describe("editor: rechazo por cuenta incompleta", () => {
  it("username pendiente: aviso con enlace a /account, borrador intacto, sin éxito ni reintento", async () => {
    mocks.save.mockRejectedValue(incomplete("username_missing"));
    const onSaved = renderEditor();
    type("Mi borrador");
    await attach();
    publish();

    expect(await screen.findByText("Choose your username first")).toBeInTheDocument();
    expect(screen.getByText(/Your draft is still here\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set up username" })).toHaveAttribute(
      "href",
      "/account",
    );
    expect(screen.getByLabelText("Texto de la publicación")).toHaveValue("Mi borrador");
    expect(mocks.success).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    // No es una sanción.
    expect(screen.queryByTestId("restriction-notice")).toBeNull();
  });

  it("email sin verificar: aviso de confirmar el correo (Spam/Junk) y sin enlace a /account", async () => {
    mocks.save.mockRejectedValue(incomplete("email_unverified"));
    renderEditor();
    type("Otro borrador");
    await attach();
    publish();

    expect(await screen.findByText("Confirm your email first")).toBeInTheDocument();
    expect(screen.getByText(/Spam or Junk/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Set up username" })).toBeNull();
    expect(screen.getByLabelText("Texto de la publicación")).toHaveValue("Otro borrador");
    expect(screen.queryByTestId("restriction-notice")).toBeNull();
  });

  it("un intento posterior limpia el aviso y vuelve a llamar al servidor (sin reintento automático)", async () => {
    mocks.save.mockRejectedValueOnce(incomplete("username_missing"));
    mocks.save.mockResolvedValueOnce({ post: { id: "p" }, media: [] });
    const onSaved = renderEditor();
    type("Texto");
    await attach();
    publish();
    await screen.findByText("Choose your username first");
    expect(mocks.save).toHaveBeenCalledTimes(1);

    publish();
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Choose your username first")).toBeNull();
  });
});
