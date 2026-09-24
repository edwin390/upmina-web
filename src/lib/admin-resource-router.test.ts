import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import router from "../../api/admin/[action]";
import * as handlers from "./admin-handlers";
import * as socialHandlers from "./social-connect-handlers";
import * as statusHandlers from "./social-status-handlers";
import * as teamHandlers from "./admin-team-invitations";

// Fija el despachador api/admin/[action].ts (Bloque 2C): comprueba que la acción
// correcta llega al handler correcto y que una acción desconocida nunca se resuelve
// dinámicamente (siempre 404, sin llamar a ningún handler). La lógica de "activate" en
// sí se cubre en admin-handlers.test.ts contra el mismo handler reexportado aquí.

vi.mock("./admin-handlers", () => ({
  handleAdminActivate: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("activate"),
  ),
  handleAdminMe: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("me"),
  ),
}));

vi.mock("./admin-team-invitations", () => ({
  handleAdminTeamInvitations: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("team-invitations"),
  ),
  handleAdminTeamInvitationRevoke: vi.fn(
    async (_req: VercelRequest, res: VercelResponse) =>
      res.status(200).json("team-invitations-revoke"),
  ),
}));

vi.mock("./social-status-handlers", () => ({
  handleAdminSocialStatus: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("social-status"),
  ),
}));

vi.mock("./social-connect-handlers", () => ({
  handleAdminSocialConnect: vi.fn(async (_req: VercelRequest, res: VercelResponse) =>
    res.status(200).json("social-connect"),
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

  it("action=me → solo handleAdminMe, con el mismo req/res", async () => {
    const request = req("me", "GET");
    const { res } = mockRes();

    await router(request, res);

    expect(handlers.handleAdminMe).toHaveBeenCalledWith(request, res);
    expect(handlers.handleAdminActivate).not.toHaveBeenCalled();
  });
  it("action=team-invitations / team-invitations-revoke → solo su handler (9D), sin resolución dinámica", async () => {
    const r1 = req("team-invitations", "GET");
    const r2 = req("team-invitations-revoke");
    const { res } = mockRes();
    await router(r1, res);
    expect(teamHandlers.handleAdminTeamInvitations).toHaveBeenCalledWith(r1, res);
    expect(teamHandlers.handleAdminTeamInvitationRevoke).not.toHaveBeenCalled();
    await router(r2, res);
    expect(teamHandlers.handleAdminTeamInvitationRevoke).toHaveBeenCalledWith(r2, res);
    for (const bad of ["Team-Invitations", "team-invitations/x", "team_invitations"]) {
      const { res: res2, state } = mockRes();
      await router(req(bad), res2);
      expect(state.status).toBe(404);
    }
    expect(teamHandlers.handleAdminTeamInvitations).toHaveBeenCalledTimes(1);
    expect(handlers.handleAdminActivate).not.toHaveBeenCalled();
  });

  it("action=social-connect → solo handleAdminSocialConnect, con el mismo req/res", async () => {
    const request = req("social-connect");
    const { res } = mockRes();

    await router(request, res);

    expect(socialHandlers.handleAdminSocialConnect).toHaveBeenCalledWith(request, res);
    expect(handlers.handleAdminActivate).not.toHaveBeenCalled();
    expect(handlers.handleAdminMe).not.toHaveBeenCalled();
  });

  it("las demás acciones no disparan handleAdminSocialConnect", async () => {
    const { res } = mockRes();
    await router(req("activate"), res);
    await router(req("me", "GET"), res);
    await router(req("Social-Connect"), res);
    expect(socialHandlers.handleAdminSocialConnect).not.toHaveBeenCalled();
  });
  it("action=social-status → solo handleAdminSocialStatus, con el mismo req/res", async () => {
    const request = req("social-status", "GET");
    const { res } = mockRes();

    await router(request, res);

    expect(statusHandlers.handleAdminSocialStatus).toHaveBeenCalledWith(request, res);
    expect(socialHandlers.handleAdminSocialConnect).not.toHaveBeenCalled();
    expect(handlers.handleAdminMe).not.toHaveBeenCalled();
  });
});
