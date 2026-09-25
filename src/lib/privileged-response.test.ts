import { describe, expect, it, vi } from "vitest";
import { classifyPrivilegedFailure } from "./privileged-response";

// Semántica ÚNICA de los rechazos de un request privilegiado (Fase 9G-3):
//   401 → unauthenticated · 403 + code exacto "step_up_required" → step_up_required ·
//   cualquier otro 403 → forbidden (NUNCA MFA) · resto → null.

const res = (status: number, body?: unknown) => ({
  status,
  json: async () => body,
});

describe("classifyPrivilegedFailure", () => {
  it("401 → unauthenticated", async () => {
    expect(await classifyPrivilegedFailure(res(401, { error: "No autenticado" }))).toBe(
      "unauthenticated",
    );
  });

  it("403 con code=step_up_required → step_up_required", async () => {
    expect(
      await classifyPrivilegedFailure(
        res(403, { error: "No autorizado", code: "step_up_required" }),
      ),
    ).toBe("step_up_required");
  });

  it("403 genérico (sin code) → forbidden, jamás step-up", async () => {
    expect(await classifyPrivilegedFailure(res(403, { error: "No autorizado" }))).toBe(
      "forbidden",
    );
  });

  it.each([
    ["code distinto", { code: "other" }],
    ["code en mayúsculas", { code: "STEP_UP_REQUIRED" }],
    ["code con espacios", { code: " step_up_required" }],
    ["code no string", { code: 1 }],
    ["code anidado", { error: { code: "step_up_required" } }],
    ["code en un array", [{ code: "step_up_required" }]],
    ["cuerpo string", "step_up_required"],
    ["cuerpo null", null],
    ["cuerpo vacío", undefined],
    ["mensaje que menciona el código", { error: "step_up_required" }],
  ])("403 con %s → forbidden (coincidencia exacta del código)", async (_n, body) => {
    expect(await classifyPrivilegedFailure(res(403, body))).toBe("forbidden");
  });

  it("403 con cuerpo ilegible o sin json() → forbidden (fail closed hacia 'sin MFA')", async () => {
    expect(
      await classifyPrivilegedFailure({
        status: 403,
        json: async () => Promise.reject(new Error("x")),
      }),
    ).toBe("forbidden");
    expect(await classifyPrivilegedFailure({ status: 403 })).toBe("forbidden");
  });

  it.each([200, 201, 204, 400, 404, 409, 429, 500, 503])(
    "status %i no es un rechazo de autorización → null",
    async (status) => {
      expect(
        await classifyPrivilegedFailure(res(status, { code: "step_up_required" })),
      ).toBeNull();
    },
  );

  it.each([null, undefined])("respuesta %s → null", async (value) => {
    expect(await classifyPrivilegedFailure(value)).toBeNull();
  });

  it("status no numérico → null", async () => {
    expect(
      await classifyPrivilegedFailure({ status: "403" as unknown as number }),
    ).toBeNull();
  });

  it("solo lee el cuerpo de un 403 (nunca de un 401 ni de un éxito)", async () => {
    const json = vi.fn(async () => ({}));
    await classifyPrivilegedFailure({ status: 401, json });
    await classifyPrivilegedFailure({ status: 200, json });
    expect(json).not.toHaveBeenCalled();
  });

  it("lee una COPIA si existe clone(): el cuerpo original queda disponible para quien llamó", async () => {
    const original = vi.fn(async () => ({ code: "step_up_required" }));
    const cloned = vi.fn(async () => ({ code: "step_up_required" }));
    const response = {
      status: 403,
      json: original,
      clone: () => ({ status: 403, json: cloned }),
    };

    expect(await classifyPrivilegedFailure(response)).toBe("step_up_required");
    expect(cloned).toHaveBeenCalledTimes(1);
    expect(original).not.toHaveBeenCalled();
  });

  it("es pura: solo devuelve un dato, no ejecuta nada (ni fetch ni navegación)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("no debe llamarse");
    });
    const before = window.location.href;

    await classifyPrivilegedFailure(res(403, { code: "step_up_required" }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    fetchSpy.mockRestore();
  });
});
