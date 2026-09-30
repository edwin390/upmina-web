import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Handlers HTTP de likes de Comunidad (Fase 9J-2C): se ejercitan los handlers REALES y
// requireAuthenticated REAL (verificación de JWT); el cliente de Supabase es un falso que expone
// rpc() (community_post_set_like) y .from("community_post_likes") (liked-by-me). Las garantías de
// unicidad/atomicidad de la propia RPC (PK compuesta, lock de fila, idempotencia real) ya se
// verificaron contra Postgres real en Upmina Testing (ver el informe del checkpoint 9J-2C); este
// archivo fija el contrato HTTP: autorización (SIN admin_roles, SIN MFA, SIN perfil de Comunidad
// requerido), forma del body/query, mapeo de errores de RPC, y que el actor SIEMPRE sale del JWT
// verificado, nunca del body.

const USER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_USER_ID = "44444444-4444-4444-8444-444444444444";
const POST_ID = "24655b41-1bc7-487c-834e-d1715a596e9e";
const OTHER_POST_ID = "5b8e6b3a-2e3e-4a8b-9a3a-9a3a9a3a9a3a";

const TOKENS: Record<string, { sub: string; aal: string }> = {
  "jwt-user": { sub: USER_ID, aal: "aal1" },
  "jwt-other-user": { sub: OTHER_USER_ID, aal: "aal1" },
};

const fake = vi.hoisted(() => ({
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  rpcResult: undefined as { data: unknown; error: unknown } | undefined,
  likedByMeRows: [] as { post_id: string; user_id: string }[],
  likedByMeFilters: [] as { column: string; value: unknown }[][],
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      async getClaims(jwt: string) {
        const claims = TOKENS[jwt];
        return claims
          ? { data: { claims }, error: null }
          : { data: null, error: { message: "jwt inválido" } };
      },
    },
    from(table: string) {
      if (table !== "community_post_likes") throw new Error(`tabla inesperada: ${table}`);
      const filters: { column: string; value: unknown }[] = [];
      const builder = {
        eq(column: string, value: unknown) {
          filters.push({ column, value });
          return builder;
        },
        in(column: string, values: unknown[]) {
          filters.push({ column, value: values });
          return builder;
        },
        then<R1 = unknown, R2 = never>(
          onfulfilled?:
            ((value: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
          onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
        ): PromiseLike<R1 | R2> {
          fake.likedByMeFilters.push(filters);
          const userFilter = filters.find((f) => f.column === "user_id");
          const postFilter = filters.find((f) => f.column === "post_id");
          const postIds = (postFilter?.value as string[] | undefined) ?? [];
          const rows = fake.likedByMeRows.filter(
            (row) => row.user_id === userFilter?.value && postIds.includes(row.post_id),
          );
          return Promise.resolve({ data: rows, error: null }).then(
            onfulfilled,
            onrejected,
          );
        },
      };
      return { select: () => builder };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      fake.rpcCalls.push({ name, args });
      return (
        fake.rpcResult ?? {
          data: null,
          error: { code: "XX000", message: "sin resultado" },
        }
      );
    },
  }),
}));

const { handleCommunityPostSetLike, handleCommunityPostLikedByMe } =
  await import("./community-like-handlers");

function mockRes() {
  const state: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const res = {
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return res;
    },
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  };
  return { res: res as unknown as VercelResponse, state };
}

