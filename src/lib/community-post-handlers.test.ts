import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Handlers HTTP de publicaciones de Comunidad (Fase 9J-1C): se ejercitan los handlers REALES y
// requireAuthenticated REAL (verificación de JWT); el cliente de Supabase es un falso que expone
// rpc() y la consulta .from("community_posts") que list-own necesita. Las reglas de negocio de
// las RPC (atomicidad, propiedad, límite de 10 media, invariante texto-o-media, concurrencia
// optimista) NO se reimplementan aquí: ya se verificaron contra Postgres real en Upmina Testing
// (ver el informe del checkpoint 9J-1C). Este archivo fija el contrato HTTP: autorización (SIN
// admin_roles, SIN MFA — a diferencia de cosplay-editor-handlers.test.ts), forma del body, mapeo
// de errores de RPC, y el wiring de limpieza de medios tras desadjuntar/borrar (mismo mock que
// cosplay-editor-handlers.test.ts: attemptMediaAssetCleanup nunca se reimplementa).

const USER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_USER_ID = "44444444-4444-4444-8444-444444444444";
const POST_ID = "24655b41-1bc7-487c-834e-d1715a596e9e";
const ASSET_ID = "00000000-0000-4000-8000-000000000001";
const MEDIA_ID = "b94ec8fc-5fd3-4cdd-a961-e9dfea366b4e";

const TOKENS: Record<string, { sub: string; aal: string }> = {
  "jwt-user": { sub: USER_ID, aal: "aal1" },
  "jwt-other-user": { sub: OTHER_USER_ID, aal: "aal1" },
};

