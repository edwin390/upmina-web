// @vitest-environment node
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./admin-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./admin-auth.js")>()),
  requireCapability: vi.fn(),
}));

import { AdminAuthError, requireCapability } from "./admin-auth.js";
import { encodeClaimCursor } from "./copyright-contract";
import {
  claimKeys,
  defaultCopyrightDeps,
  handleCopyrightClaim,
  handleCopyrightClaimCreate,
  handleCopyrightClaimReview,
  handleCopyrightClaims,
  type CopyrightDeps,
} from "./copyright-handlers";

// COPY-1 fase 2A: handlers REALES; Supabase es un doble que solo conoce las RPC permitidas. No se envía correo ni se toca nada más.

const SECRET = "synthetic-server-secret";
const MOD = "0f000000-0000-4000-8000-000000000001";
const CLAIM = "0f000000-0000-4000-8000-0000000000c1";
const POST = "0f000000-0000-4000-8000-0000000003e9";

interface Reply {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}
function call(
  handler: (req: VercelRequest, res: VercelResponse) => unknown,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, unknown>;
    query?: object;
  },
): Promise<Reply> {
  const reply: Reply = { status: 0, body: undefined, headers: {} };
  const res = {
    setHeader: (k: string, v: string) => {
      reply.headers[k] = v;
      return res;
    },
    status: (s: number) => {
      reply.status = s;
      return res;
    },
    json: (b: unknown) => {
      reply.body = b;
      return res;
    },
  } as unknown as VercelResponse;
  const req = {
    method: init.method ?? "POST",
    body: init.body,
    headers: init.headers ?? {},
    query: init.query ?? {},
  } as unknown as VercelRequest;
  return Promise.resolve(handler(req, res)).then(() => reply);
}

type RpcResult = { data: unknown; error: unknown };
function fakeClient(result: RpcResult | (() => RpcResult)) {
  const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
    void name;
    void params;
    return typeof result === "function" ? result() : result;
  });
  return { rpc } as unknown as SupabaseClient & { rpc: typeof rpc };
}
const deps = (client: ReturnType<typeof fakeClient> | null): CopyrightDeps => ({
  client: () => client,
  ipSecret: () => (client ? SECRET : null),
});

const JSON_HEADERS = {
  "content-type": "application/json",
  "x-vercel-forwarded-for": "203.0.113.7",
};
const claimBody = (over: Record<string, unknown> = {}) => ({
  claimantName: "Ana Titular",
  claimantEmail: "Ana@Example.com",
  organization: null,
  relationship: "owner",
  workDescription: "Ilustración original publicada en mi portafolio",
  infringementDescription: "La publicación reutiliza mi ilustración sin permiso",
  evidenceUrls: ["https://example.com/obra"],
  postUrl: `https://upmina.test/community/${POST}`,
  postId: POST,
  signature: "Ana Titular",
  statementVersion: "v1",
  statementsAccepted: true,
  website: "",
  ...over,
});
const received = {
  data: { status: "received", reference: "CPY-2026-000007" },
  error: null,
};

