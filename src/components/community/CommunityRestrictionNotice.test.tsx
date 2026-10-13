import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import CommunityRestrictionNotice from "./CommunityRestrictionNotice";

afterEach(() => vi.useRealTimers());

describe("CommunityRestrictionNotice", () => {
  it("Strike 1: title, level, deadline, full reason and the delete reminder", () => {
    render(
      <CommunityRestrictionNotice
        restriction={{
          level: 1,
          permanent: false,
          endsAt: "2099-10-20T10:00:00+00:00",
          reason: "Spam repetido",
        }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Publicación restringida");
    expect(alert).toHaveTextContent(
      "Has recibido tu primer strike por incumplir las normas de la comunidad.",
    );
    expect(alert).toHaveTextContent(
      /No puedes crear ni editar publicaciones hasta .*2099/,
    );
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
          endsAt: "2099-11-20T00:00:00+00:00",
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

  it("Strike 1: muestra la advertencia de escalada una sola vez, junto al plazo y el motivo", () => {
    render(
      <CommunityRestrictionNotice
        restriction={{
          level: 1,
          permanent: false,
          endsAt: "2099-10-20T10:00:00+00:00",
          reason: "Spam",
        }}
      />,
    );
    const warning = screen.getAllByTestId("restriction-warning");
    expect(warning).toHaveLength(1);
    expect(warning[0]).toHaveTextContent(/^Advertencia: los strikes siguen contando/);
    expect(warning[0]).toHaveTextContent(
      "Un segundo strike supondrá una restricción de un mes",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Motivo: Spam");
  });
  it("Strike 2: última advertencia (más urgente), con el plazo y el motivo", () => {
    render(
      <CommunityRestrictionNotice
        restriction={{
          level: 2,
          permanent: false,
          endsAt: "2099-11-20T00:00:00+00:00",
          reason: "Acoso",
        }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Has recibido tu segundo strike.");
    expect(screen.getByTestId("restriction-warning")).toHaveTextContent(
      /^Última advertencia: si recibes un tercer strike/,
    );
    expect(alert).toHaveTextContent(/hasta .*2099/);
    expect(alert).toHaveTextContent("Motivo: Acoso");
  });
  it("Strike 3: restricción permanente con motivo y sin advertencia de escalada", () => {
    render(
      <CommunityRestrictionNotice
        restriction={{ level: 3, permanent: true, endsAt: null, reason: "Reincidencia" }}
      />,
    );
    expect(screen.queryByTestId("restriction-warning")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Motivo: Reincidencia");
  });
  it("sin detalle del backend: sin advertencia de strike", () => {
    render(<CommunityRestrictionNotice restriction={null} />);
    expect(screen.queryByTestId("restriction-warning")).toBeNull();
  });
  it("plazo ya vencido en este dispositivo: no se afirma que la restricción continúa", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-01T00:00:00Z"));
    render(
      <CommunityRestrictionNotice
        restriction={{
          level: 1,
          permanent: false,
          endsAt: "2026-11-01T00:00:00+00:00",
          reason: "Spam",
        }}
      />,
    );
    expect(screen.getByTestId("restriction-changed")).toHaveTextContent(
      "El estado de tu restricción cambió. Vuelve a intentarlo.",
    );
    expect(screen.queryByTestId("restriction-notice")).toBeNull();
    expect(screen.queryByTestId("restriction-warning")).toBeNull();
    expect(screen.queryByText(/No puedes crear/)).toBeNull();
  });
});
