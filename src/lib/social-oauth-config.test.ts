import { describe, expect, it } from "vitest";
import { instagramRedirectUri } from "./instagram-oauth-shared";
import { socialOAuthOrigin, socialRedirectUri } from "./social-oauth-config";
import { tiktokRedirectUri } from "./tiktok-shared";

describe("origen OAuth social", () => {
  it("Production usa el dominio oficial sin configurar nada y nunca el anterior", () => {
    expect(tiktokRedirectUri({})).toBe("https://upminaa-web.com/api/tiktok-callback");
    expect(instagramRedirectUri({})).toBe(
      "https://upminaa-web.com/api/instagram-callback",
    );
    expect(
      JSON.stringify([tiktokRedirectUri({}), instagramRedirectUri({})]),
    ).not.toContain("vercel.app");
  });
  it("SOCIAL_OAUTH_BASE_URL sustituye solo el origen (https, sin ruta)", () => {
    expect(
      socialOAuthOrigin({ SOCIAL_OAUTH_BASE_URL: " https://staging.example.test/ " }),
    ).toBe("https://staging.example.test");
    expect(
      socialRedirectUri("/api/x-callback", {
        SOCIAL_OAUTH_BASE_URL: "https://a.example.test:8443",
      }),
    ).toBe("https://a.example.test:8443/api/x-callback");
  });
  it.each([
    "http://a.example.test",
    "https://a.example.test/ruta",
    "https://a.example.test?x=1",
    "//a.example.test",
    "javascript:alert(1)",
    "https://user@a.example.test",
  ])("rechaza %s", (value) => {
    expect(() => socialOAuthOrigin({ SOCIAL_OAUTH_BASE_URL: value })).toThrow(
      "invalid_social_oauth_base_url",
    );
  });
});
