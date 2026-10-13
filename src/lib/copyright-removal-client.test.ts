import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sb = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: sb.getSession } } }));

import type { AppealPayload } from "./copyright-appeal";
import {
  fetchAppealContext,
  purgeCopyrightClaim,
  removeCopyrightClaim,
  resendCopyrightNotice,
  resolveCopyrightAppeal,
  submitAppeal,
} from "./copyright-client";
import { ModerationClientError } from "./moderation-client";

// COPY-1 fase 2B: cliente de la retirada, la apelación y la eliminación manual. fetch es un doble; no hay red.

const ID = "0f000000-0000-4000-8000-0000000000c1";
const TOKEN = "A".repeat(43);
const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const claim = {
  id: ID,
  reference: "CPY-2026-000001",
  status: "removed",
  version: 5,
  updatedAt: "2026-10-12T10:00:00.000Z",
  notice: "sent",
  noticeError: null,
  assetsMarked: null,
  assetsRetained: null,
  postDeleted: null,
};
const payload: AppealPayload = {
  contactName: "Autor Original",
  contactEmail: "autor@example.com",
  reason: "own_work",
  explanation: "La ilustración es mía",
  evidenceText: null,
  evidenceUrls: ["https://example.com/prueba"],
  statementVersion: "v1",
  statementAccepted: true,
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  sb.getSession.mockReset();
  sb.getSession.mockResolvedValue({
    data: { session: { access_token: "tok-sintetico" } },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("moderación", () => {
  it.each([
    [
      "retirar",
      () =>
        removeCopyrightClaim({
          id: ID,
          expectedVersion: 4,
          expectedPostVersion: 7,
          confirmReference: "CPY-2026-000001",
          reason: "Motivo de la retirada",
        }),
      "copyright-claim-remove",
    ],
    [
      "reintentar aviso",
      () => resendCopyrightNotice({ id: ID, kind: "removal" }),
      "copyright-claim-notice",
    ],
    [
      "resolver apelación",
      () =>
        resolveCopyrightAppeal({
          id: ID,
          expectedVersion: 4,
          decision: "accept",
          note: "nota",
        }),
      "copyright-claim-appeal-resolve",
    ],
    [
      "eliminar",
      () =>
        purgeCopyrightClaim({
          id: ID,
          expectedVersion: 4,
          confirmReference: "CPY-2026-000001",
          note: "nota",
        }),
      "copyright-claim-purge",
    ],
  ])(
    "%s: POST autenticado y sin caché a su acción del dispatcher",
    async (_name, run, action) => {
      fetchMock.mockResolvedValue(reply(200, { claim }));
      const result = await run();
      expect(result).toMatchObject({ status: "removed", notice: "sent" });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(`/api/admin/${action}`);
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer tok-sintetico");
      expect(init.cache).toBe("no-store");
    },
  );

  it("propaga el código del servidor para que la interfaz lo explique", async () => {
    fetchMock.mockResolvedValue(
      reply(409, { error: "No se pudo completar la acción", code: "purge_blocked" }),
    );
    const error = await purgeCopyrightClaim({
      id: ID,
      expectedVersion: 1,
      confirmReference: "CPY-2026-000001",
      note: "n",
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ModerationClientError);
    expect(error.status).toBe(409);
    expect(error.code).toBe("purge_blocked");
  });

  it("sin sesión no llama al servidor y rechaza respuestas con forma inválida", async () => {
    sb.getSession.mockResolvedValue({ data: { session: null } });
    await expect(
      resendCopyrightNotice({ id: ID, kind: "removal" }),
    ).rejects.toMatchObject({
      status: 401,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    sb.getSession.mockResolvedValue({ data: { session: { access_token: "t" } } });
    for (const bad of [
      { claim: { ...claim, status: "otro" } },
      { claim: { ...claim, notice: "x" } },
      {},
    ]) {
      fetchMock.mockResolvedValue(reply(200, bad));
      await expect(
        resendCopyrightNotice({ id: ID, kind: "removal" }),
      ).rejects.toMatchObject({
        status: 502,
      });
    }
  });
});

describe("autor", () => {
  const appeal = {
    reference: "CPY-2026-000001",
    state: "open",
    reason: "Motivo",
    removedAt: "2026-10-12T10:00:00.000Z",
    appealDeadline: "2026-10-12T11:00:00.000Z",
    appealStatus: null,
  };

  it("el token viaja en el CUERPO, nunca en la URL, y la sesión es la del autor", async () => {
    fetchMock.mockResolvedValue(reply(200, { appeal }));
    const outcome = await fetchAppealContext(TOKEN);
    expect(outcome).toMatchObject({ kind: "ok", appeal: { state: "open" } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/admin/copyright-appeal-context");
    expect(String(url)).not.toContain(TOKEN);
    expect(JSON.parse(init.body)).toEqual({ token: TOKEN });
    expect(init.headers.Authorization).toBe("Bearer tok-sintetico");
  });

  it("distingue sin sesión, no disponible y error técnico", async () => {
    sb.getSession.mockResolvedValue({ data: { session: null } });
    expect(await fetchAppealContext(TOKEN)).toEqual({ kind: "unauthenticated" });
    expect(fetchMock).not.toHaveBeenCalled();
    sb.getSession.mockResolvedValue({ data: { session: { access_token: "t" } } });
    for (const [status, kind] of [
      [401, "unauthenticated"],
      [404, "not_available"],
      [500, "error"],
    ] as const) {
      fetchMock.mockResolvedValue(reply(status, {}));
      expect(await fetchAppealContext(TOKEN)).toEqual({ kind });
    }
    fetchMock.mockResolvedValue(reply(200, { appeal: { ...appeal, state: "raro" } }));
    expect(await fetchAppealContext(TOKEN)).toEqual({ kind: "error" });
    fetchMock.mockRejectedValue(new Error("red"));
    expect(await fetchAppealContext(TOKEN)).toEqual({ kind: "error" });
  });

  it("presenta la apelación con el token en el cuerpo y distingue cada resultado", async () => {
    fetchMock.mockResolvedValue(
      reply(201, { appeal: { reference: "CPY-2026-000001", state: "submitted" } }),
    );
    expect(await submitAppeal(TOKEN, payload)).toEqual({
      kind: "submitted",
      reference: "CPY-2026-000001",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/admin/copyright-appeal-submit");
    expect(JSON.parse(init.body)).toEqual({ token: TOKEN, appeal: payload });
    for (const [status, body, kind] of [
      [409, { code: "appeal_already_submitted" }, "already_submitted"],
      [409, { code: "appeal_window_closed" }, "window_closed"],
      [404, { code: "appeal_not_available" }, "not_available"],
      [400, {}, "invalid"],
      [401, {}, "unauthenticated"],
      [500, {}, "error"],
    ] as const) {
      fetchMock.mockResolvedValue(reply(status, body));
      expect(await submitAppeal(TOKEN, payload)).toEqual({ kind });
    }
    fetchMock.mockRejectedValue(new Error("red"));
    expect(await submitAppeal(TOKEN, payload)).toEqual({ kind: "error" });
  });

  it("sin sesión no envía nada", async () => {
    sb.getSession.mockResolvedValue({ data: { session: null } });
    expect(await submitAppeal(TOKEN, payload)).toEqual({ kind: "unauthenticated" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
