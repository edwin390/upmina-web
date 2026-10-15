import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SignupLegalConsent from "./SignupLegalConsent";
import {
  NO_CHECKS,
  buildLegalAcceptance,
  isSignupLegalConsentEnabled,
  type LegalChecks,
} from "@/lib/legal-consent";

function Harness() {
  const [checks, setChecks] = useState<LegalChecks>(NO_CHECKS);
  return (
    <MemoryRouter>
      <SignupLegalConsent checks={checks} onChange={setChecks} />
    </MemoryRouter>
  );
}
afterEach(cleanup);

const boxes = () => screen.getAllByRole("checkbox") as HTMLInputElement[];

describe("SignupLegalConsent", () => {
  it("orden fijo, ninguna marcada y «Aceptar todo» al final tras un separador", () => {
    const { container } = render(<Harness />);
    const labels = boxes().map((b) => b.closest("label")!.textContent);
    expect(labels[0]).toContain("18 años o más");
    expect(labels[1]).toContain("Términos y condiciones");
    expect(labels[2]).toContain("Aviso de privacidad");
    expect(labels[3]).toContain("Normas de Community");
    expect(labels[4]).toBe("Aceptar todo");
    expect(boxes().every((b) => !b.checked)).toBe(true);
    const sep = container.querySelector("hr")!;
    expect(
      sep.compareDocumentPosition(boxes()[4]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("Aceptar todo marca y desmarca las tres", () => {
    render(<Harness />);
    fireEvent.click(boxes()[4]);
    expect(boxes().map((b) => b.checked)).toEqual([true, true, true, true, true]);
    fireEvent.click(boxes()[4]);
    expect(boxes().map((b) => b.checked)).toEqual([false, false, false, false, false]);
  });

  it("marcar las tres individuales activa Aceptar todo y desmarcar una lo desactiva", () => {
    render(<Harness />);
    for (const i of [0, 1, 2, 3]) fireEvent.click(boxes()[i]);
    expect(boxes()[4].checked).toBe(true);
    fireEvent.click(boxes()[1]);
    expect(boxes()[4].checked).toBe(false);
    expect(boxes().map((b) => b.checked)).toEqual([true, false, true, true, false]);
  });

  it("los documentos son enlaces que abren en pestaña nueva", () => {
    render(<Harness />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/terms",
      "/privacy",
      "/community-rules",
    ]);
    expect(links.every((l) => l.getAttribute("target") === "_blank")).toBe(true);
  });
});

describe("legal-consent", () => {
  it("desactivado salvo VITE_SIGNUP_LEGAL_CONSENT=true", () => {
    expect(isSignupLegalConsentEnabled({})).toBe(false);
    expect(isSignupLegalConsentEnabled({ VITE_SIGNUP_LEGAL_CONSENT: "1" })).toBe(false);
    expect(isSignupLegalConsentEnabled({ VITE_SIGNUP_LEGAL_CONSENT: "true" })).toBe(true);
  });
  it("solo construye la evidencia con las tres aceptaciones", () => {
    expect(buildLegalAcceptance({ ...NO_CHECKS, terms: true })).toBeNull();
    expect(
      buildLegalAcceptance({
        adult_declaration: true,
        terms: true,
        privacy: true,
        community_rules: true,
      }),
    ).toEqual({
      adult_declaration: "v1.0",
      terms: "v1.0",
      privacy: "v1.0",
      community_rules: "v1.0",
    });
  });
});
