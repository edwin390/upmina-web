import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import LocaleProvider from "@/i18n/LocaleProvider";
import CosplayEditorDialog from "./CosplayEditorDialog";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  remove: vi.fn(),
  state: {} as Record<string, unknown>,
}));
vi.mock("@/hooks/useCosplayEditor", () => ({ useCosplayEditor: () => mocks.state }));
vi.mock("@/hooks/useCosplayEditorSession", () => ({
  useCosplayEditorSession: () => ({
    isActive: () => true,
    isCurrent: async () => true,
    invalidSession: false,
  }),
}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
});
beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.setItem("upmina:locale", "es");
  mocks.state = {
    postId: null,
    status: "draft",
    fields: { title: "Trabajo", description: "", characterName: "", series: "" },
    photos: [],
    remainingCapacity: 20,
    canSave: true,
    saving: null,
    loading: false,
    save: mocks.save,
    confirmDelete: mocks.remove,
  };
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
function open() {
  const success = vi.fn();
  const close = vi.fn();
  render(
    <MemoryRouter>
      <LocaleProvider>
        <CosplayEditorDialog
          postId={mocks.state.postId as string | null}
          onClose={close}
          onPostChanged={vi.fn()}
          onPublishSuccess={success}
        />
      </LocaleProvider>
    </MemoryRouter>,
  );
  return { success, close };
}

it.each([
  [null, "Guardar borrador", "Borrador guardado correctamente"],
  [null, "Publicar", "Publicación creada correctamente"],
  ["persisted-draft", "Publicar", "Publicación actualizada correctamente"],
])(
  "confirmed save %s / %s closes and emits exactly one appropriate success",
  async (id, button, message) => {
    mocks.state.postId = id;
    let resolve!: (value: unknown) => void;
    mocks.save.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { success, close } = open();
    fireEvent.click(screen.getByRole("button", { name: button! }));
    expect(success).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    resolve({
      post: { id: id ?? "new", status: button === "Publicar" ? "published" : "draft" },
    });
    await waitFor(() => expect(success).toHaveBeenCalledWith(message));
    expect(success).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  },
);

it.each(["Guardar borrador", "Publicar"])(
  "failure or MFA challenge on %s never announces persistence or closes",
  async (button) => {
    mocks.state.saveErrorCode = "generic";
    mocks.save.mockResolvedValue(undefined);
    const { success, close } = open();
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(success).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      button === "Guardar borrador"
        ? "No se pudo guardar el borrador"
        : "No se pudo publicar",
    );
  },
);

it.each([true, false])(
  "draft deletion success=%s uses confirmed persistence only",
  async (saved) => {
    mocks.state.postId = "draft";
    if (!saved) mocks.state.deleteErrorCode = "generic";
    mocks.remove.mockResolvedValue(saved);
    const { success, close } = open();
    fireEvent.click(screen.getByRole("button", { name: "Eliminar borrador" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar eliminación" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(1));
    if (saved) {
      await waitFor(() =>
        expect(success).toHaveBeenCalledWith("Borrador eliminado correctamente"),
      );
      expect(success).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } else {
      expect(success).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "No se pudo eliminar el borrador",
      );
    }
  },
);
