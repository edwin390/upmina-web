import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import LocaleProvider from "@/i18n/LocaleProvider";
import CosplayEditorDialog from "./CosplayEditorDialog";
import { CosplayAdminClientError } from "@/lib/cosplay-admin-client";
import { MediaClientError } from "@/lib/media-client";

const f = vi.hoisted(() => ({
  identity: "owner",
  generation: 0,
  recent: false,
  save: vi.fn(),
  get: vi.fn(),
  detach: vi.fn(),
  remove: vi.fn(),
  reserve: vi.fn(),
  put: vi.fn(),
  complete: vi.fn(),
  abort: vi.fn(),
  prepare: vi.fn(),
  verify: vi.fn(),
  challenge: vi.fn(),
  access: vi.fn(),
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    user: { id: f.identity },
    session: f.identity ? { user: { id: f.identity } } : null,
    loading: false,
    identityGeneration: f.generation,
  }),
}));
vi.mock("@/hooks/useAdminAccess", () => ({
  useAdminAccess: () => ({
    status: "ready",
    access: { mfaRecent: f.recent },
    refetch: f.access,
  }),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: f.identity ? { user: { id: f.identity } } : null },
        error: null,
      }),
      mfa: {
        listFactors: async () => ({
          data: { all: [], totp: [{ id: "factor" }] },
          error: null,
        }),
        challenge: (...args: unknown[]) => f.challenge(...args),
        verify: (...args: unknown[]) => f.verify(...args),
      },
    },
  },
}));
vi.mock("@/lib/cosplay-admin-client", async () => ({
  ...(await vi.importActual("@/lib/cosplay-admin-client")),
  saveCosplayPost: (...args: unknown[]) => f.save(...args),
  getCosplayPostAdmin: (...args: unknown[]) => f.get(...args),
  detachCosplayMedia: (...args: unknown[]) => f.detach(...args),
  deleteCosplayPost: (...args: unknown[]) => f.remove(...args),
}));
vi.mock("@/lib/media-client", async () => ({
  ...(await vi.importActual("@/lib/media-client")),
  reserveMediaUpload: (...args: unknown[]) => f.reserve(...args),
  uploadWithProgress: (...args: unknown[]) => f.put(...args),
  completeMediaUpload: (...args: unknown[]) => f.complete(...args),
  abortMediaUpload: (...args: unknown[]) => f.abort(...args),
}));
vi.mock("@/lib/media-transport", () => ({
  prepareUploadBlob: (...args: unknown[]) => f.prepare(...args),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const stepUp = () =>
  new CosplayAdminClientError(
    "Verification required",
    403,
    "step_up_required",
    "step_up_required",
  );
const uploadStepUp = () =>
  new MediaClientError(
    "Verification required",
    403,
    "step_up_required",
    "step_up_required",
  );
const detail = () => ({
  id: "draft",
  status: "draft",
  version: 7,
  title: "Título",
  description: "Descripción",
  characterName: "Personaje",
  series: "Serie",
  images: ["a", "b"].map((id, position) => ({
    id,
    assetId: `asset-${id}`,
    position,
    isCover: position === 0,
    url: `https://example.test/${id}.webp`,
    width: 468,
    height: 428,
  })),
});
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
});
beforeEach(() => {
  vi.resetAllMocks();
  f.identity = "owner";
  f.generation = 0;
  f.recent = false;
  window.localStorage.setItem("upmina:locale", "es");
  f.get.mockResolvedValue(detail());
  f.challenge.mockResolvedValue({ data: { id: "challenge" }, error: null });
  f.verify.mockResolvedValue({ error: null });
  f.access.mockResolvedValue({ mfaRecent: true, capabilities: ["cosplay_admin"] });
  f.prepare.mockImplementation(async (file: File) => ({
    blob: file,
    mime: file.type,
    bytes: file.size,
    strategy: "original",
    width: null,
    height: null,
  }));
  f.reserve.mockResolvedValue({
    assetId: "new-asset",
    mode: "single",
    uploadUrl: "https://upload.test/synthetic",
    expiresInSeconds: 900,
  });
  f.put.mockResolvedValue({ etag: "etag" });
  f.complete.mockResolvedValue({
    assetId: "new-asset",
    status: "ready",
    kind: "image",
    variants: [
      {
        variant: 480,
        width: 468,
        height: 428,
        bytes: 42,
        url: "https://public.test/new.webp",
      },
    ],
  });
  f.save.mockImplementation(async (input) => ({
    post: { id: input.postId ?? "new-post", version: 8, status: input.status },
    images: input.images.map((image: { assetId: string }) => ({
      ...image,
      id: `persisted-${image.assetId}`,
    })),
  }));
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
function open(postId: string | null = null) {
  const success = vi.fn(),
    close = vi.fn(),
    changed = vi.fn();
  const view = () => (
    <LocaleProvider>
      <CosplayEditorDialog
        postId={postId}
        resumeDraft={Boolean(postId)}
        onClose={close}
        onPostChanged={changed}
        onPublishSuccess={success}
      />
    </LocaleProvider>
  );
  const rendered = render(view());
  return {
    ...rendered,
    success,
    close,
    changed,
    update: () => rendered.rerender(view()),
  };
}
async function challenge(action = "Publicar") {
  f.save.mockRejectedValueOnce(stepUp());
  fireEvent.click(screen.getByRole("button", { name: action }));
  await screen.findByRole("textbox", { name: "Código de verificación" });
}
async function verify() {
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Código de verificación" }),
    { target: { value: "123456" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
  await screen.findByText(
    "Verificación completada. Ya puedes realizar acciones de administrador. Revisa tu publicación antes de continuar.",
  );
}
function addFile(container: HTMLElement) {
  const file = new File(["fixture"], "local.jpg", { type: "image/jpeg" });
  fireEvent.change(container.querySelector("input[type=file]")!, {
    target: { files: [file] },
  });
  return file;
}

describe("live Cosplay editor and real uploader across inline MFA", () => {
  it("narrow viewport retains one scrollable dialog and keyboard-operable inline MFA", async () => {
    vi.stubGlobal("innerWidth", 375);
    const view = open();
    fireEvent.change(screen.getByLabelText("Título"), {
      target: { value: "Trabajo móvil" },
    });
    await challenge();
    expect(view.container.querySelectorAll("dialog")).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "Código de verificación" })).toHaveFocus();
    expect(view.container.querySelector("dialog")).toHaveClass("w-screen", "h-dvh");
    expect(screen.getByRole("button", { name: "Volver al editor" })).toBeVisible();
    await verify();
    expect(screen.getByDisplayValue("Trabajo móvil")).toHaveFocus();
    vi.unstubAllGlobals();
  });
  it("failed media and its original File remain available for explicit retry after MFA", async () => {
    const view = open();
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Trabajo" } });
    f.complete.mockResolvedValueOnce({
      assetId: "new-asset",
      status: "failed",
      failureCode: "processing_failed",
    });
    const file = addFile(view.container);
    await screen.findByRole("button", { name: "Reintentar" });
    await challenge();
    await verify();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "El procesado no pudo completarse",
    );
    expect(f.reserve).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(f.complete).toHaveBeenCalledTimes(2));
    expect(f.prepare.mock.calls[1]![0]).toBe(file);
    expect(f.reserve).toHaveBeenCalledTimes(2);
    expect(f.abort).not.toHaveBeenCalled();
  });
  it.each([
    ["Guardar borrador", null],
    ["Publicar", null],
    ["Guardar borrador", "draft"],
    ["Publicar", "draft"],
  ] as const)(
    "%s preserves every field and File; only explicit retry persists once",
    async (action, postId) => {
      const view = open(postId);
      if (postId) await screen.findByDisplayValue("Título");
      for (const [label, value] of [
        ["Título", "Nuevo título"],
        ["Descripción", "Texto sin guardar"],
        ["Personaje", "Nuevo personaje"],
        ["Serie / franquicia", "Nueva serie"],
      ])
        fireEvent.change(screen.getByLabelText(label!), { target: { value } });
      const file = addFile(view.container);
      await waitFor(() => expect(f.complete).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: action })).toBeEnabled(),
      );
      const dialog = view.container.querySelector("dialog");
      const fileInput = view.container.querySelector("input[type=file]");
      await challenge(action);
      expect(view.container.querySelectorAll("dialog")).toHaveLength(1);
      expect(document.body.style.overflow).toBe("hidden");
      await verify();
      expect(view.container.querySelector("dialog")).toBe(dialog);
      expect(view.container.querySelector("input[type=file]")).toBe(fileInput);
      for (const value of [
        "Nuevo título",
        "Texto sin guardar",
        "Nuevo personaje",
        "Nueva serie",
      ])
        expect(screen.getByDisplayValue(value)).toBeVisible();
      expect(f.prepare.mock.calls[0]![0]).toBe(file);
      expect(f.put.mock.calls[0]![1]).toBe(file);
      expect(f.save).toHaveBeenCalledTimes(1);
      expect(f.reserve).toHaveBeenCalledTimes(1);
      expect(view.success).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByDisplayValue("Nuevo título")).toHaveFocus());
      fireEvent.click(screen.getByRole("button", { name: action }));
      await waitFor(() => expect(view.success).toHaveBeenCalledTimes(1));
      expect(f.save).toHaveBeenCalledTimes(2);
      expect(f.save.mock.calls[1]![0]).toMatchObject({
        postId,
        expectedVersion: postId ? 7 : null,
        title: "Nuevo título",
        status: action === "Publicar" ? "published" : "draft",
      });
      expect(f.abort).not.toHaveBeenCalled();
    },
  );
  it("order and cover survive without reloading the draft", async () => {
    const view = open("draft");
    await screen.findByDisplayValue("Título");
    fireEvent.click(screen.getByRole("button", { name: "Mover #2 arriba" }));
    fireEvent.click(screen.getByRole("button", { name: "Marcar #1 como portada" }));
    await challenge();
    await verify();
    fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
    await waitFor(() => expect(view.success).toHaveBeenCalled());
    expect(f.save.mock.calls[1]![0].images).toEqual([
      expect.objectContaining({ assetId: "asset-b", position: 0, isCover: true }),
      expect.objectContaining({ assetId: "asset-a", position: 1, isCover: false }),
    ]);
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(f.abort).not.toHaveBeenCalled();
  });
  it.each(["cancel", "escape"])(
    "%s retains text, focus, dialog and permits a later challenge",
    async (mode) => {
      const view = open();
      fireEvent.change(screen.getByLabelText("Título"), {
        target: { value: "Sin guardar" },
      });
      await challenge();
      expect(
        screen.getByRole("textbox", { name: "Código de verificación" }),
      ).toHaveFocus();
      if (mode === "cancel")
        fireEvent.click(screen.getByRole("button", { name: "Volver al editor" }));
      else
        fireEvent(
          view.container.querySelector("dialog")!,
          new Event("cancel", { bubbles: true, cancelable: true }),
        );
      expect(screen.getByDisplayValue("Sin guardar")).toHaveFocus();
      expect(view.close).not.toHaveBeenCalled();
      expect(view.success).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
      await screen.findByRole("textbox", { name: "Código de verificación" });
      expect(f.save).toHaveBeenCalledTimes(1);
      await verify();
    },
  );
  it.each(["invalid", "network", "access"])(
    "%s failure preserves work without announcing persistence",
    async (kind) => {
      const view = open();
      fireEvent.change(screen.getByLabelText("Título"), {
        target: { value: "Sin guardar" },
      });
      await challenge();
      if (kind === "invalid")
        f.verify.mockResolvedValueOnce({
          error: { code: "mfa_verification_failed", message: "SECRET" },
        });
      if (kind === "network") f.verify.mockRejectedValueOnce(new Error("SECRET"));
      if (kind === "access") f.access.mockResolvedValueOnce(null);
      fireEvent.change(screen.getByRole("textbox", { name: "Código de verificación" }), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
      await screen.findByRole("alert");
      expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument();
      expect(view.success).not.toHaveBeenCalled();
      expect(f.save).toHaveBeenCalledTimes(1);
      expect(view.container.querySelector("input[data-autofocus]")).toHaveValue(
        "Sin guardar",
      );
      fireEvent.click(screen.getByRole("button", { name: "Volver al editor" }));
      expect(screen.getByDisplayValue("Sin guardar")).toBeVisible();
    },
  );
  it("a second MFA cycle works with the same editor", async () => {
    open();
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Trabajo" } });
    await challenge();
    await verify();
    await challenge();
    await verify();
    expect(f.verify).toHaveBeenCalledTimes(2);
    expect(f.save).toHaveBeenCalledTimes(2);
  });
  it.each(["logout", "change", "logout-login"])(
    "%s during deferred verification blocks old-session continuation",
    async (mode) => {
      const view = open();
      fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Trabajo" } });
      await challenge();
      const pending = deferred<{ error: null }>();
      f.verify.mockReturnValueOnce(pending.promise);
      fireEvent.change(screen.getByRole("textbox", { name: "Código de verificación" }), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
      await waitFor(() => expect(f.verify).toHaveBeenCalled());
      f.identity = mode === "logout" ? "" : mode === "change" ? "other" : "owner";
      f.generation++;
      view.update();
      await act(async () => pending.resolve({ error: null }));
      expect(screen.getByRole("alert")).toHaveTextContent("Tu sesión cambió");
      expect(view.success).not.toHaveBeenCalled();
      expect(f.access).not.toHaveBeenCalled();
      expect(f.save).toHaveBeenCalledTimes(1);
    },
  );
  it("closing while verification is pending cannot recover or persist later", async () => {
    const view = open();
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Trabajo" } });
    await challenge();
    const pending = deferred<{ error: null }>();
    f.verify.mockReturnValueOnce(pending.promise);
    fireEvent.change(screen.getByRole("textbox", { name: "Código de verificación" }), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
    await waitFor(() => expect(f.verify).toHaveBeenCalled());
    view.unmount();
    await act(async () => pending.resolve({ error: null }));
    expect(f.access).not.toHaveBeenCalled();
    expect(view.success).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe("");
  });
  it("stale version after verification follows the normal conflict path", async () => {
    open("draft");
    await screen.findByDisplayValue("Título");
    await challenge();
    await verify();
    f.save.mockRejectedValueOnce(
      new CosplayAdminClientError("Conflict", 409, "cosplay_version_conflict"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
    await screen.findByText(/versión|modificada|cambiado/i);
    expect(screen.getByDisplayValue("Título")).toBeVisible();
    expect(f.save.mock.calls[1]![0].expectedVersion).toBe(7);
  });
  it.each([401, 403])("generic %s never opens MFA", async (status) => {
    open();
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Trabajo" } });
    f.save.mockRejectedValueOnce(
      new CosplayAdminClientError(
        "Denied",
        status,
        "generic",
        status === 401 ? "unauthenticated" : "forbidden",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Publicar" }));
    await screen.findByRole("alert");
    expect(
      screen.queryByRole("textbox", { name: "Código de verificación" }),
    ).not.toBeInTheDocument();
  });
  it("initial protected load challenges inline and requires explicit load retry", async () => {
    f.get.mockRejectedValueOnce(stepUp());
    open("draft");
    await screen.findByRole("textbox", { name: "Código de verificación" });
    await verify();
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(screen.queryByDisplayValue("Título")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Volver a cargar publicación" }));
    await screen.findByDisplayValue("Título");
    expect(f.get).toHaveBeenCalledTimes(2);
  });
  it("detach requires a fresh confirmation after MFA", async () => {
    open("draft");
    await screen.findByDisplayValue("Título");
    f.detach.mockRejectedValueOnce(stepUp());
    fireEvent.click(screen.getByRole("button", { name: "Quitar #2" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar y quitar" }));
    await screen.findByRole("textbox", { name: "Código de verificación" });
    await verify();
    expect(f.detach).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Confirmar y quitar" }),
    ).not.toBeInTheDocument();
    expect(f.abort).not.toHaveBeenCalled();
  });
  it("draft delete is not replayed after MFA", async () => {
    const view = open("draft");
    await screen.findByDisplayValue("Título");
    f.remove.mockRejectedValueOnce(stepUp());
    fireEvent.click(screen.getByRole("button", { name: "Eliminar borrador" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar eliminación" }));
    await screen.findByRole("textbox", { name: "Código de verificación" });
    await verify();
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(view.close).not.toHaveBeenCalled();
    expect(view.success).not.toHaveBeenCalled();
  });
  it("READY unpersisted media survives MFA without release, duplicate reservation or abort", async () => {
    const view = open();
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Trabajo" } });
    addFile(view.container);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Publicar" })).toBeEnabled(),
    );
    await challenge();
    await verify();
    expect(screen.getByText("local.jpg")).toBeVisible();
    expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.abort).not.toHaveBeenCalled();
  });
  it("a PUT in progress stays reachable while another operation challenges", async () => {
    const view = open("draft");
    await screen.findByDisplayValue("Título");
    const pending = deferred<{ etag: string }>();
    f.put.mockReturnValueOnce(pending.promise);
    const file = addFile(view.container);
    await waitFor(() => expect(f.put).toHaveBeenCalledTimes(1));
    f.detach.mockRejectedValueOnce(stepUp());
    fireEvent.click(screen.getByRole("button", { name: "Quitar #2" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar y quitar" }));
    await screen.findByRole("textbox", { name: "Código de verificación" });
    await act(async () => pending.resolve({ etag: "etag" }));
    expect(f.complete).not.toHaveBeenCalled();
    await verify();
    expect(screen.getByText("local.jpg")).toBeVisible();
    expect(f.prepare.mock.calls[0]![0]).toBe(file);
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(f.complete).toHaveBeenCalledTimes(1));
    expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f.put).toHaveBeenCalledTimes(1);
  });
  it("complete interruption recovers the same asset only on explicit retry", async () => {
    const view = open();
    const file = addFile(view.container);
    f.complete.mockRejectedValueOnce(uploadStepUp());
    await screen.findByRole("textbox", { name: "Código de verificación" });
    await verify();
    expect(f.complete).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(f.complete).toHaveBeenCalledTimes(2));
    expect(f.complete.mock.calls.map((call) => call[0])).toEqual([
      { assetId: "new-asset" },
      { assetId: "new-asset" },
    ]);
    expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f.put).toHaveBeenCalledTimes(1);
    expect(f.put.mock.calls[0]![1]).toBe(file);
    expect(f.abort).not.toHaveBeenCalled();
  });
});
