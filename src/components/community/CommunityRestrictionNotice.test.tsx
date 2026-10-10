import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import CommunityRestrictionNotice from "./CommunityRestrictionNotice";

describe("CommunityRestrictionNotice", () => {
  it("Strike 1: title, level, deadline, full reason and the delete reminder", () => {
    render(
      <CommunityRestrictionNotice
        restriction={{
          level: 1,
          permanent: false,
          endsAt: "2026-10-20T10:00:00+00:00",
          reason: "Spam repetido",
        }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Publicación restringida");
    expect(alert).toHaveTextContent("Tu cuenta tiene un Strike 1 activo en Community.");
    expect(alert).toHaveTextContent(/hasta .*2026/);
    expect(alert).toHaveTextContent("Motivo: Spam repetido");
    expect(alert).toHaveTextContent(
      "Puedes seguir eliminando tus propias publicaciones.",
    );
  });
  it("Strike 3 is permanent (no date)", () => {
    render(
      <CommunityRestrictionNotice
        restriction={{ level: 3, permanent: true, endsAt: null, reason: "Reincidencia" }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Strike 3");
    expect(alert).toHaveTextContent("de forma permanente");
    expect(alert.textContent).not.toMatch(/hasta/);
  });
  it("a very long reason wraps inside the notice (no overflow classes missing)", () => {
    render(
      <CommunityRestrictionNotice
        restriction={{
          level: 2,
          permanent: false,
          endsAt: "2026-11-20T00:00:00+00:00",
          reason: "x".repeat(1000),
        }}
      />,
    );
    const reason = screen.getByText(/x{50}/);
    expect(reason.className).toContain("break-words");
    expect(reason.className).toContain("[overflow-wrap:anywhere]");
  });
  it("without detail: neutral and no reason line", () => {
    render(<CommunityRestrictionNotice restriction={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("restricción activa");
    expect(screen.queryByText(/Motivo/)).toBeNull();
  });
  it("changed: neutral stale message, no strike details", () => {
    render(<CommunityRestrictionNotice restriction={null} changed />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "El estado de tu restricción cambió. Vuelve a intentarlo.",
    );
    expect(screen.queryByText(/Strike/)).toBeNull();
  });
});
