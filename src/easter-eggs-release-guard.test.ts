// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Control de release de Easter Eggs: los antiguos (Konami/Echidna, doble clic en el logo/Sukuna y la estrella flotante) están
// RETIRADOS, y el sistema nuevo (src/secrets, en la rama feat/easter-eggs) NO forma parte de esta línea de release. Estas pruebas
// fallan si algo de eso reaparece en la rama que se publica, de modo que reintroducirlo sea una decisión consciente y no un accidente.
const read = (p: string) => readFileSync(resolve(p), "utf8");

describe("Easter Eggs: control de release", () => {
  it("los activadores antiguos ya no existen en App, Header ni AmbientBackground", () => {
    const app = read("src/App.tsx");
    for (const word of ["konami", "sukuna", "echidna", "Mina dejó una estrella"])
      expect(app.toLowerCase()).not.toContain(word.toLowerCase());
    expect(app).not.toMatch(/addEventListener\("keydown"/);
    expect(read("src/components/layout/Header.tsx")).not.toMatch(
      /onDoubleClick|onLogoDoubleClick/,
    );
    const ambient = read("src/components/ui/AmbientBackground.tsx");
    expect(ambient).not.toMatch(/onStarClick|ambient-star|<button/);
  });

  it("no quedan estilos, recursos ni textos de los antiguos", () => {
    expect(read("src/styles/globals.css")).not.toMatch(/sukuna|ambient-star|star-pop/);
    expect(existsSync(resolve("public/images/echidna.gif"))).toBe(false);
    for (const loc of ["es", "en", "de"]) {
      const site = read(`src/i18n/locales/${loc}/site.json`);
      expect(site).not.toMatch(/"surprise"|"logoTitle"/);
    }
  });

  it("el sistema nuevo no está cableado en la aplicación que se publica", () => {
    const app = read("src/App.tsx");
    expect(app).not.toMatch(/secrets\//i);
    expect(app).not.toMatch(/SecretsProvider|SecretsOverlay/);
    // Si src/secrets llegara a esta rama, nada fuera de él puede importarlo (se exigiría una puerta de build explícita).
    if (existsSync(resolve("src/secrets"))) {
      for (const f of ["src/main.tsx", "src/App.tsx", "src/components/layout/Header.tsx"])
        expect(read(f)).not.toMatch(/from "(\.\.?\/)+secrets/);
    }
  });
});
