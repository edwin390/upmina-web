import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sb = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: sb.getSession } } }));

import type { ClaimPayload } from "./copyright-claim";
import {
  fetchCopyrightClaim,
  fetchCopyrightClaimPage,
  reviewCopyrightClaim,
  submitCopyrightClaim,
} from "./copyright-client";
import { ModerationClientError } from "./moderation-client";

// COPY-1 fase 2A: cliente del formulario público y de la pestaña de moderación. fetch es un doble; no hay red.

const ID = "0f000000-0000-4000-8000-0000000000c1";
const payload: ClaimPayload = {
  claimantName: "Ana Titular",
  claimantEmail: "ana@example.com",
  organization: null,
  relationship: "owner",
  workDescription: "Ilustración original publicada en mi portafolio",
  infringementDescription: "La publicación reutiliza mi ilustración sin permiso",
  evidenceUrls: ["https://example.com/obra"],
  postUrl: "https://upmina.test/community/x",
  postId: null,
  signature: "Ana Titular",
  statementVersion: "v1",
  statementsAccepted: true,
};
const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const summary = {
  id: ID,
  reference: "CPY-2026-000001",
  status: "received",
  version: 1,
  claimantName: "Ana Titular",
  relationship: "owner",
  postFound: false,
  createdAt: "2026-10-12T10:00:00.000Z",
  updatedAt: "2026-10-12T10:00:00.000Z",
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

describe("formulario público", () => {
  it("envía por POST sin credenciales ni sesión, con el señuelo, y distingue la referencia", async () => {
    fetchMock.mockResolvedValue(
      reply(201, { status: "received", reference: "CPY-2026-000009" }),
    );
    const outcome = await submitCopyrightClaim(payload);
    expect(outcome).toEqual({ kind: "received", reference: "CPY-2026-000009" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/admin/copyright-claim-create");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
    });
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ ...payload, website: "" });
    expect(sb.getSession).not.toHaveBeenCalled();
  });

  it("reenvía el valor del señuelo tal cual (lo descarta el servidor)", async () => {
    fetchMock.mockResolvedValue(reply(201, { status: "received" }));
    expect(await submitCopyrightClaim(payload, "http://spam.example")).toEqual({
      kind: "received",
      reference: null,
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).website).toBe(
      "http://spam.example",
    );
  });

  it("una referencia mal formada se ignora, pero la recepción sigue siendo válida", async () => {
    fetchMock.mockResolvedValue(
      reply(201, { status: "received", reference: "<script>" }),
    );
    expect(await submitCopyrightClaim(payload)).toEqual({
      kind: "received",
      reference: null,
    });
  });

  it("límite: acota los segundos de espera", async () => {
    fetchMock.mockResolvedValue(
      reply(429, { status: "rate_limited", retryAfterSeconds: 90 }),
    );
    expect(await submitCopyrightClaim(payload)).toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 90,
    });
    fetchMock.mockResolvedValue(
      reply(429, { status: "rate_limited", retryAfterSeconds: 9e12 }),
    );
    expect(await submitCopyrightClaim(payload)).toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 86_400,
    });
    fetchMock.mockResolvedValue(
      reply(429, { status: "rate_limited", retryAfterSeconds: "x" }),
    );
    expect(await submitCopyrightClaim(payload)).toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 60,
    });
  });

  it("400 es inválido; cualquier otra cosa es error técnico y NUNCA «recibida»", async () => {
    fetchMock.mockResolvedValue(reply(400, { error: "Solicitud inválida" }));
    expect(await submitCopyrightClaim(payload)).toEqual({ kind: "invalid" });
    for (const status of [401, 403, 404, 415, 500, 502, 503]) {
      fetchMock.mockResolvedValue(reply(status, { error: "x" }));
      expect(await submitCopyrightClaim(payload)).toEqual({ kind: "error" });
    }
    fetchMock.mockResolvedValue(reply(200, { status: "received" }));
    expect(await submitCopyrightClaim(payload)).toEqual({ kind: "error" });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => Promise.reject(new Error("x")),
    });
    expect(await submitCopyrightClaim(payload)).toEqual({ kind: "error" });
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await submitCopyrightClaim(payload)).toEqual({ kind: "error" });
  });
});

describe("moderación", () => {
  it("sin sesión no hace ninguna petición", async () => {
    sb.getSession.mockResolvedValue({ data: { session: null } });
    await expect(fetchCopyrightClaimPage("open", null)).rejects.toMatchObject({
      status: 401,
    });
    await expect(fetchCopyrightClaim(ID)).rejects.toBeInstanceOf(ModerationClientError);
    await expect(
      reviewCopyrightClaim({ id: ID, action: "start_review", expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("la cola envía el Bearer, el ámbito y el cursor, y valida la respuesta", async () => {
    fetchMock.mockResolvedValue(reply(200, { claims: [summary], nextCursor: "abc" }));
    const page = await fetchCopyrightClaimPage("closed", "cur-1");
    expect(page).toEqual({ claims: [summary], nextCursor: "abc" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/admin/copyright-claims?scope=closed&cursor=cur-1");
    expect(init.headers).toEqual({ Authorization: "Bearer tok-sintetico" });
    expect(init.cache).toBe("no-store");
    fetchMock.mockResolvedValue(
      reply(200, { claims: [{ ...summary, status: "upheld" }] }),
    );
    await expect(fetchCopyrightClaimPage("open", null)).rejects.toMatchObject({
      status: 502,
    });
    fetchMock.mockResolvedValue(reply(200, { claims: Array(26).fill(summary) }));
    await expect(fetchCopyrightClaimPage("open", null)).rejects.toMatchObject({
      status: 502,
    });
  });

  it("los errores conservan estado y código del servidor, nunca el cuerpo en bruto", async () => {
    fetchMock.mockResolvedValue(
      reply(403, { error: "No autorizado", code: "step_up_required" }),
    );
    await expect(fetchCopyrightClaimPage("open", null)).rejects.toMatchObject({
      status: 403,
      code: "step_up_required",
    });
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => Promise.reject(new Error("x")),
    });
    await expect(fetchCopyrightClaim(ID)).rejects.toMatchObject({ status: 500 });
  });

  it("el detalle y la revisión validan sus respuestas", async () => {
    fetchMock.mockResolvedValue(reply(200, { claim: { ...summary, claimantEmail: 5 } }));
    await expect(fetchCopyrightClaim(ID)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValue(
      reply(200, {
        claim: {
          id: ID,
          reference: "CPY-2026-000001",
          status: "in_review",
          version: 2,
          updatedAt: "2026-10-12T10:05:00.000Z",
        },
      }),
    );
    const result = await reviewCopyrightClaim({
      id: ID,
      action: "start_review",
      expectedVersion: 1,
    });
    expect(result.status).toBe("in_review");
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("/api/admin/copyright-claim-review");
    expect(init).toMatchObject({ method: "POST", cache: "no-store" });
    expect(init.headers).toEqual({
      Authorization: "Bearer tok-sintetico",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({
      id: ID,
      action: "start_review",
      expectedVersion: 1,
    });
    fetchMock.mockResolvedValue(reply(200, { claim: { status: "removed" } }));
    await expect(
      reviewCopyrightClaim({ id: ID, action: "start_review", expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 502 });
  });
});
