import { describe, expect, it } from "vitest";
import {
  confirmationRedirectUrl,
  isAuthLinkSuccess,
  parseAuthLinkError,
} from "./auth-link-error";

// AUTH-1: clasificación del retorno del enlace de confirmación (solo tipo de fallo; nunca el texto del proveedor).

describe("parseAuthLinkError", () => {
  it("otp_expired → expired (con o sin '#')", () => {
    const h =
      "error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid";
    expect(parseAuthLinkError(`#${h}`)).toBe("expired");
    expect(parseAuthLinkError(h)).toBe("expired");
  });
  it("cualquier otro error del enlace → invalid", () => {
    expect(parseAuthLinkError("#error=access_denied&error_code=bad_jwt")).toBe("invalid");
    expect(parseAuthLinkError("#error=server_error")).toBe("invalid");
  });
  it("sin fallo: vacío, éxito u otros fragmentos → null", () => {
    expect(parseAuthLinkError("")).toBeNull();
    expect(parseAuthLinkError("#")).toBeNull();
    expect(parseAuthLinkError("#access_token=x&type=signup")).toBeNull();
    expect(parseAuthLinkError("#seccion")).toBeNull();
  });
});

describe("isAuthLinkSuccess", () => {
  it("solo un fragmento con access_token y type=signup", () => {
    expect(isAuthLinkSuccess("#access_token=synthetic&refresh_token=r&type=signup")).toBe(
      true,
    );
    expect(isAuthLinkSuccess("#access_token=synthetic&type=recovery")).toBe(false);
    expect(isAuthLinkSuccess("#type=signup")).toBe(false);
    expect(isAuthLinkSuccess("#error=access_denied&error_code=otp_expired")).toBe(false);
    expect(isAuthLinkSuccess("")).toBe(false);
  });
});

describe("confirmationRedirectUrl", () => {
  it("siempre /login del mismo origen (sin tokens ni parámetros)", () => {
    expect(confirmationRedirectUrl()).toBe(`${window.location.origin}/login`);
  });
});