describe("creación pública", () => {
  it("valida, llama a la RPC con digests y responde 201 con la referencia", async () => {
    const client = fakeClient(received);
    const reply = await call(
      (req, res) => handleCopyrightClaimCreate(req, res, deps(client)),
      { body: claimBody(), headers: JSON_HEADERS },
    );
    expect(reply.status).toBe(201);
    expect(reply.body).toEqual({ status: "received", reference: "CPY-2026-000007" });
    expect(reply.headers["Cache-Control"]).toBe("no-store");
    expect(client.rpc).toHaveBeenCalledTimes(1);
    const [name, params] = client.rpc.mock.calls[0]!;
    expect(name).toBe("copyright_claim_create");
    expect(Object.keys(params).sort()).toEqual([
      "p_email_key",
      "p_input",
      "p_ip",
      "p_net",
    ]);
    // Ni la IP ni el correo viajan en claro como claves de contador.
    expect(params.p_ip).toMatch(/^[0-9a-f]{64}$/);
    expect(params.p_net).toMatch(/^[0-9a-f]{64}$/);
    expect(params.p_email_key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([params.p_ip, params.p_net, params.p_email_key])).not.toContain(
      "203.0.113",
    );
    // El cuerpo enviado es el NORMALIZADO por el servidor (correo en minúsculas, sin el señuelo).
    expect(params.p_input).toMatchObject({
      claimantEmail: "ana@example.com",
      postId: POST,
      statementVersion: "v1",
      statementsAccepted: true,
    });
    expect(params.p_input).not.toHaveProperty("website");
  });

  it("las claves HMAC dependen del secreto, de la etiqueta y de la red; el correo no distingue mayúsculas", () => {
    const req = {
      headers: { "x-vercel-forwarded-for": "203.0.113.7" },
    } as unknown as VercelRequest;
    const a = claimKeys(req, SECRET, "ana@example.com");
    const b = claimKeys(req, SECRET, "ana@example.com");
    expect(a).toEqual(b);
    expect(claimKeys(req, "otro-secreto", "ana@example.com").ip).not.toBe(a.ip);
    expect(claimKeys(req, SECRET, "otra@example.com").email).not.toBe(a.email);
    const neighbour = {
      headers: { "x-vercel-forwarded-for": "203.0.113.200" },
    } as unknown as VercelRequest;
    expect(claimKeys(neighbour, SECRET, "ana@example.com").net).toBe(a.net);
    expect(claimKeys(neighbour, SECRET, "ana@example.com").ip).not.toBe(a.ip);
    // Separación de contexto: no coincide con el HMAC de la comprobación de contraseñas.
    const lookupStyle = createHmac("sha256", SECRET)
      .update("upmina:lookup:ip:v1:203.0.113.7")
      .digest("hex");
    expect(a.ip).not.toBe(lookupStyle);
    const unknown = claimKeys(
      { headers: {} } as unknown as VercelRequest,
      SECRET,
      "x@y.zz",
    );
    expect([unknown.ip, unknown.net]).toEqual(["unknown", "unknown"]);
  });

  it("una cabecera x-forwarded-for falsificada no cambia la IP de confianza", async () => {
    const forged = { ...JSON_HEADERS, "x-forwarded-for": "198.51.100.99, 198.51.100.98" };
    const c1 = fakeClient(received);
    const c2 = fakeClient(received);
    await call((q, s) => handleCopyrightClaimCreate(q, s, deps(c1)), {
      body: claimBody(),
      headers: JSON_HEADERS,
    });
    await call((q, s) => handleCopyrightClaimCreate(q, s, deps(c2)), {
      body: claimBody(),
      headers: forged,
    });
    expect(c1.rpc.mock.calls[0]![1].p_ip).toBe(c2.rpc.mock.calls[0]![1].p_ip);
  });

  it("solo POST con application/json", async () => {
    const client = fakeClient(received);
    const get = await call((q, s) => handleCopyrightClaimCreate(q, s, deps(client)), {
      method: "GET",
      headers: JSON_HEADERS,
    });
    expect(get.status).toBe(405);
    expect(get.headers.Allow).toBe("POST");
    for (const type of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "",
    ]) {
      const reply = await call((q, s) => handleCopyrightClaimCreate(q, s, deps(client)), {
        body: claimBody(),
        headers: { ...JSON_HEADERS, "content-type": type },
      });
      expect(reply.status).toBe(415);
    }
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["cuerpo ausente", undefined],
    ["cuerpo no objeto", "[]"],
    ["JSON roto", "{no es json"],
    ["lista", []],
    ["clave desconocida", claimBody({ isAdmin: true })],
    ["intento de fijar un estado", claimBody({ status: "upheld" })],
    ["relación inválida", claimBody({ relationship: "friend" })],
    ["declaraciones sin aceptar", claimBody({ statementsAccepted: false })],
    ["enlace javascript:", claimBody({ evidenceUrls: ["javascript:alert(1)"] })],
    [
      "seis enlaces",
      claimBody({
        evidenceUrls: Array.from({ length: 6 }, (_, i) => `https://e.example/${i}`),
      }),
    ],
    ["correo inválido", claimBody({ claimantEmail: "ana@" })],
    ["postId manipulado", claimBody({ postId: "0f000000-0000-4000-8000-0000000009ff" })],
    [
      "postId sin enlace que lo respalde",
      claimBody({ postUrl: "https://x.test/@alguien" }),
    ],
    ["versión de declaraciones falsa", claimBody({ statementVersion: "v9" })],
    [
      "cuerpo gigante",
      JSON.stringify({ ...claimBody(), workDescription: "x".repeat(40_000) }),
    ],
  ])("rechaza con 400 y sin llamar a la RPC: %s", async (_label, body) => {
    const client = fakeClient(received);
    const reply = await call((q, s) => handleCopyrightClaimCreate(q, s, deps(client)), {
      body,
      headers: JSON_HEADERS,
    });
    expect(reply.status).toBe(400);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("el señuelo anti-bots responde como si fuera bien, pero no crea nada ni llama a la base de datos", async () => {
    const client = fakeClient(received);
    const reply = await call((q, s) => handleCopyrightClaimCreate(q, s, deps(client)), {
      body: claimBody({ website: "http://spam.example" }),
      headers: JSON_HEADERS,
    });
    expect(reply.status).toBe(201);
    expect(reply.body).toEqual({ status: "received" });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("sin configuración responde 503 genérico", async () => {
    const reply = await call((q, s) => handleCopyrightClaimCreate(q, s, deps(null)), {
      body: claimBody(),
      headers: JSON_HEADERS,
    });
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: "Error interno" });
  });

  it("límite superado: 429 con Retry-After acotado", async () => {
    const reply = await call(
      (q, s) =>
        handleCopyrightClaimCreate(
          q,
          s,
          deps(
            fakeClient({
              data: { status: "rate_limited", retryAfterSeconds: 1234 },
              error: null,
            }),
          ),
        ),
      { body: claimBody(), headers: JSON_HEADERS },
    );
    expect(reply.status).toBe(429);
    expect(reply.body).toEqual({ status: "rate_limited", retryAfterSeconds: 1234 });
    expect(reply.headers["Retry-After"]).toBe("1234");
    const absurd = await call(
      (q, s) =>
        handleCopyrightClaimCreate(
          q,
          s,
          deps(
            fakeClient({
              data: { status: "rate_limited", retryAfterSeconds: 9e9 },
              error: null,
            }),
          ),
        ),
      { body: claimBody(), headers: JSON_HEADERS },
    );
    expect(absurd.headers["Retry-After"]).toBe("86400");
  });

  it("errores de la RPC: la validación es 400; cualquier otro fallo es 502 genérico sin filtrar detalle", async () => {
    const invalid = await call(
      (q, s) =>
        handleCopyrightClaimCreate(
          q,
          s,
          deps(
            fakeClient({
              data: null,
              error: { code: "P0001", message: "invalid_input" },
            }),
          ),
        ),
      { body: claimBody(), headers: JSON_HEADERS },
    );
    expect(invalid.status).toBe(400);
    for (const error of [
      { code: "XX000", message: "connection to 10.0.0.1 refused password=hunter2" },
      { code: "P0001", message: "salt_missing" },
    ]) {
      const reply = await call(
        (q, s) =>
          handleCopyrightClaimCreate(q, s, deps(fakeClient({ data: null, error }))),
        { body: claimBody(), headers: JSON_HEADERS },
      );
      expect(reply.status).toBe(502);
      expect(JSON.stringify(reply.body)).not.toMatch(/hunter2|10\.0\.0\.1|salt/);
    }
  });

  it("una respuesta inesperada o una excepción NUNCA se presenta como recibida", async () => {
    for (const data of [
      null,
      {},
      { status: "received" },
      { status: "received", reference: "x" },
      { status: "ok" },
      5,
    ]) {
      const reply = await call(
        (q, s) =>
          handleCopyrightClaimCreate(q, s, deps(fakeClient({ data, error: null }))),
        { body: claimBody(), headers: JSON_HEADERS },
      );
      expect(reply.status).toBe(502);
    }
    const throwing = fakeClient(() => {
      throw new Error("boom");
    });
    const reply = await call((q, s) => handleCopyrightClaimCreate(q, s, deps(throwing)), {
      body: claimBody(),
      headers: JSON_HEADERS,
    });
    expect(reply.status).toBe(502);
  });

  it("no registra nada (sin console.*) con los datos del reclamante", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    await call((q, s) => handleCopyrightClaimCreate(q, s, deps(fakeClient(received))), {
      body: claimBody(),
      headers: JSON_HEADERS,
    });
    await call(
      (q, s) =>
        handleCopyrightClaimCreate(
          q,
          s,
          deps(fakeClient({ data: null, error: { code: "XX", message: "x" } })),
        ),
      { body: claimBody(), headers: JSON_HEADERS },
    );
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it("defaultCopyrightDeps sin variables no entrega cliente ni secreto", () => {
    const d = defaultCopyrightDeps({} as NodeJS.ProcessEnv);
    expect(d.client()).toBeNull();
    expect(d.ipSecret()).toBeNull();
  });
});

const authed = () =>
  vi.mocked(requireCapability).mockResolvedValue({ userId: MOD } as never);
const summary = {
  id: CLAIM,
  reference: "CPY-2026-000001",
  status: "received",
  version: 1,
  claimantName: "Ana Titular",
  relationship: "owner",
  postFound: false,
  createdAt: "2026-10-12T10:00:00.000Z",
  updatedAt: "2026-10-12T10:00:00.000Z",
};

describe("autorización de moderación", () => {
  beforeEach(() => vi.mocked(requireCapability).mockReset());

  it.each([
    ["cola", handleCopyrightClaims, { method: "GET", query: {} }],
    ["detalle", handleCopyrightClaim, { method: "GET", query: { id: CLAIM } }],
    [
      "revisión",
      handleCopyrightClaimReview,
      { method: "POST", body: { id: CLAIM, action: "start_review", expectedVersion: 1 } },
    ],
  ] as const)(
    "%s: sin sesión o sin capacidad responde 401/403 y no toca la base de datos",
    async (_n, handler, init) => {
      const client = fakeClient({ data: {}, error: null });
      for (const err of [
        new AdminAuthError("No autenticado", 401),
        new AdminAuthError("No autorizado", 403),
        new AdminAuthError("No autorizado", 403, "step_up_required"),
      ]) {
        vi.mocked(requireCapability).mockRejectedValueOnce(err);
        const reply = await call((q, s) => handler(q, s, deps(client)), init);
        expect(reply.status).toBe(err.status);
      }
      vi.mocked(requireCapability).mockRejectedValueOnce(new Error("db down"));
      const reply = await call((q, s) => handler(q, s, deps(client)), init);
      expect(reply.status).toBe(500);
      expect(reply.body).toEqual({ error: "Error interno" });
      expect(client.rpc).not.toHaveBeenCalled();
      expect(requireCapability).toHaveBeenCalledWith(expect.anything(), "moderation");
    },
  );
});

describe("cola", () => {
  beforeEach(() => {
    vi.mocked(requireCapability).mockReset();
    authed();
  });

  it("usa la identidad VERIFICADA (nunca un actor del cliente) y devuelve las reclamaciones con su cursor", async () => {
    const client = fakeClient({
      data: {
        items: [summary],
        next: { createdAt: "2026-10-12T10:00:00.5+00:00", id: CLAIM },
      },
      error: null,
    });
    const reply = await call((q, s) => handleCopyrightClaims(q, s, deps(client)), {
      method: "GET",
      query: { scope: "closed", actor: "0f000000-0000-4000-8000-0000000000ff" },
    });
    expect(reply.status).toBe(200);
    const body = reply.body as { claims: unknown[]; nextCursor: string };
    expect(body.claims).toEqual([summary]);
    expect(body.nextCursor).toBe(
      encodeClaimCursor({ createdAt: "2026-10-12T10:00:00.5+00:00", id: CLAIM }),
    );
    expect(client.rpc).toHaveBeenCalledWith("copyright_claims_read", {
      p_actor_user_id: MOD,
      p_scope: "closed",
      p_before_created: null,
      p_before_id: null,
      p_claim_id: null,
    });
  });

  it("reenvía un cursor válido a la RPC y rechaza ámbito o cursor inválidos con 400", async () => {
    const client = fakeClient({ data: { items: [], next: null }, error: null });
    const cursor = encodeClaimCursor({
      createdAt: "2026-10-12T10:00:00.000Z",
      id: CLAIM,
    });
    const ok = await call((q, s) => handleCopyrightClaims(q, s, deps(client)), {
      method: "GET",
      query: { cursor },
    });
    expect(ok.status).toBe(200);
    expect(client.rpc.mock.calls[0]![1]).toMatchObject({
      p_scope: "open",
      p_before_created: "2026-10-12T10:00:00.000Z",
      p_before_id: CLAIM,
    });
    client.rpc.mockClear();
    for (const query of [
      { scope: "all" },
      { scope: ["open", "closed"] },
      { cursor: "***" },
      { cursor: ["a", "b"] },
    ]) {
      const reply = await call((q, s) => handleCopyrightClaims(q, s, deps(client)), {
        method: "GET",
        query,
      });
      expect(reply.status).toBe(400);
    }
    expect(client.rpc).not.toHaveBeenCalled();
    expect(
      (
        await call((q, s) => handleCopyrightClaims(q, s, deps(client)), {
          method: "POST",
        })
      ).status,
    ).toBe(405);
  });

  it("una proyección corrupta o excesiva de la RPC es 500 genérico, nunca se reenvía tal cual", async () => {
    for (const data of [
      { items: [{ ...summary, status: "upheld" }], next: null },
      { items: Array(26).fill(summary), next: null },
      { items: "x" },
      null,
    ]) {
      const reply = await call(
        (q, s) => handleCopyrightClaims(q, s, deps(fakeClient({ data, error: null }))),
        { method: "GET", query: {} },
      );
      expect(reply.status).toBe(500);
      expect(reply.body).toEqual({ error: "Error interno" });
    }
  });

  it("errores de negocio de la RPC se traducen sin filtrar el texto de la base de datos", async () => {
    const forbidden = await call(
      (q, s) =>
        handleCopyrightClaims(
          q,
          s,
          deps(
            fakeClient({
              data: null,
              error: { code: "P0001", message: "actor_not_moderator" },
            }),
          ),
        ),
      { method: "GET", query: {} },
    );
    expect(forbidden.status).toBe(403);
    const leak = await call(
      (q, s) =>
        handleCopyrightClaims(
          q,
          s,
          deps(
            fakeClient({
              data: null,
              error: { code: "XX000", message: "relation copyright_claims password" },
            }),
          ),
        ),
      { method: "GET", query: {} },
    );
    expect(leak.status).toBe(500);
    expect(JSON.stringify(leak.body)).not.toMatch(/relation|password/);
  });
});

describe("detalle", () => {
  beforeEach(() => {
    vi.mocked(requireCapability).mockReset();
    authed();
  });
  const detail = {
    ...summary,
    claimantEmail: "ana@example.com",
    organization: null,
    workDescription: "Obra original",
    infringementDescription: "Copia mi obra",
    evidenceUrls: ["https://example.com/obra"],
    claimedPostUrl: "https://upmina.test/community/x",
    postId: null,
    postTextSnapshot: null,
    postMediaCount: null,
    currentPostStatus: null,
    statementVersion: "v1",
    signature: "Ana Titular",
    events: [],
  };

  it("devuelve el detalle de una reclamación por id", async () => {
    const client = fakeClient({ data: { item: detail }, error: null });
    const reply = await call((q, s) => handleCopyrightClaim(q, s, deps(client)), {
      method: "GET",
      query: { id: CLAIM },
    });
    expect(reply.status).toBe(200);
    expect((reply.body as { claim: { reference: string } }).claim.reference).toBe(
      "CPY-2026-000001",
    );
    expect(client.rpc.mock.calls[0]![1]).toMatchObject({
      p_actor_user_id: MOD,
      p_claim_id: CLAIM,
    });
  });

  it("id inválido o repetido es 400, inexistente es 404, y los datos corruptos son 500", async () => {
    const client = fakeClient({ data: { item: detail }, error: null });
    for (const query of [{}, { id: "x" }, { id: [CLAIM, CLAIM] }]) {
      expect(
        (
          await call((q, s) => handleCopyrightClaim(q, s, deps(client)), {
            method: "GET",
            query,
          })
        ).status,
      ).toBe(400);
    }
    expect(client.rpc).not.toHaveBeenCalled();
    const notFound = await call(
      (q, s) =>
        handleCopyrightClaim(
          q,
          s,
          deps(
            fakeClient({
              data: null,
              error: { code: "P0001", message: "claim_not_found" },
            }),
          ),
        ),
      { method: "GET", query: { id: CLAIM } },
    );
    expect(notFound.status).toBe(404);
    const corrupt = await call(
      (q, s) =>
        handleCopyrightClaim(
          q,
          s,
          deps(
            fakeClient({ data: { item: { ...detail, evidenceUrls: "x" } }, error: null }),
          ),
        ),
      { method: "GET", query: { id: CLAIM } },
    );
    expect(corrupt.status).toBe(500);
  });
});

describe("revisión", () => {
  beforeEach(() => {
    vi.mocked(requireCapability).mockReset();
    authed();
  });
  const result = {
    data: {
      id: CLAIM,
      reference: "CPY-2026-000001",
      status: "in_review",
      version: 2,
      updatedAt: "2026-10-12T10:05:00.000Z",
    },
    error: null,
  };

  it("llama a la RPC con el actor verificado, la versión esperada y la nota recortada", async () => {
    const client = fakeClient(result);
    const reply = await call((q, s) => handleCopyrightClaimReview(q, s, deps(client)), {
      body: { id: CLAIM, action: "start_review", expectedVersion: 1 },
    });
    expect(reply.status).toBe(200);
    expect((reply.body as { claim: { status: string } }).claim.status).toBe("in_review");
    expect(client.rpc).toHaveBeenCalledWith("copyright_claim_review", {
      p_actor_user_id: MOD,
      p_claim_id: CLAIM,
      p_action: "start_review",
      p_expected_version: 1,
      p_note: null,
    });
    await call((q, s) => handleCopyrightClaimReview(q, s, deps(client)), {
      body: {
        id: CLAIM,
        action: "dismiss",
        expectedVersion: 2,
        note: "  sin fundamento  ",
      },
    });
    expect(client.rpc.mock.calls[1]![1]).toMatchObject({ p_note: "sin fundamento" });
  });

  it.each([
    [
      "actor enviado por el cliente",
      { id: CLAIM, action: "start_review", expectedVersion: 1, actorUserId: MOD },
    ],
    [
      "acción que retiraría la publicación",
      { id: CLAIM, action: "remove_post", expectedVersion: 1, note: "x" },
    ],
    [
      "acción de la fase 2B",
      { id: CLAIM, action: "uphold", expectedVersion: 1, note: "x" },
    ],
    ["id inválido", { id: "x", action: "start_review", expectedVersion: 1 }],
    ["versión 0", { id: CLAIM, action: "start_review", expectedVersion: 0 }],
    ["versión decimal", { id: CLAIM, action: "start_review", expectedVersion: 1.5 }],
    ["versión como texto", { id: CLAIM, action: "start_review", expectedVersion: "1" }],
    ["descartar sin nota", { id: CLAIM, action: "dismiss", expectedVersion: 1 }],
    [
      "pedir información con nota en blanco",
      { id: CLAIM, action: "request_info", expectedVersion: 1, note: "   " },
    ],
    [
      "nota con caracteres de control",
      { id: CLAIM, action: "add_note", expectedVersion: 1, note: "a\u0007b" },
    ],
    [
      "nota de más de 1000 caracteres",
      { id: CLAIM, action: "add_note", expectedVersion: 1, note: "x".repeat(1001) },
    ],
    [
      "nota que no es texto",
      { id: CLAIM, action: "add_note", expectedVersion: 1, note: 5 },
    ],
  ])("rechaza con 400 y sin llamar a la RPC: %s", async (_label, body) => {
    const client = fakeClient(result);
    const reply = await call((q, s) => handleCopyrightClaimReview(q, s, deps(client)), {
      body,
    });
    expect(reply.status).toBe(400);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["actor_not_moderator", 403],
    ["claim_not_found", 404],
    ["version_conflict", 409],
    ["invalid_transition", 409],
    ["note_required", 400],
    ["invalid_argument", 400],
  ])("traduce el error de negocio %s a %i", async (code, status) => {
    const reply = await call(
      (q, s) =>
        handleCopyrightClaimReview(
          q,
          s,
          deps(fakeClient({ data: null, error: { code: "P0001", message: code } })),
        ),
      { body: { id: CLAIM, action: "start_review", expectedVersion: 1 } },
    );
    expect(reply.status).toBe(status);
    expect(reply.body).toMatchObject({ code });
  });

  it("un error de base de datos desconocido es 500 genérico y un resultado corrupto no se reenvía", async () => {
    const bad = await call(
      (q, s) =>
        handleCopyrightClaimReview(
          q,
          s,
          deps(
            fakeClient({
              data: null,
              error: { code: "XX000", message: "deadlock detected on copyright_claims" },
            }),
          ),
        ),
      { body: { id: CLAIM, action: "start_review", expectedVersion: 1 } },
    );
    expect(bad.status).toBe(500);
    expect(JSON.stringify(bad.body)).not.toMatch(/deadlock|copyright_claims/);
    const corrupt = await call(
      (q, s) =>
        handleCopyrightClaimReview(
          q,
          s,
          deps(fakeClient({ data: { status: "removed" }, error: null })),
        ),
      { body: { id: CLAIM, action: "start_review", expectedVersion: 1 } },
    );
    expect(corrupt.status).toBe(500);
  });
});
