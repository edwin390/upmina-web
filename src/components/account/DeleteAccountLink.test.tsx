import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import DeleteAccountLink from "./DeleteAccountLink";
import { RETURN_ROUTES } from "@/lib/safe-return-to";
import { readFileSync } from "node:fs";

// Entrada a la eliminación desde /account (DEL-3) y consistencia de la navegación.

beforeEach(() => localStorage.setItem("upmina:locale", "es"));
afterEach(() => cleanup());

describe("entrada desde /account", () => {
  it.each([
    ["es", "Eliminar cuenta"],
    ["en", "Delete account"],
    ["de", "Konto löschen"],
  ])("enlace único a /account/delete en %s", async (locale, label) => {
    localStorage.setItem("upmina:locale", locale);
    render(
      <MemoryRouter>
        <DeleteAccountLink />
      </MemoryRouter>,
    );
    const link = await screen.findByRole("link", { name: label });
    expect(link.getAttribute("href")).toBe("/account/delete");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});

describe("integridad de la navegación", () => {
  it("la ruta /account/delete está registrada ANTES del comodín de perfil y es un destino de returnTo seguro sin parámetros", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const del = app.indexOf('path="/account/delete"');
    const wildcard = app.indexOf('path="/:usernameParam"');
    expect(del).toBeGreaterThan(-1);
    expect(del).toBeLessThan(wildcard);
    expect(app.match(/path="\/account\/delete"/g)).toHaveLength(1);
    expect(RETURN_ROUTES["/account/delete"]).toEqual({ allowsIntent: false });
  });

  it("AccountPage incluye la entrada y solo dentro de la rama con sesión", () => {
    const page = readFileSync("src/pages/AccountPage.tsx", "utf8");
    const loginRedirect = page.indexOf('<Navigate to="/login" replace />');
    const link = page.indexOf("<DeleteAccountLink />");
    expect(link).toBeGreaterThan(loginRedirect);
  });
});
