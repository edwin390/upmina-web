import { afterEach, describe, expect, it, vi } from "vitest";
import {
  passwordRecoveryLookupEnabled,
  prefilledEmailFromState,
  requestPasswordRecovery,
} from "./password-recovery-client";

afterEach(() => vi.unstubAllEnvs());

const reply = (status: number, body: unknown) =>
  ({ status, ok: status < 300, json: async () => body }) as unknown as Response;

describe("passwordRecoveryLookupEnabled", () => {
  it("apagado por defecto; solo '1' lo activa", () => {
    expect(passwordRecoveryLookupEnabled()).toBe(false);
    for (const value of ["", "0", "true", "yes", "2"]) {
      vi.stubEnv("VITE_PASSWORD_RECOVERY_LOOKUP", value);
      expect(passwordRecoveryLookupEnabled(), value).toBe(false);
    }
    vi.stubEnv("VITE_PASSWORD_RECOVERY_LOOKUP", "1");
    expect(passwordRecoveryLookupEnabled()).toBe(true);
  });
});

describe("requestPasswordRecovery", () => {
  it("POST al endpoint propio con solo { email }, sin credenciales ni caché", async () => {
    const f = vi.fn().mockResolvedValue(reply(200, { status: "confirmed" }));
    await requestPasswordRecovery("a@b.co", f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledWith(
      "/api/profile?action=password-recovery",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        body: JSON.stringify({ email: "a@b.co" }),
      }),
    );
  });

  it.each([
    [200, { status: "confirmed" }, { kind: "confirmed" }],
    [200, { status: "unconfirmed" }, { kind: "unconfirmed" }],
    [200, { status: "unregistered" }, { kind: "unregistered" }],
    [
      429,
      { status: "rate_limited", retryAfterSeconds: 42 },
      { kind: "rate_limited", retryAfterSeconds: 42 },
    ],
    [
      429,
      { status: "rate_limited", retryAfterSeconds: 99999 },
      { kind: "rate_limited", retryAfterSeconds: 3600 },
    ],
    [
      429,
      { status: "rate_limited", retryAfterSeconds: 0 },
      { kind: "rate_limited", retryAfterSeconds: 1 },
    ],
    [429, { status: "rate_limited" }, { kind: "rate_limited", retryAfterSeconds: 60 }],
  ])("HTTP %i %j → %j", async (status, body, expected) => {
    const f = vi.fn().mockResolvedValue(reply(status, body));
    expect(await requestPasswordRecovery("a@b.co", f as unknown as typeof fetch)).toEqual(
      expected,
    );
  });

  it.each([
    [500, { status: "error" }],
    [502, { status: "error" }],
    [503, { status: "error" }],
    [400, { error: "x" }],
    [200, { status: "quizas" }],
    [200, {}],
    [200, null],
    [201, { status: "unregistered" }],
    [429, { status: "otra" }],
    [200, { status: "unregistered-ish" }],
  ])("HTTP %i %j → error (nunca «inexistente»)", async (status, body) => {
    const f = vi.fn().mockResolvedValue(reply(status, body));
    expect(await requestPasswordRecovery("a@b.co", f as unknown as typeof fetch)).toEqual(
      {
        kind: "error",
      },
    );
  });

  it("red caída o cuerpo ilegible → error", async () => {
    expect(
      await requestPasswordRecovery("a@b.co", (() =>
        Promise.reject(new Error("x"))) as unknown as typeof fetch),
    ).toEqual({ kind: "error" });
    const bad = {
      status: 200,
      ok: true,
      json: async () => {
        throw new Error("x");
      },
    };
    expect(
      await requestPasswordRecovery("a@b.co", (() =>
        Promise.resolve(bad)) as unknown as typeof fetch),
    ).toEqual({ kind: "error" });
  });
});

describe("prefilledEmailFromState (correo precargado en /signup)", () => {
  it("acepta un correo con forma válida (recortado) y descarta todo lo demás", () => {
    expect(prefilledEmailFromState({ email: "  persona@example.test " })).toBe(
      "persona@example.test",
    );
    for (const bad of [
      null,
      undefined,
      "texto",
      5,
      {},
      { email: 5 },
      { email: "" },
      { email: "sin-arroba" },
      { email: "a b@c.co" },
      { email: `${"x".repeat(250)}@e.co` },
      { email: "a@b.co\nbcc:x@y.co" },
      { email: "a\u0000@b.co" },
      { other: "a@b.co" },
    ]) {
      expect(prefilledEmailFromState(bad), JSON.stringify(bad)).toBe("");
    }
  });
});
