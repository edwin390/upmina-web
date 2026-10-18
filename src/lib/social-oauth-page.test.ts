import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLEAN_URL_SCRIPT,
  SOCIAL_PAGE_HEADERS,
  renderSocialOAuthPage,
  socialPageKind,
} from "./social-oauth-page";

describe("pantalla de resultado OAuth", () => {
  it("está en inglés, escapa el texto y ofrece volver (y reintentar solo si falló)", () => {
    const ok = renderSocialOAuthPage("Account connected", "<b>x</b>", "success");
    expect(ok).toContain('lang="en"');
    expect(ok).toContain("Return to settings");
    expect(ok).not.toContain("Try again");
    expect(ok).toContain("&#60;b&#62;x&#60;/b&#62;");
    expect(renderSocialOAuthPage("t", "m", "error")).toContain("Try again");
  });
  it("un único script fijo, autorizado por hash, que limpia la URL visible", () => {
    const html = renderSocialOAuthPage("t", "m", "expired");
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain(`<script>${CLEAN_URL_SCRIPT}</script>`);
    const hash = createHash("sha256").update(CLEAN_URL_SCRIPT).digest("base64");
    expect(SOCIAL_PAGE_HEADERS["Content-Security-Policy"]).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'`,
    );
    expect(CLEAN_URL_SCRIPT).not.toMatch(/search|code|state|fetch|document/);
  });
  it("clasifica el desenlace", () => {
    expect(socialPageKind(200, "Account connected")).toBe("success");
    expect(socialPageKind(400, "Authorization cancelled")).toBe("cancelled");
    expect(socialPageKind(400, "x")).toBe("expired");
    expect(socialPageKind(403, "x")).toBe("unavailable");
    expect(socialPageKind(502, "x")).toBe("unavailable");
  });

  it("usa la identidad visual actual (tokens azul/rosa, tema claro) y ninguno de los colores antiguos", () => {
    const kinds = ["success", "error", "cancelled", "expired", "unavailable"] as const;
    for (const kind of kinds) {
      const html = renderSocialOAuthPage("t", "m", kind);
      for (const old of ["#0a0a0a", "#141414", "#ff2d95", "#00f0ff", "#f5f5f5"])
        expect(html.toLowerCase()).not.toContain(old);
      expect(html).toContain("--bg:rgb(11 13 19)");
      expect(html).toContain("--accent:rgb(116 184 244)");
      expect(html).toContain("--pink:rgb(255 77 166)");
      expect(html).toContain("prefers-color-scheme:light");
      expect(html).toContain(
        '<p class="brand" aria-hidden="true">UPMINA<span>A</span></p>',
      );
      // Sin recursos externos: la CSP (default-src 'none') no admite imágenes ni fuentes remotas.
      expect(html).not.toMatch(/<img|@import|url\(|https?:\/\//);
    }
  });
});
