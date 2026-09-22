import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import router from "../../api/admin/[action]";
import * as handlers from "./admin-handlers";

// Fija el despachador api/admin/[action].ts (Bloque 2C): comprueba que la acción
// correcta llega al handler correcto y que una acción desconocida nunca se resuelve
// dinámicamente (siempre 404, sin llamar a ningún handler). La lógica de "activate" en
// sí se cubre en admin-handlers.test.ts contra el mismo handler reexportado aquí.

vi.mock("./admin-handlers", () => ({
  handleAdminActivate: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("activate"),
  ),
}));

function mockRes() {
  const state: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
    setHeader() {
      return res;
    },
  };
  return { res: res as unknown as VercelResponse, state };
}

function req(action?: string, method = "POST") {
  return {
    method,
    query: { ...(action !== undefined ? { action } : {}) },
  } as unknown as VercelRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("api/admin/[action] (despachador)", () => {
  it("action=activate → solo handleAdminActivate, con el mismo req/res", async () => {
    const request = req("activate");
    const { res } = mockRes();

    await router(request, res);

    expect(handlers.handleAdminActivate).toHaveBeenCalledWith(request, res);
  });

  it("action desconocida → 404, ningún handler se llama", async () => {
    const { res, state } = mockRes();

    await router(req("borrar-todo"), res);

    expect(state.status).toBe(404);
    expect(handlers.handleAdminActivate).not.toHaveBeenCalled();
  });

  it("sin action en absoluto → 404 (fail closed)", async () => {
    const { res, state } = mockRes();

    await router(req(undefined), res);

    expect(state.status).toBe(404);
    expect(handlers.handleAdminActivate).not.toHaveBeenCalled();
  });

  it("action=activate no se resuelve dinámicamente desde un pathname arbitrario: solo el valor literal del switch dispara el handler", async () => {
    const { res, state } = mockRes();

    await router(req("Activate"), res);

    expect(state.status).toBe(404);
    expect(handlers.handleAdminActivate).not.toHaveBeenCalled();
  });
});