function req(opts: {
  method?: string;
  token?: string | null;
  body?: unknown;
  query?: Record<string, string>;
}) {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? "jwt-user"}`;
  return {
    method: opts.method ?? "POST",
    headers,
    query: opts.query ?? {},
    body: opts.body,
  } as unknown as VercelRequest;
}

async function call(
  handler: (req: VercelRequest, res: VercelResponse) => Promise<VercelResponse>,
  request: VercelRequest,
) {
  const { res, state } = mockRes();
  await handler(request, res);
  return state;
}

const ok = (data: unknown) => ({ data, error: null });
const rpcError = (message: string) => ({ data: null, error: { code: "P0001", message } });

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-service-role-ficticia");
  fake.rpcCalls = [];
  fake.rpcResult = undefined;
  fake.likedByMeRows = [];
  fake.likedByMeFilters = [];
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// POST /api/admin/community-post-set-like

describe("handleCommunityPostSetLike — autorización", () => {
  it("método distinto de POST → 405 con Allow: POST", async () => {
    const state = await call(handleCommunityPostSetLike, req({ method: "GET" }));
    expect(state.status).toBe(405);
    expect(state.headers.Allow).toBe("POST");
  });

  it("visitante (sin Authorization) no puede mutar: 401, sin llamar a la RPC", async () => {
    const state = await call(
      handleCommunityPostSetLike,
      req({ token: null, body: { postId: POST_ID, liked: true } }),
    );
    expect(state.status).toBe(401);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("token inválido → 401, sin llamar a la RPC", async () => {
    const state = await call(
      handleCommunityPostSetLike,
      req({ token: "jwt-invalido", body: { postId: POST_ID, liked: true } }),
    );
    expect(state.status).toBe(401);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("no exige perfil de Comunidad ni rol ni MFA: solo requireAuthenticated", async () => {
    fake.rpcResult = ok({ postId: POST_ID, likeCount: 1, likedByMe: true });
    const state = await call(
      handleCommunityPostSetLike,
      req({ body: { postId: POST_ID, liked: true } }),
    );
    expect(state.status).toBe(200);
  });
});

describe("handleCommunityPostSetLike — forma del body", () => {
  it("postId ausente o no-UUID → 400, sin llamar a la RPC", async () => {
    const state = await call(
      handleCommunityPostSetLike,
      req({ body: { postId: "no-es-un-uuid", liked: true } }),
    );
    expect(state.status).toBe(400);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("liked ausente o no-booleano → 400, sin llamar a la RPC", async () => {
    const state = await call(
      handleCommunityPostSetLike,
      req({ body: { postId: POST_ID, liked: "true" } }),
    );
    expect(state.status).toBe(400);
    expect(fake.rpcCalls).toHaveLength(0);
  });
});

describe("handleCommunityPostSetLike — identidad del actor", () => {
  it("el actor SIEMPRE sale del JWT verificado, nunca de un userId del body", async () => {
    fake.rpcResult = ok({ postId: POST_ID, likeCount: 1, likedByMe: true });
    await call(
      handleCommunityPostSetLike,
      req({
        token: "jwt-user",
        body: {
          postId: POST_ID,
          liked: true,
          userId: OTHER_USER_ID,
          actorUserId: OTHER_USER_ID,
        },
      }),
    );
    expect(fake.rpcCalls[0]?.args.p_actor_user_id).toBe(USER_ID);
    expect(fake.rpcCalls[0]?.args.p_actor_user_id).not.toBe(OTHER_USER_ID);
  });

  it("cualquier usuario autenticado puede dar like a su PROPIA publicación (sin verificación de ownership aquí)", async () => {
    fake.rpcResult = ok({ postId: POST_ID, likeCount: 1, likedByMe: true });
    const state = await call(
      handleCommunityPostSetLike,
      req({ token: "jwt-user", body: { postId: POST_ID, liked: true } }),
    );
    expect(state.status).toBe(200);
  });
});

describe("handleCommunityPostSetLike — like/unlike", () => {
  it("dar like: 200 con likeCount/likedByMe reales de la RPC", async () => {
    fake.rpcResult = ok({ postId: POST_ID, likeCount: 1, likedByMe: true });
    const state = await call(
      handleCommunityPostSetLike,
      req({ body: { postId: POST_ID, liked: true } }),
    );
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ postId: POST_ID, likeCount: 1, likedByMe: true });
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(fake.rpcCalls[0]).toEqual({
      name: "community_post_set_like",
      args: { p_actor_user_id: USER_ID, p_post_id: POST_ID, p_liked: true },
    });
  });

  it("repetir liked=true es idempotente: sigue devolviendo likeCount=1", async () => {
    fake.rpcResult = ok({ postId: POST_ID, likeCount: 1, likedByMe: true });
    const state1 = await call(
      handleCommunityPostSetLike,
      req({ body: { postId: POST_ID, liked: true } }),
    );
    const state2 = await call(
      handleCommunityPostSetLike,
      req({ body: { postId: POST_ID, liked: true } }),
    );
    expect(state1.body).toEqual(state2.body);
  });

  it("quitar like: 200 con likeCount/likedByMe reflejando el estado sin like", async () => {
    fake.rpcResult = ok({ postId: POST_ID, likeCount: 0, likedByMe: false });
    const state = await call(
      handleCommunityPostSetLike,
      req({ body: { postId: POST_ID, liked: false } }),
    );
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ postId: POST_ID, likeCount: 0, likedByMe: false });
  });

  it("repetir liked=false es idempotente: sigue devolviendo likeCount=0", async () => {
    fake.rpcResult = ok({ postId: POST_ID, likeCount: 0, likedByMe: false });
    const state1 = await call(
      handleCommunityPostSetLike,
      req({ body: { postId: POST_ID, liked: false } }),
    );
    const state2 = await call(
      handleCommunityPostSetLike,
      req({ body: { postId: POST_ID, liked: false } }),
    );
    expect(state1.body).toEqual(state2.body);
  });

  it("dos solicitudes concurrentes se resuelven ambas sin duplicar la llamada a la RPC ni romper el handler (la unicidad real la garantiza la PK compuesta en Postgres, ya verificada aparte)", async () => {
    fake.rpcResult = ok({ postId: POST_ID, likeCount: 1, likedByMe: true });
    const [state1, state2] = await Promise.all([
      call(handleCommunityPostSetLike, req({ body: { postId: POST_ID, liked: true } })),
      call(handleCommunityPostSetLike, req({ body: { postId: POST_ID, liked: true } })),
    ]);
    expect(state1.status).toBe(200);
    expect(state2.status).toBe(200);
    expect(fake.rpcCalls).toHaveLength(2);
  });
});

describe("handleCommunityPostSetLike — publicación inelegible (fail-closed)", () => {
  it("publicación inexistente → 404, nunca el mensaje crudo de Postgres", async () => {
    fake.rpcResult = rpcError("post_not_found");
    const state = await call(
      handleCommunityPostSetLike,
      req({ body: { postId: POST_ID, liked: true } }),
    );
    expect(state.status).toBe(404);
    expect(JSON.stringify(state.body)).not.toContain("post_not_found");
  });

  it("publicación hidden/borrada → el MISMO 404 que inexistente (nunca distingue el caso)", async () => {
    fake.rpcResult = rpcError("post_not_found");
    const stateHidden = await call(
      handleCommunityPostSetLike,
      req({ body: { postId: POST_ID, liked: true } }),
    );
    fake.rpcResult = rpcError("post_not_found");
    const stateMissing = await call(
      handleCommunityPostSetLike,
      req({ body: { postId: OTHER_POST_ID, liked: true } }),
    );
    expect(stateHidden.status).toBe(stateMissing.status);
    expect(stateHidden.body).toEqual(stateMissing.body);
  });

  it("error de Postgres no reconocido → 500 genérico, sin detalles", async () => {
    fake.rpcResult = { data: null, error: { code: "XX000", message: "boom interno" } };
    const state = await call(
      handleCommunityPostSetLike,
      req({ body: { postId: POST_ID, liked: true } }),
    );
    expect(state.status).toBe(500);
    expect(JSON.stringify(state.body)).not.toContain("boom interno");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// GET /api/admin/community-post-liked-by-me

describe("handleCommunityPostLikedByMe — autorización", () => {
  it("método distinto de GET → 405 con Allow: GET", async () => {
    const state = await call(handleCommunityPostLikedByMe, req({ method: "POST" }));
    expect(state.status).toBe(405);
    expect(state.headers.Allow).toBe("GET");
  });

  it("visitante (sin Authorization) no recibe estado de like de nadie: 401", async () => {
    const state = await call(
      handleCommunityPostLikedByMe,
      req({ method: "GET", token: null, query: { postIds: POST_ID } }),
    );
    expect(state.status).toBe(401);
  });
});

describe("handleCommunityPostLikedByMe — estado del visor actual", () => {
  it("publicación con like propio → aparece en likedPostIds", async () => {
    fake.likedByMeRows = [{ post_id: POST_ID, user_id: USER_ID }];
    const state = await call(
      handleCommunityPostLikedByMe,
      req({ method: "GET", query: { postIds: POST_ID } }),
    );
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ likedPostIds: [POST_ID] });
  });

  it("publicación sin like propio → no aparece", async () => {
    fake.likedByMeRows = [];
    const state = await call(
      handleCommunityPostLikedByMe,
      req({ method: "GET", query: { postIds: POST_ID } }),
    );
    expect(state.body).toEqual({ likedPostIds: [] });
  });

  it("nunca revela el like de OTRO usuario: solo se consulta con el user_id del JWT del visor", async () => {
    fake.likedByMeRows = [{ post_id: POST_ID, user_id: OTHER_USER_ID }];
    const state = await call(
      handleCommunityPostLikedByMe,
      req({ method: "GET", token: "jwt-user", query: { postIds: POST_ID } }),
    );
    expect(state.body).toEqual({ likedPostIds: [] });
  });

  it("postIds vacío o ausente → likedPostIds vacío, sin tocar la base de datos", async () => {
    const state = await call(
      handleCommunityPostLikedByMe,
      req({ method: "GET", query: {} }),
    );
    expect(state.body).toEqual({ likedPostIds: [] });
    expect(fake.likedByMeFilters).toHaveLength(0);
  });

  it("ids con formato inválido se descartan silenciosamente (nunca 500)", async () => {
    const state = await call(
      handleCommunityPostLikedByMe,
      req({ method: "GET", query: { postIds: `${POST_ID},no-es-un-uuid` } }),
    );
    expect(state.status).toBe(200);
  });

  it("Cache-Control: no-store (nunca cacheado — es estado privado del visor)", async () => {
    const state = await call(
      handleCommunityPostLikedByMe,
      req({ method: "GET", query: { postIds: POST_ID } }),
    );
    expect(state.headers["Cache-Control"]).toBe("no-store");
  });
});
