import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CommunityPostEditorForm from "./CommunityPostEditorForm";
import { CommunityClientError } from "@/lib/community-client";

// AUTH-2: una cuenta incompleta (email sin verificar / username pendiente) NO está sancionada. El
// editor muestra su propio aviso, conserva el borrador, no simula éxito, no reintenta y no usa el
// modelo de strikes.

const mocks = vi.hoisted(() => ({ save: vi.fn(), success: vi.fn() }));
vi.mock("@/lib/action-notice", () => ({ showActionSuccess: mocks.success }));
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
const publish = () => fireEvent.click(screen.getByRole("button", { name: "Publicar" }));

describe("editor: rechazo por cuenta incompleta", () => {
  it("username pendiente: aviso con enlace a /account, borrador intacto, sin éxito ni reintento", async () => {
    mocks.save.mockRejectedValue(incomplete("username_missing"));
    const onSaved = renderEditor();
    type("Mi borrador");
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
    publish();
    await screen.findByText("Choose your username first");
    expect(mocks.save).toHaveBeenCalledTimes(1);

    publish();
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Choose your username first")).toBeNull();
  });
});
