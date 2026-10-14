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
});
