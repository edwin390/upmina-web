import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CommunityLikeButton from "./CommunityLikeButton";
import { CommunityClientError } from "@/lib/community-client";

// AUTH-2: el like de una cuenta incompleta se revierte (nunca se simula el éxito) y se explica qué
// falta, sin tratarlo como sanción.

const mocks = vi.hoisted(() => ({ like: vi.fn() }));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: { user: { id: "u" } }, loading: false }),
}));
vi.mock("@/lib/community-client", async () => ({
  ...(await vi.importActual("@/lib/community-client")),
  setCommunityPostLike: mocks.like,
}));

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem("upmina:locale", "en");
});

function renderButton() {
  render(
    <MemoryRouter>
      <CommunityLikeButton postId="p1" likeCount={4} likedByMe={false} />
    </MemoryRouter>,
  );
}

describe("like con cuenta incompleta", () => {
  it.each([
    ["username_missing", "Choose your username first"],
    ["email_unverified", "Confirm your email first"],
  ] as const)("reason %s: revierte el contador y avisa (%s)", async (reason, title) => {
    mocks.like.mockRejectedValue(
      new CommunityClientError(
        "Cuenta incompleta",
        403,
        "account_incomplete",
        null,
        null,
        reason,
      ),
    );
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "Me gusta (4)" }));

    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Me gusta (4)" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(mocks.like).toHaveBeenCalledTimes(1);
  });

  it("otro error del servidor revierte pero NO muestra el aviso de cuenta", async () => {
    mocks.like.mockRejectedValue(new CommunityClientError("boom", 500));
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "Me gusta (4)" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Me gusta (4)" })).toBeEnabled(),
    );
    expect(screen.queryByText("Choose your username first")).toBeNull();
    expect(screen.queryByText("Confirm your email first")).toBeNull();
  });

  it("like con cuenta completa: sigue funcionando", async () => {
    mocks.like.mockResolvedValue({ postId: "p1", likeCount: 5, likedByMe: true });
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "Me gusta (4)" }));
    expect(
      await screen.findByRole("button", { name: "Quitar me gusta (5)" }),
    ).toBeTruthy();
  });
});
