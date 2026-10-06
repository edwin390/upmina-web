import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import router from "../../api/media/[resource]";
import * as handlers from "./media-handlers";
import { handleMediaGc } from "./media-gc-handler";

// Fija el despachador de medios (api/media/[resource].ts, Fase 9I-2B — función 12/12 del plan
// Hobby): solo comprueba que el `resource` correcto llega al handler correcto y que uno
// desconocido no llama a ninguno. La lógica de cada handler ya está cubierta por
// media-handlers.test.ts.

vi.mock("./media-gc-handler", () => ({
  handleMediaGc: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("gc"),
  ),
}));
vi.mock("./media-handlers", () => ({
  handleMediaReserve: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("reserve"),
  ),
  handleMediaComplete: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("complete"),
  ),
  handleMediaAbort: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("abort"),
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

function req(resource?: string) {
  return { query: { resource } } as unknown as VercelRequest;
}

describe("api/media/[resource]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reserve → handleMediaReserve", async () => {
    const { res, state } = mockRes();
    await router(req("reserve"), res);
    expect(handlers.handleMediaReserve).toHaveBeenCalledTimes(1);
    expect(handlers.handleMediaComplete).not.toHaveBeenCalled();
    expect(handlers.handleMediaAbort).not.toHaveBeenCalled();
    expect(state.body).toBe("reserve");
  });

  it("complete → handleMediaComplete", async () => {
    const { res, state } = mockRes();
    await router(req("complete"), res);
    expect(handlers.handleMediaComplete).toHaveBeenCalledTimes(1);
    expect(handlers.handleMediaReserve).not.toHaveBeenCalled();
    expect(state.body).toBe("complete");
  });

  it("abort → handleMediaAbort", async () => {
    const { res, state } = mockRes();
    await router(req("abort"), res);
    expect(handlers.handleMediaAbort).toHaveBeenCalledTimes(1);
    expect(state.body).toBe("abort");
  });

  it("resource desconocido → 404, sin llamar a ningún handler", async () => {
    const { res, state } = mockRes();
    await router(req("algo-inventado"), res);
    expect(state.status).toBe(404);
    expect(handlers.handleMediaReserve).not.toHaveBeenCalled();
    expect(handlers.handleMediaComplete).not.toHaveBeenCalled();
    expect(handlers.handleMediaAbort).not.toHaveBeenCalled();
  });

  it("sin resource → 404", async () => {
    const { res, state } = mockRes();
    await router(req(undefined), res);
    expect(state.status).toBe(404);
  });

  it("gc → handleMediaGc (R4-E2), y solo POST interno vía ese resource", async () => {
    const { res, state } = mockRes();
    await router(req("gc"), res);
    expect(handleMediaGc).toHaveBeenCalledTimes(1);
    expect(handlers.handleMediaReserve).not.toHaveBeenCalled();
    expect(state.body).toBe("gc");
  });
});
