import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import CosplayLocaleProvider from "@/i18n/LocaleProvider";
import { CosplayAdminClientError } from "@/lib/cosplay-admin-client";
import CommunityPostTileMenu from "@/components/community/CommunityPostTileMenu";
import type { CommunityOwnPost } from "@/lib/community-client";
import CosplayCardAdminMenu from "./CosplayCardAdminMenu";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  remove: vi.fn(),
  communityRemove: vi.fn(),
}));
vi.mock("@/lib/cosplay-admin-client", async () => ({
  ...(await vi.importActual("@/lib/cosplay-admin-client")),
  getCosplayPostAdmin: mocks.get,
  deleteCosplayPost: mocks.remove,
}));
vi.mock("@/lib/community-client", async () => ({
  ...(await vi.importActual("@/lib/community-client")),
  deleteCommunityPost: mocks.communityRemove,
}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
beforeEach(() => {
  localStorage.setItem("upmina:locale", "es");
  vi.resetAllMocks();
  mocks.get.mockResolvedValue({ version: 7 });
  mocks.remove.mockResolvedValue(undefined);
  mocks.communityRemove.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  localStorage.removeItem("upmina:locale");
});

function MfaDestination() {
  const location = useLocation();
  return (
    <p>
      {location.pathname + location.search} origin:{location.state?.cancelTo}
    </p>
  );
}
function renderMenu() {
  const deleted = vi.fn();
  const view = render(
    <MemoryRouter initialEntries={["/cosplay"]}>
      <Routes>
        <Route
          path="/cosplay"
          element={
            <CosplayLocaleProvider>
              <div
                data-testid="card"
                style={{ overflow: "hidden", transform: "translateX(0)", width: 80 }}
              >
                <CosplayCardAdminMenu
                  postId="cosplay-post"
                  postTitle="Prueba"
                  onEdit={vi.fn()}
                  onDeleted={deleted}
                />
              </div>
            </CosplayLocaleProvider>
          }
        />
        <Route path="/admin/mfa" element={<MfaDestination />} />
      </Routes>
    </MemoryRouter>,
  );
  return { ...view, deleted };
}
async function openConfirmation() {
  const trigger = screen.getByRole("button", { name: /más acciones/i });
  trigger.focus();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("menuitem", { name: "Eliminar" }));
  return screen.findByRole("dialog", { name: "¿Eliminar esta publicación de Cosplay?" });
}

it("mirrors Community's viewport shell and body portal rather than the clipping card", async () => {
  const post = {
    id: "community-post",
    version: 3,
    text: "Prueba",
    status: "published",
    createdAt: "x",
    updatedAt: "x",
    likeCount: 0,
    media: [],
  } satisfies CommunityOwnPost;
  const reference = render(
    <CommunityPostTileMenu post={post} onEdit={vi.fn()} onDeleted={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Gestionar esta publicación" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Eliminar" }));
  const referenceClass = screen.getByRole("dialog").className;
  fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
  expect(mocks.communityRemove).not.toHaveBeenCalled();
  reference.unmount();
  renderMenu();
  const dialog = await openConfirmation();
  expect(dialog.parentElement).toBe(document.body);
  expect(screen.getByTestId("card")).not.toContainElement(dialog);
  expect(dialog.className).toBe(referenceClass);
  expect(dialog).toHaveClass(
    "w-[calc(100%-2rem)]",
    "max-w-sm",
    "overflow-y-auto",
    "backdrop:bg-bg-base/80",
  );
  expect(within(dialog).getByText(/No se puede deshacer/)).toBeVisible();
  expect(within(dialog).getByRole("button", { name: "Cancelar" })).toHaveFocus();
  expect(
    within(dialog).getByRole("button", { name: "Confirmar eliminación" }),
  ).toBeEnabled();
  expect(mocks.remove).not.toHaveBeenCalled();
});

it.each(["cancel", "escape"])(
  "%s closes without mutation and restores focus/scroll",
  async (action) => {
    document.body.style.overflow = "auto";
    const { deleted } = renderMenu();
    const dialog = await openConfirmation();
    expect(document.body.style.overflow).toBe("hidden");
    if (action === "cancel")
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    else fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("auto");
    expect(screen.getByRole("button", { name: /más acciones/i })).toHaveFocus();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.communityRemove).not.toHaveBeenCalled();
    expect(deleted).not.toHaveBeenCalled();
    document.body.style.overflow = "";
  },
);

it("explicit confirmation submits the Cosplay ID/version once; Escape cannot close a pending delete", async () => {
  let complete!: () => void;
  mocks.remove.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const { deleted } = renderMenu();
  const dialog = await openConfirmation();
  const confirm = within(dialog).getByRole("button", { name: "Confirmar eliminación" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
  expect(dialog).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Cancelar" })).toBeDisabled();
  expect(mocks.remove).toHaveBeenCalledTimes(1);
  expect(mocks.remove).toHaveBeenCalledWith({
    postId: "cosplay-post",
    expectedVersion: 7,
  });
  expect(mocks.communityRemove).not.toHaveBeenCalled();
  complete();
  await waitFor(() => expect(deleted).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it.each(["read", "delete"])(
  "MFA interruption during %s retains the existing return/origin and never replays deletion",
  async (phase) => {
    const failure = new CosplayAdminClientError(
      "synthetic",
      403,
      "step_up_required",
      "step_up_required",
    );
    if (phase === "read") mocks.get.mockRejectedValue(failure);
    else mocks.remove.mockRejectedValue(failure);
    const { deleted } = renderMenu();
    if (phase === "delete") {
      const dialog = await openConfirmation();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Confirmar eliminación" }),
      );
    } else {
      fireEvent.click(screen.getByRole("button", { name: /más acciones/i }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Eliminar" }));
    }
    await screen.findByText(/\/admin\/mfa.*origin:\/cosplay/);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.remove).toHaveBeenCalledTimes(phase === "delete" ? 1 : 0);
    expect(deleted).not.toHaveBeenCalled();
  },
);
