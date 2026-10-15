import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import LegalDocument, { type LegalDocId } from "./LegalDocument";

const DOCS: LegalDocId[] = ["terms", "privacy", "legal", "rules"];
const LANGS = ["es", "en", "de"] as const;
const read = (l: string, d: string) =>
  readFileSync(`src/content/legal/${l}/${d}.md`, "utf8");

afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {
    // sin almacenamiento
  }
});

describe("contenido legal final", () => {
  it("existen los 4 documentos en ES/EN/DE con la misma estructura y sin marcadores pendientes", () => {
    for (const d of DOCS) {
      const h2 = LANGS.map((l) => (read(l, d).match(/^## /gm) ?? []).length);
      expect(new Set(h2).size, `${d} H2 ${h2}`).toBe(1);
      for (const l of LANGS) {
        const t = read(l, d);
        expect(t, `${l}/${d}`).not.toMatch(
          /\[(PENDIENTE|PENDING|AUSSTEHEND|CONFIRMAR|CONFIRM|BESTÄTIGEN)|\b(borrador|draft|entwurf)\b/i,
        );
        expect(t).not.toMatch(/\bMIT\b/);
      }
    }
    expect(readdirSync("src/content/legal").sort()).toEqual(["de", "en", "es"]);
  });

  it("datos del responsable, contacto y 18 años, sin datos personales ajenos ni la edad de 13", () => {
    for (const l of LANGS) {
      const all = DOCS.map((d) => read(l, d)).join("\n");
      expect(all).toContain("Edwin Santiago Ramos Andrade");
      expect(all).toContain(
        "C. Felicitas del Río 9, Barrio Nuevo Progreso, C.P. 59920, Tangamandapio, Michoacán",
      );
      expect(all).toContain("upminaaweb@gmail.com");
      expect(read(l, "terms")).toMatch(/18/);
      expect(all).not.toMatch(/er179822/);
      expect(all).not.toMatch(/13 (años|years|Jahre)/);
    }
  });

  it("no afirma cumplimiento de la UE: reconoce las obligaciones posibles", () => {
    expect(read("es", "legal")).toMatch(/no declara que estén cumplidas/);
    expect(read("en", "legal")).toMatch(/does not state that they have been met/);
    expect(read("de", "legal")).toMatch(/erklärt nicht, dass sie erfüllt sind/);
  });
});

describe("LegalDocument", () => {
  const view = (doc: LegalDocId) => {
    if (!localStorage.getItem("upmina:locale"))
      localStorage.setItem("upmina:locale", "es");
    return render(
      <MemoryRouter>
        <LegalDocument doc={doc} />
      </MemoryRouter>,
    );
  };

  it("muestra los Términos en español por defecto", async () => {
    view("terms");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Términos y condiciones" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/al menos 18 años/)).toBeInTheDocument();
  });

  it.each([
    ["en", "terms", "Terms and Conditions"],
    ["de", "privacy", "Datenschutzerklärung"],
    ["en", "rules", "Community Rules"],
  ] as const)("usa el idioma guardado (%s)", async (lang, doc, title) => {
    localStorage.setItem("upmina:locale", lang);
    view(doc);
    expect(
      await screen.findByRole("heading", { level: 1, name: title }),
    ).toBeInTheDocument();
  });

  it("los enlaces internos son rutas del router", async () => {
    view("terms");
    const link = await screen.findByRole("link", {
      name: "reclamación de derechos de autor",
    });
    expect(link).toHaveAttribute("href", "/copyright");
    expect(link).not.toHaveAttribute("target");
  });
});
