import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App";

describe("rutas legales", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
  });

  it.each([
    ["/terms", "Terms of Service"],
    ["/privacy", "Privacy Policy"],
  ])("%s muestra su página, la fecha y el contacto", (path, title) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    expect(screen.getByText("Effective date: September 20, 2026")).toBeInTheDocument();
    const mail = screen.getAllByRole("link", { name: "er179822@gmail.com" });
    expect(mail.length).toBeGreaterThan(0);
    for (const link of mail) {
      expect(link).toHaveAttribute("href", "mailto:er179822@gmail.com");
    }
  });

  it("el footer enlaza a Terms y Privacy, que no están en el menú principal", () => {
    render(
      <MemoryRouter initialEntries={["/terms"]}>
        <App />
      </MemoryRouter>,
    );

    const legalNav = screen.getByRole("navigation", { name: "Legal" });
    expect(legalNav.querySelector('a[href="/terms"]')).not.toBeNull();
    expect(legalNav.querySelector('a[href="/privacy"]')).not.toBeNull();
    const headerNav = document.querySelector("header nav");
    expect(headerNav?.querySelector('a[href="/terms"], a[href="/privacy"]')).toBeNull();
  });
});
