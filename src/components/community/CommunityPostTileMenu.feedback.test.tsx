import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import CommunityPostTileMenu from "./CommunityPostTileMenu";
import type { CommunityOwnPost } from "@/lib/community-client";
const mocks = vi.hoisted(() => ({ remove: vi.fn(), success: vi.fn() }));
vi.mock("@/lib/community-client", async () => ({
  ...(await vi.importActual("@/lib/community-client")),
  deleteCommunityPost: mocks.remove,
}));
vi.mock("@/lib/action-notice", () => ({ showActionSuccess: mocks.success }));
const post: CommunityOwnPost = {
  id: "post",
  version: 1,
  text: "Post",
  status: "published",
  createdAt: "x",
  updatedAt: "x",
  likeCount: 0,
  media: [],
};
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);
it.each([true, false])(
  "delete success=%s reports exactly the confirmed outcome",
  async (ok) => {
    const deleted = vi.fn();
    if (ok) mocks.remove.mockResolvedValue(undefined);
    else mocks.remove.mockRejectedValue(new Error("network"));
    render(<CommunityPostTileMenu post={post} onEdit={vi.fn()} onDeleted={deleted} />);
    fireEvent.click(screen.getByRole("button", { name: "Gestionar esta publicación" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Eliminar" }));
    expect(mocks.success).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    if (ok) {
      await waitFor(() => expect(deleted).toHaveBeenCalledTimes(1));
      expect(mocks.success).toHaveBeenCalledTimes(1);
      expect(mocks.success).toHaveBeenCalledWith("Publicación eliminada correctamente");
    } else {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "No se pudo eliminar la publicación",
      );
      expect(mocks.success).not.toHaveBeenCalled();
      expect(deleted).not.toHaveBeenCalled();
    }
  },
);
