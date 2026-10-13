import { beforeEach, describe, expect, it, vi } from "vitest";

// Reverificación del TOTP en la propia página (Developer Panel V1). Datos SINTÉTICOS.

const mfa = vi.hoisted(() => ({
  listFactors: vi.fn(),
  challenge: vi.fn(),
  verify: vi.fn(),
}));
const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase", () => ({
  get supabase() {
    return holder.client;
  },
}));

import { reverifyTotp } from "./totp-reverify";

const FACTOR = "fffffff1-ffff-4fff-8fff-fffffffffff1";

beforeEach(() => {
  holder.client = { auth: { mfa } };
  mfa.listFactors.mockReset();
  mfa.challenge.mockReset();
  mfa.verify.mockReset();
  mfa.listFactors.mockResolvedValue({ data: { totp: [{ id: FACTOR }] }, error: null });
  mfa.challenge.mockResolvedValue({ data: { id: "challenge-1" }, error: null });
  mfa.verify.mockResolvedValue({ data: {}, error: null });
});

describe("reverifyTotp", () => {
  it("hace challenge + verify sobre el factor TOTP verificado con un challenge nuevo", async () => {
    expect(await reverifyTotp(" 123456 ")).toBe("ok");
    expect(mfa.challenge).toHaveBeenCalledWith({ factorId: FACTOR });
    expect(mfa.verify).toHaveBeenCalledWith({
      factorId: FACTOR,
      challengeId: "challenge-1",
      code: "123456",
    });
  });

  it.each(["", "12345", "1234567", "abcdef", "12 456", "١٢٣٤٥٦"])(
    "formato inválido «%s»: no llama a Supabase",
    async (code) => {
      expect(await reverifyTotp(code)).toBe("invalid_format");
      expect(mfa.listFactors).not.toHaveBeenCalled();
    },
  );

  it("sin factor verificado → no_factor y sin challenge", async () => {
    mfa.listFactors.mockResolvedValue({ data: { totp: [] }, error: null });
    expect(await reverifyTotp("123456")).toBe("no_factor");
    expect(mfa.challenge).not.toHaveBeenCalled();
  });

  it.each([
    "mfa_verification_failed",
    "mfa_challenge_expired",
    "mfa_verification_rejected",
  ])("código %s → invalid_code", async (code) => {
    mfa.verify.mockResolvedValue({
      data: null,
      error: { code, message: "texto interno" },
    });
    expect(await reverifyTotp("123456")).toBe("invalid_code");
  });

  it("otros errores (red, 5xx, listado, challenge) → failed sin propagar mensajes del proveedor", async () => {
    mfa.verify.mockResolvedValue({ data: null, error: { code: "unexpected_failure" } });
    expect(await reverifyTotp("123456")).toBe("failed");
    mfa.verify.mockRejectedValue(new Error("ECONNRESET 10.0.0.1"));
    expect(await reverifyTotp("123456")).toBe("failed");
    mfa.listFactors.mockResolvedValue({ data: null, error: { message: "x" } });
    expect(await reverifyTotp("123456")).toBe("failed");
    mfa.listFactors.mockResolvedValue({ data: { totp: [{ id: FACTOR }] }, error: null });
    mfa.challenge.mockResolvedValue({ data: null, error: { message: "x" } });
    expect(await reverifyTotp("123456")).toBe("failed");
  });

  it("sin cliente de Supabase → failed", async () => {
    holder.client = null;
    expect(await reverifyTotp("123456")).toBe("failed");
  });
});
