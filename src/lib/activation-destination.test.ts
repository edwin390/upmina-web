import { describe, expect, it } from "vitest";
import { resolveActivationDestination } from "./activation-destination";
import { parseSafeReturnTo } from "./safe-return-to";

describe("resolveActivationDestination", () => {
  it("admin → /admin", () => {
    expect(resolveActivationDestination("admin")).toBe("/admin");
  });

  it("moderator → /account", () => {
    expect(resolveActivationDestination("moderator")).toBe("/account");
  });

  it("developer → /account (defensivo: developer no es un rol invitable hoy)", () => {
    expect(resolveActivationDestination("developer")).toBe("/account");
  });

  it.each([
    "",
    "user",
    "ADMIN",
    "Admin",
    " admin",
    "admin ",
    "superadmin",
    null,
    undefined,
    0,
    {},
    ["admin"],
    { role: "admin" },
  ])("valor desconocido %j → /account, nunca /admin", (value) => {
    expect(resolveActivationDestination(value)).toBe("/account");
  });

  it("los destinos son rutas de la allowlist de returnTo (misma fuente de verdad)", () => {
    for (const role of ["admin", "moderator", "developer"]) {
      const destination = resolveActivationDestination(role);
      expect(parseSafeReturnTo(destination)?.path).toBe(destination);
    }
  });
});