const fake = vi.hoisted(() => ({
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  rpcResult: undefined as { data: unknown; error: unknown } | undefined,
  ownListResult: { data: [] as unknown[], error: null as unknown },
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
      if (table === "community_posts") {
        const builder: Record<string, unknown> = {
          eq() {
            return builder;
          },
          order() {
            return Promise.resolve(fake.ownListResult);
          },
        };
        return { select: () => builder };
      }
      throw new Error(`tabla inesperada: ${table}`);
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

const cleanupMock = vi.fn();
vi.mock("./cosplay-media-lifecycle.js", () => ({
  attemptMediaAssetCleanup: (...args: unknown[]) => cleanupMock(...args),
}));

const {
  handleCommunityPostSave,
  handleCommunityPostReorderMedia,
  handleCommunityPostDetachMedia,
  handleCommunityPostDelete,
  handleCommunityPostListOwn,
} = await import("./community-post-handlers");

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
  fake.ownListResult = { data: [], error: null };
  cleanupMock.mockReset();
  cleanupMock.mockResolvedValue({ assetId: ASSET_ID, cleaned: true });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// AUTH: solo requireAuthenticated — SIN admin_roles, SIN MFA. Gestionar el propio contenido de
// Comunidad nunca fue una operación privilegiada (a diferencia de cosplay-editor-handlers.ts).

describe("autorización — solo requireAuthenticated, nunca cosplay_admin ni MFA", () => {
  it.each([
    ["handleCommunityPostSave", () => handleCommunityPostSave, "POST"],
    ["handleCommunityPostReorderMedia", () => handleCommunityPostReorderMedia, "POST"],
    ["handleCommunityPostDetachMedia", () => handleCommunityPostDetachMedia, "POST"],
    ["handleCommunityPostDelete", () => handleCommunityPostDelete, "POST"],
    ["handleCommunityPostListOwn", () => handleCommunityPostListOwn, "GET"],
  ])("%s: sin Authorization → 401", async (_name, getHandler, method) => {
    const state = await call(
      getHandler(),
      req({
        method,
        token: null,
        body: { postId: POST_ID, expectedVersion: 1, media: [] },
      }),
    );
    expect(state.status).toBe(401);
  });

  it.each([
    ["handleCommunityPostSave", () => handleCommunityPostSave, "POST"],
    ["handleCommunityPostListOwn", () => handleCommunityPostListOwn, "GET"],
  ])("%s: JWT inválido → 401", async (_name, getHandler, method) => {
    const state = await call(
      getHandler(),
      req({ method, token: "jwt-basura", body: {} }),
    );
    expect(state.status).toBe(401);
  });

  it("un usuario normal (sin fila en admin_roles, nunca consultada) SÍ puede guardar su propio post", async () => {
    fake.rpcResult = ok({
      post: {
        id: POST_ID,
        author_user_id: USER_ID,
        text: "hola",
        status: "published",
        version: 1,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      media: [],
    });
    const state = await call(
      handleCommunityPostSave,
      req({ body: { postId: null, expectedVersion: null, text: "hola", media: [] } }),
    );
    expect(state.status).toBe(200);
    expect(fake.rpcCalls[0].args.p_actor_user_id).toBe(USER_ID);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// SAVE: forma del body, validación de texto, mapeo de errores RPC.

describe("handleCommunityPostSave", () => {
  it("método distinto de POST: 405 con Allow: POST", async () => {
    const state = await call(handleCommunityPostSave, req({ method: "GET" }));
    expect(state.status).toBe(405);
    expect(state.headers.Allow).toBe("POST");
  });

  it("body sin media (falta el array): 400, sin llamar a la RPC", async () => {
    const state = await call(
      handleCommunityPostSave,
      req({ body: { postId: null, text: "hola" } }),
    );
    expect(state.status).toBe(400);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("más de 10 media en el body: 400, sin llamar a la RPC (defensa temprana antes de la RPC)", async () => {
    const media = Array.from({ length: 11 }, (_, i) => ({
      assetId: ASSET_ID,
      position: i,
    }));
    const state = await call(
      handleCommunityPostSave,
      req({ body: { postId: null, text: null, media } }),
    );
    expect(state.status).toBe(400);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("postId presente sin expectedVersion numérico: 400", async () => {
    const state = await call(
      handleCommunityPostSave,
      req({ body: { postId: POST_ID, text: "hola", media: [] } }),
    );
    expect(state.status).toBe(400);
  });

  it("texto con más de 2000 code points: 422 invalid_text, sin llamar a la RPC", async () => {
    const state = await call(
      handleCommunityPostSave,
      req({ body: { postId: null, text: "a".repeat(2001), media: [] } }),
    );
    expect(state.status).toBe(422);
    expect(state.body).toMatchObject({ code: "invalid_text" });
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("texto solo-espacios se normaliza a NULL antes de llamar a la RPC", async () => {
    fake.rpcResult = ok({
      post: {
        id: POST_ID,
        author_user_id: USER_ID,
        text: null,
        status: "published",
        version: 1,
        created_at: "x",
        updated_at: "x",
      },
      media: [{ id: MEDIA_ID, asset_id: ASSET_ID, position: 0 }],
    });
    await call(
      handleCommunityPostSave,
      req({
        body: { postId: null, text: "   ", media: [{ assetId: ASSET_ID, position: 0 }] },
      }),
    );
    expect(fake.rpcCalls[0].args.p_text).toBeNull();
  });

  it.each([
    ["no_profile", 422, "profile_required"],
    ["not_owner", 403, "forbidden"],
    ["post_not_found", 404, "not_found"],
    ["version_conflict", 409, "community_version_conflict"],
    ["too_many_media", 400, "too_many_media"],
    ["duplicate_asset_id", 400, "duplicate_asset_id"],
    ["invalid_positions", 400, "invalid_positions"],
    ["media_missing_existing", 400, "media_missing_existing"],
    ["invalid_asset", 400, "invalid_asset"],
    ["foreign_asset", 403, "foreign_asset"],
    ["asset_not_ready", 400, "asset_not_ready"],
    ["asset_already_attached", 409, "asset_already_attached"],
    ["empty_post", 422, "empty_post"],
  ])(
    "RPC lanza %s → %i con code %s (nunca el mensaje crudo de Postgres)",
    async (rpcMsg, status, code) => {
      fake.rpcResult = rpcError(rpcMsg);
      const state = await call(
        handleCommunityPostSave,
        req({ body: { postId: null, text: "hola", media: [] } }),
      );
      expect(state.status).toBe(status);
      expect(state.body).toMatchObject({ code });
    },
  );

  it("error de Postgres no reconocido: 500 genérico, nunca expone el mensaje crudo", async () => {
    fake.rpcResult = { data: null, error: { code: "XX000", message: "boom interno" } };
    const state = await call(
      handleCommunityPostSave,
      req({ body: { postId: null, text: "hola", media: [] } }),
    );
    expect(state.status).toBe(500);
    expect(JSON.stringify(state.body)).not.toContain("boom interno");
  });

  it("éxito: 200, mapea post/media a camelCase neutral, Cache-Control no-store", async () => {
    fake.rpcResult = ok({
      post: {
        id: POST_ID,
        author_user_id: USER_ID,
        text: "hola",
        status: "published",
        version: 2,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
        like_count: 0,
      },
      media: [{ id: MEDIA_ID, asset_id: ASSET_ID, position: 0 }],
    });
    const { res, state } = mockRes();
    await handleCommunityPostSave(
      req({ body: { postId: POST_ID, expectedVersion: 1, text: "hola", media: [] } }),
      res,
    );
    expect(state.status).toBe(200);
    expect(state.body).toEqual({
      post: {
        id: POST_ID,
        text: "hola",
        status: "published",
        version: 2,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        likeCount: 0,
      },
      media: [{ id: MEDIA_ID, assetId: ASSET_ID, position: 0 }],
    });
    expect(state.headers["Cache-Control"]).toBe("no-store");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────

describe("handleCommunityPostReorderMedia", () => {
  it("positions con más de 10 elementos: 400, sin llamar a la RPC", async () => {
    const positions = Array.from({ length: 11 }, (_, i) => ({
      mediaId: MEDIA_ID,
      position: i,
    }));
    const state = await call(
      handleCommunityPostReorderMedia,
      req({ body: { postId: POST_ID, expectedVersion: 1, positions } }),
    );
    expect(state.status).toBe(400);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("version_conflict de la RPC → 409 community_version_conflict", async () => {
    fake.rpcResult = rpcError("version_conflict");
    const state = await call(
      handleCommunityPostReorderMedia,
      req({
        body: {
          postId: POST_ID,
          expectedVersion: 1,
          positions: [{ mediaId: MEDIA_ID, position: 0 }],
        },
      }),
    );
    expect(state.status).toBe(409);
    expect(state.body).toMatchObject({ code: "community_version_conflict" });
  });

  it("éxito: 200 con la nueva version, sin tocar R2 (reordenar no cambia media)", async () => {
    fake.rpcResult = ok({ version: 2 });
    const state = await call(
      handleCommunityPostReorderMedia,
      req({
        body: {
          postId: POST_ID,
          expectedVersion: 1,
          positions: [{ mediaId: MEDIA_ID, position: 0 }],
        },
      }),
    );
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ version: 2 });
    expect(cleanupMock).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────

describe("handleCommunityPostDetachMedia", () => {
  it("not_owner de la RPC → 403 forbidden (nunca deja que otro usuario desadjunte)", async () => {
    fake.rpcResult = rpcError("not_owner");
    const state = await call(
      handleCommunityPostDetachMedia,
      req({
        token: "jwt-other-user",
        body: { postId: POST_ID, expectedVersion: 1, mediaId: MEDIA_ID },
      }),
    );
    expect(state.status).toBe(403);
    expect(state.body).toMatchObject({ code: "forbidden" });
    expect(cleanupMock).not.toHaveBeenCalled();
  });

  it("empty_post de la RPC → 422 (rechaza dejar la publicación vacía)", async () => {
    fake.rpcResult = rpcError("empty_post");
    const state = await call(
      handleCommunityPostDetachMedia,
      req({ body: { postId: POST_ID, expectedVersion: 1, mediaId: MEDIA_ID } }),
    );
    expect(state.status).toBe(422);
    expect(state.body).toMatchObject({ code: "empty_post" });
  });

  it("éxito: llama a attemptMediaAssetCleanup con el assetId devuelto por la RPC (limpieza REAL de R2, misma primitiva que Cosplay)", async () => {
    fake.rpcResult = ok({ asset_id: ASSET_ID, version: 2 });
    const state = await call(
      handleCommunityPostDetachMedia,
      req({ body: { postId: POST_ID, expectedVersion: 1, mediaId: MEDIA_ID } }),
    );
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ version: 2, assetId: ASSET_ID, cleaned: true });
    expect(cleanupMock).toHaveBeenCalledWith(ASSET_ID);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────

describe("handleCommunityPostDelete", () => {
  it("not_owner de la RPC → 403, sin ejecutar ninguna limpieza", async () => {
    fake.rpcResult = rpcError("not_owner");
    const state = await call(
      handleCommunityPostDelete,
      req({ token: "jwt-other-user", body: { postId: POST_ID, expectedVersion: 1 } }),
    );
    expect(state.status).toBe(403);
    expect(cleanupMock).not.toHaveBeenCalled();
  });

  it("éxito: limpia cada asset borrado (borrado DURO, no moderación) y reporta allCleaned", async () => {
    fake.rpcResult = ok({
      deleted_asset_ids: [ASSET_ID, "00000000-0000-4000-8000-000000000002"],
    });
    cleanupMock
      .mockResolvedValueOnce({ assetId: ASSET_ID, cleaned: true })
      .mockResolvedValueOnce({
        assetId: "00000000-0000-4000-8000-000000000002",
        cleaned: false,
      });
    const state = await call(
      handleCommunityPostDelete,
      req({ body: { postId: POST_ID, expectedVersion: 1 } }),
    );
    expect(state.status).toBe(200);
    expect(cleanupMock).toHaveBeenCalledTimes(2);
    expect((state.body as { allCleaned: boolean }).allCleaned).toBe(false);
  });

  it("sin media adjunta: deleted_asset_ids vacío, ninguna llamada de limpieza, allCleaned true", async () => {
    fake.rpcResult = ok({ deleted_asset_ids: [] });
    const state = await call(
      handleCommunityPostDelete,
      req({ body: { postId: POST_ID, expectedVersion: 1 } }),
    );
    expect(state.status).toBe(200);
    expect(cleanupMock).not.toHaveBeenCalled();
    expect((state.body as { allCleaned: boolean }).allCleaned).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────

describe("handleCommunityPostListOwn", () => {
  it("método distinto de GET: 405 con Allow: GET", async () => {
    const state = await call(handleCommunityPostListOwn, req({ method: "POST" }));
    expect(state.status).toBe(405);
    expect(state.headers.Allow).toBe("GET");
  });

  it("lista solo las publicaciones propias (author_user_id sale del JWT, nunca de un query param)", async () => {
    vi.stubEnv("R2_DEV_ACCESS_KEY_ID", "test-access-key-id");
    vi.stubEnv("R2_DEV_SECRET_ACCESS_KEY", "test-secret-access-key");
    vi.stubEnv("R2_DEV_ENDPOINT", "https://test-account.r2.cloudflarestorage.com");
    vi.stubEnv("R2_DEV_PRIVATE_BUCKET", "upmina-media-dev-private");
    vi.stubEnv("R2_DEV_PUBLIC_BUCKET", "upmina-media-dev-public");
    vi.stubEnv("R2_DEV_PUBLIC_BASE_URL", "https://pub-test.r2.dev");
    const { resetR2DevConfigCache } = await import("./r2-client");
    resetR2DevConfigCache();

    fake.ownListResult = {
      data: [
        {
          id: POST_ID,
          text: "hola",
          status: "published",
          version: 1,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          like_count: 3,
          community_post_media: [
            {
              id: MEDIA_ID,
              asset_id: ASSET_ID,
              position: 0,
              media_assets: {
                id: ASSET_ID,
                status: "ready",
                width: 800,
                height: 600,
                storage_key: "community/x/w960.webp",
              },
            },
          ],
        },
      ],
      error: null,
    };
    const state = await call(handleCommunityPostListOwn, req({ method: "GET" }));
    expect(state.status).toBe(200);
    const body = state.body as { items: unknown[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: POST_ID,
      text: "hola",
      likeCount: 3,
      media: [{ id: MEDIA_ID, assetId: ASSET_ID, position: 0, assetStatus: "ready" }],
    });
  });

  it("media todavía no ready: url es null (no inventa una URL de un asset no publicable)", async () => {
    fake.ownListResult = {
      data: [
        {
          id: POST_ID,
          text: null,
          status: "published",
          version: 1,
          created_at: "x",
          updated_at: "x",
          community_post_media: [
            {
              id: MEDIA_ID,
              asset_id: ASSET_ID,
              position: 0,
              media_assets: {
                id: ASSET_ID,
                status: "processing",
                width: null,
                height: null,
                storage_key: null,
              },
            },
          ],
        },
      ],
      error: null,
    };
    const state = await call(handleCommunityPostListOwn, req({ method: "GET" }));
    const body = state.body as { items: { media: { url: string | null }[] }[] };
    expect(body.items[0].media[0].url).toBeNull();
  });

  it("error de lectura: 500 genérico", async () => {
    fake.ownListResult = {
      data: null as unknown as unknown[],
      error: { message: "boom" },
    };
    const state = await call(handleCommunityPostListOwn, req({ method: "GET" }));
    expect(state.status).toBe(500);
  });
});
