import { describe, expect, it } from "vitest";
import {
  getLatestPasswordTimestamp,
  isPasswordRecent,
  PASSWORD_RECENT_WINDOW_SECONDS,
} from "./privileged-mfa";

// Recencia del inicio de sesión con contraseña (recuperación de MFA fase 2). Una sesión antigua NO
// puede saltarse la confirmación: la evidencia es el `amr` del JWT verificado, que un refresco no renueva.

const NOW = 1_800_000_000;

describe("getLatestPasswordTimestamp", () => {
  it("toma la marca MÁS reciente del método password e ignora otros métodos y formas inválidas", () => {
    expect(
      getLatestPasswordTimestamp([
        { method: "password", timestamp: NOW - 5000 },
        { method: "password", timestamp: NOW - 10 },
        { method: "totp", timestamp: NOW },
        { method: "otp", timestamp: NOW },
        { method: "oauth", timestamp: NOW },
      ]),
    ).toBe(NOW - 10);
  });
  it.each([
    [undefined],
    [null],
    ["password"],
    [["password"]],
    [[{ method: "password" }]],
    [[{ method: "password", timestamp: "123" }]],
    [[{ method: "password", timestamp: 0 }]],
    [[{ method: "password", timestamp: -5 }]],
    [[{ method: "password", timestamp: Number.NaN }]],
    [[{ method: "otp", timestamp: NOW }]],
  ])("evidencia ausente o malformada (%j) → null", (amr) => {
    expect(getLatestPasswordTimestamp(amr)).toBeNull();
  });
});

describe("isPasswordRecent", () => {
  it("el límite exacto cuenta como reciente; un segundo más no", () => {
    expect(isPasswordRecent(NOW - PASSWORD_RECENT_WINDOW_SECONDS, NOW)).toBe(true);
    expect(isPasswordRecent(NOW - PASSWORD_RECENT_WINDOW_SECONDS - 1, NOW)).toBe(false);
  });
  it("una sesión antigua (horas) no pasa, aunque el JWT siga vigente", () => {
    expect(isPasswordRecent(NOW - 3600, NOW)).toBe(false);
    expect(isPasswordRecent(NOW - 7200, NOW)).toBe(false);
  });
  it("un inicio de sesión recién hecho pasa; un timestamp futuro más allá de la tolerancia falla cerrado", () => {
    expect(isPasswordRecent(NOW - 2, NOW)).toBe(true);
    expect(isPasswordRecent(NOW + 30, NOW)).toBe(true); // desfase de reloj tolerado
    expect(isPasswordRecent(NOW + 3600, NOW)).toBe(false);
  });
  it("ausente o no finito → falso", () => {
    expect(isPasswordRecent(null, NOW)).toBe(false);
    expect(isPasswordRecent(undefined, NOW)).toBe(false);
    expect(isPasswordRecent(Number.NaN, NOW)).toBe(false);
    expect(isPasswordRecent(NOW, Number.NaN)).toBe(false);
    expect(isPasswordRecent(NOW, NOW, 0)).toBe(false);
  });
});
