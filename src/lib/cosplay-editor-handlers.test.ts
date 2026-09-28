import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Editor ADMIN de Cosplay (Fase 9I-3, checkpoint 2): se ejercitan los handlers HTTP REALES y
// requireCapability REAL (autenticación → rol → capacidad → MFA reciente); el cliente de Supabase
// es un falso que expone rpc() y las consultas .from("admin_roles"/"cosplay_posts") que estos
// handlers necesitan. Las reglas de negocio de las RPC (atomicidad, validación de assets, límite
// de 20 fotos, requisitos de publicación, concurrencia optimista) NO se reimplementan aquí: ya se
// verificaron con Postgres real en el harness desechable (ver el informe del checkpoint). Este
// archivo fija el contrato HTTP: autorización, forma del body, mapeo de errores de RPC, y el
// wiring de limpieza de medios tras desadjuntar/borrar.

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const POST_ID = "24655b41-1bc7-487c-834e-d1715a596e9e";
const ASSET_ID = "00000000-0000-4000-8000-000000000001";
const IMAGE_ID = "b94ec8fc-5fd3-4cdd-a961-e9dfea366b4e";

const TOKENS: Record<string, { sub: string; aal: string; amr?: unknown }> = {
  "jwt-admin-aal2": {
    sub: ADMIN_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }],
  },
  "jwt-admin-aal1": { sub: ADMIN_ID, aal: "aal1" },
  "jwt-admin-aal2-stale": {
    sub: ADMIN_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - 3600 }],
  },
  "jwt-user-aal2": {
    sub: USER_ID,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }],
  },
};

const fake = vi.hoisted(() => ({
  roles: {} as Record<string, string | undefined>,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  rpcResult: undefined as { data: unknown; error: unknown } | undefined,
  slugListResult: { data: [] as { slug: string }[], error: null as unknown },
  postListResult: { data: [] as unknown[], error: null as unknown },
  postGetResult: { data: null as unknown, error: null as unknown },
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
      if (table === "admin_roles") {
        let userId = "";
        const builder = {
          eq(_c: string, v: string) {
            userId = v;
            return builder;
          },
          async maybeSingle() {
            const role = fake.roles[userId];
            return { data: role ? { role } : null, error: null };
          },
        };
        return { select: () => builder };
      }
      if (table === "cosplay_posts") {
        const builder: Record<string, unknown> = {
          neq() {
            return builder;
          },
          eq() {
            return builder;
          },
          order() {
            return Promise.resolve(fake.postListResult);
          },
          async maybeSingle() {
            return fake.postGetResult;
          },
          then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
            return Promise.resolve(fake.slugListResult).then(resolve, reject);
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
vi.mock("./cosplay-media-lifecycle", () => ({
  attemptMediaAssetCleanup: (...args: unknown[]) => cleanupMock(...args),
}));

const {
  handleCosplayPostSave,
  handleCosplayPostDelete,
  handleCosplayMediaDetach,
  handleCosplayPostReorder,
  handleCosplayPostListAdmin,
  handleCosplayPostGetAdmin,
} = await import("./cosplay-editor-handlers");

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
  if (opts.token !== null)
    headers.authorization = `Bearer ${opts.token ?? "jwt-admin-aal2"}`;
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

const validImage = () => ({
  assetId: ASSET_ID,
  position: 0,
  isCover: true,
  decorative: false,
  alt: "Kirito con espada",
});

const validSaveBody = (over: Record<string, unknown> = {}) => ({
  status: "draft",
  title: "Kirito de prueba",
  images: [validImage()],
  ...over,
});

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-service-role-ficticia");
  fake.roles = { [ADMIN_ID]: "admin", [USER_ID]: undefined };
  fake.rpcCalls = [];
  fake.rpcResult = undefined;
  fake.slugListResult = { data: [], error: null };
  fake.postListResult = { data: [], error: null };
  fake.postGetResult = { data: null, error: null };
  cleanupMock.mockReset();
  cleanupMock.mockResolvedValue({ assetId: ASSET_ID, cleaned: true });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// AUTH: capacidad antes de MFA, MFA reciente, USER/ADMIN revocado — misma matriz para las
// mutaciones (save/delete comprobadas exhaustivamente; el resto comparte la MISMA función
// authorizeCosplayAdmin, así que se confirma con un caso representativo cada una).

describe("autorización (cosplay_admin + MFA reciente) — antes de cualquier RPC", () => {
  const CASES: [string, string | null, number][] = [
    ["sin Authorization", null, 401],
    ["JWT inválido", "jwt-basura", 401],
    ["ADMIN con AAL1 (sin MFA reciente en absoluto)", "jwt-admin-aal1", 403],
    ["ADMIN con TOTP vencido (MFA no reciente)", "jwt-admin-aal2-stale", 403],
    ["USER sin rol (rechazado ANTES de mirar MFA)", "jwt-user-aal2", 403],
  ];

  it.each(CASES)("guardar: %s → %i, nunca llama a la RPC", async (_n, token, status) => {
    const state = await call(
      handleCosplayPostSave,
      req({ body: validSaveBody(), token }),
    );
    expect(state.status).toBe(status);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it.each(CASES)("borrar: %s → %i, nunca llama a la RPC", async (_n, token, status) => {
    const state = await call(
      handleCosplayPostDelete,
      req({ body: { postId: POST_ID, expectedVersion: 1 }, token }),
    );
    expect(state.status).toBe(status);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("un ADMIN con rol revocado (USER en admin_roles) es rechazado con 403 genérico, NUNCA step_up_required", async () => {
    fake.roles = {};
    const state = await call(
      handleCosplayPostSave,
      req({ body: validSaveBody(), token: "jwt-admin-aal2" }),
    );
    expect(state.status).toBe(403);
    expect((state.body as { code?: string }).code).not.toBe("step_up_required");
  });

  it("desadjuntar/reordenar/listas ADMIN también exigen cosplay_admin (401 sin token)", async () => {
    const detach = await call(
      handleCosplayMediaDetach,
      req({
        body: { postId: POST_ID, expectedVersion: 1, imageId: IMAGE_ID },
        token: null,
      }),
    );
    const reorder = await call(
      handleCosplayPostReorder,
      req({ body: { postId: POST_ID, expectedVersion: 1, positions: [] }, token: null }),
    );
    const list = await call(
      handleCosplayPostListAdmin,
      req({ method: "GET", token: null }),
    );
    const get = await call(
      handleCosplayPostGetAdmin,
      req({ method: "GET", token: null, query: { postId: POST_ID } }),
    );
    expect([detach.status, reorder.status, list.status, get.status]).toEqual([
      401, 401, 401, 401,
    ]);
    expect(fake.rpcCalls).toHaveLength(0);
  });
});

describe("métodos", () => {
  it("cosplay-post-save solo admite POST", async () => {
    const state = await call(handleCosplayPostSave, req({ method: "GET" }));
    expect(state.status).toBe(405);
    expect(state.headers.Allow).toBe("POST");
  });

  it("cosplay-post-list-admin solo admite GET", async () => {
    const state = await call(handleCosplayPostListAdmin, req({ method: "POST" }));
    expect(state.status).toBe(405);
    expect(state.headers.Allow).toBe("GET");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// CREATE / SAVE / PUBLISH

describe("POST cosplay-post-save", () => {
  it("crear un borrador con cero imágenes: la RPC recibe images: [] y postId null", async () => {
    fake.rpcResult = ok({ post: { id: POST_ID, version: 1 }, images: [] });
    const state = await call(
      handleCosplayPostSave,
      req({ body: validSaveBody({ images: [] }) }),
    );
    expect(state.status).toBe(200);
    const call1 = fake.rpcCalls[0]!;
    expect(call1.name).toBe("cosplay_admin_save_post");
    expect(call1.args.p_post_id).toBeNull();
    expect(call1.args.p_images).toEqual([]);
  });

  it("crear con varias imágenes ready: cada una se traduce a snake_case para la RPC", async () => {
    fake.rpcResult = ok({ post: { id: POST_ID, version: 1 }, images: [] });
    await call(
      handleCosplayPostSave,
      req({
        body: validSaveBody({
          images: [
            validImage(),
            {
              assetId: "00000000-0000-4000-8000-000000000002",
              position: 1,
              isCover: false,
              decorative: false,
              alt: "otra",
            },
          ],
        }),
      }),
    );
    const args = fake.rpcCalls[0]!.args.p_images as Record<string, unknown>[];
    expect(args).toHaveLength(2);
    expect(args[0]).toMatchObject({ asset_id: ASSET_ID, position: 0, is_cover: true });
  });

  it("publicar en la creación: p_status llega como 'published'", async () => {
    fake.rpcResult = ok({
      post: { id: POST_ID, version: 1, status: "published" },
      images: [],
    });
    await call(
      handleCosplayPostSave,
      req({ body: validSaveBody({ status: "published" }) }),
    );
    expect(fake.rpcCalls[0]!.args.p_status).toBe("published");
  });

  it("más de 20 fotos: rechazado ANTES de llamar a la RPC (400)", async () => {
    const images = Array.from({ length: 21 }, (_, i) => ({
      assetId: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
      position: i,
      isCover: i === 0,
      decorative: false,
      alt: "x",
    }));
    const state = await call(
      handleCosplayPostSave,
      req({ body: validSaveBody({ images }) }),
    );
    expect(state.status).toBe(400);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("título ausente: rechazado ANTES de llamar a la RPC (400)", async () => {
    const state = await call(
      handleCosplayPostSave,
      req({ body: { status: "draft", title: "", images: [] } }),
    );
    expect(state.status).toBe(400);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it.each([
    ["version_conflict", "cosplay_version_conflict", 409],
    ["post_not_found", "not_found", 404],
    ["too_many_photos", "too_many_photos", 400],
    ["duplicate_asset_id", "duplicate_asset_id", 400],
    ["asset_not_ready", "asset_not_ready", 400],
    ["foreign_asset", "foreign_asset", 403],
    ["asset_already_attached", "asset_already_attached", 409],
    ["no_ready_images", "no_ready_images", 422],
    ["no_cover", "no_cover", 422],
    ["missing_alt_es", "missing_alt", 422],
  ])(
    "la RPC rechaza con %s → HTTP %i con code %s (nunca el mensaje crudo de Postgres)",
    async (message, code, status) => {
      fake.rpcResult = rpcError(message);
      const state = await call(handleCosplayPostSave, req({ body: validSaveBody() }));
      expect(state.status).toBe(status);
      expect(JSON.stringify(state.body)).not.toContain("P0001");
      if (code) expect((state.body as { code?: string }).code).toBe(code);
    },
  );

  it("actualizar: expectedVersion llega a la RPC y el resultado se devuelve tal cual", async () => {
    fake.rpcResult = ok({ post: { id: POST_ID, version: 2 }, images: [] });
    const state = await call(
      handleCosplayPostSave,
      req({ body: validSaveBody({ postId: POST_ID, expectedVersion: 1 }) }),
    );
    expect(state.status).toBe(200);
    expect(fake.rpcCalls[0]!.args.p_post_id).toBe(POST_ID);
    expect(fake.rpcCalls[0]!.args.p_expected_version).toBe(1);
    expect(state.headers["Cache-Control"]).toBe("no-store");
  });

  it("modelo editorial neutral: la RPC recibe SIEMPRE null en title_en/title_de/description_en/description_de/alt_en/alt_de/caption_en/caption_de (corrección de producto 9I-3)", async () => {
    fake.rpcResult = ok({
      post: { id: POST_ID, version: 1, title_es: "Kirito de prueba" },
      images: [],
    });
    await call(
      handleCosplayPostSave,
      req({
        body: validSaveBody({
          description: "Una descripción",
          images: [{ ...validImage(), caption: "Una leyenda" }],
        }),
      }),
    );
    const args = fake.rpcCalls[0]!.args as Record<string, unknown>;
    expect(args.p_title_en).toBeNull();
    expect(args.p_title_de).toBeNull();
    expect(args.p_description_en).toBeNull();
    expect(args.p_description_de).toBeNull();
    expect(args.p_title_es).toBe("Kirito de prueba");
    expect(args.p_description_es).toBe("Una descripción");
    const image = (args.p_images as Record<string, unknown>[])[0]!;
    expect(image.alt_en).toBeNull();
    expect(image.alt_de).toBeNull();
    expect(image.caption_en).toBeNull();
    expect(image.caption_de).toBeNull();
    expect(image.alt_es).toBe("Kirito con espada");
    expect(image.caption_es).toBe("Una leyenda");
  });

  it("la respuesta expone el contrato neutral (title/description), nunca title_es/description_es en bruto", async () => {
    fake.rpcResult = ok({
      post: {
        id: POST_ID,
        slug: "kirito-de-prueba",
        status: "draft",
        title_es: "Kirito de prueba",
        description_es: null,
        character_name: null,
        series: null,
        event: null,
        shot_on: null,
        photographer_credit: null,
        version: 1,
        published_at: null,
      },
      images: [],
    });
    const state = await call(handleCosplayPostSave, req({ body: validSaveBody() }));
    expect(state.status).toBe(200);
    const body = state.body as { post: { title: string } };
    expect(body.post.title).toBe("Kirito de prueba");
    expect(JSON.stringify(body)).not.toContain("title_es");
  });

  it("postId presente sin expectedVersion numérico: 400 sin llamar a la RPC", async () => {
    const state = await call(
      handleCosplayPostSave,
      req({ body: validSaveBody({ postId: POST_ID }) }),
    );
    expect(state.status).toBe(400);
    expect(fake.rpcCalls).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// REORDER

describe("POST cosplay-post-reorder", () => {
  it("traduce imageId → image_id para la RPC y devuelve la nueva version", async () => {
    fake.rpcResult = ok({ version: 5 });
    const state = await call(
      handleCosplayPostReorder,
      req({
        body: {
          postId: POST_ID,
          expectedVersion: 4,
          positions: [
            { imageId: IMAGE_ID, position: 1 },
            { imageId: "1cddc109-2255-4cda-8c1c-cd35159ce225", position: 0 },
          ],
        },
      }),
    );
    expect(state.status).toBe(200);
    expect(fake.rpcCalls[0]!.args.p_positions).toEqual([
      { image_id: IMAGE_ID, position: 1 },
      { image_id: "1cddc109-2255-4cda-8c1c-cd35159ce225", position: 0 },
    ]);
    expect(state.body).toEqual({ version: 5 });
  });

  it("images_missing_existing (falta una imagen del conjunto actual) → 400", async () => {
    fake.rpcResult = rpcError("images_missing_existing");
    const state = await call(
      handleCosplayPostReorder,
      req({ body: { postId: POST_ID, expectedVersion: 4, positions: [] } }),
    );
    expect(state.status).toBe(400);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// DETACH — la desconexión de galería y la limpieza de R2 son pasos distintos; este handler debe
// encadenarlos y reportar honestamente si la limpieza falló.

describe("POST cosplay-media-detach", () => {
  it("éxito: la RPC desadjunta y luego se invoca attemptMediaAssetCleanup con el asset devuelto", async () => {
    fake.rpcResult = ok({ asset_id: ASSET_ID, version: 6 });
    cleanupMock.mockResolvedValue({ assetId: ASSET_ID, cleaned: true });

    const state = await call(
      handleCosplayMediaDetach,
      req({ body: { postId: POST_ID, expectedVersion: 5, imageId: IMAGE_ID } }),
    );

    expect(state.status).toBe(200);
    expect(cleanupMock).toHaveBeenCalledWith(ASSET_ID);
    expect(state.body).toEqual({ version: 6, assetId: ASSET_ID, cleaned: true });
  });

  it("la relación se desadjunta igual aunque la limpieza de R2 falle: cleaned:false, nunca un 500", async () => {
    fake.rpcResult = ok({ asset_id: ASSET_ID, version: 6 });
    cleanupMock.mockResolvedValue({ assetId: ASSET_ID, cleaned: false });

    const state = await call(
      handleCosplayMediaDetach,
      req({ body: { postId: POST_ID, expectedVersion: 5, imageId: IMAGE_ID } }),
    );

    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ cleaned: false });
  });

  it("image_not_found → 404, nunca se invoca la limpieza", async () => {
    fake.rpcResult = rpcError("image_not_found");
    const state = await call(
      handleCosplayMediaDetach,
      req({ body: { postId: POST_ID, expectedVersion: 5, imageId: IMAGE_ID } }),
    );
    expect(state.status).toBe(404);
    expect(cleanupMock).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// DELETE — borrado duro + limpieza best-effort de cada asset afectado.

describe("POST cosplay-post-delete", () => {
  it("borrado con 2 assets: limpia ambos y allCleaned=true si los dos se confirmaron", async () => {
    fake.rpcResult = ok({ deleted_asset_ids: [ASSET_ID, "asset-2"] });
    cleanupMock
      .mockResolvedValueOnce({ assetId: ASSET_ID, cleaned: true })
      .mockResolvedValueOnce({ assetId: "asset-2", cleaned: true });

    const state = await call(
      handleCosplayPostDelete,
      req({ body: { postId: POST_ID, expectedVersion: 6 } }),
    );

    expect(state.status).toBe(200);
    expect(cleanupMock).toHaveBeenCalledTimes(2);
    expect((state.body as { allCleaned: boolean }).allCleaned).toBe(true);
  });

  it("limpieza parcial (un asset falla): allCleaned=false, pero el borrado del post ya se reporta como hecho", async () => {
    fake.rpcResult = ok({ deleted_asset_ids: [ASSET_ID, "asset-2"] });
    cleanupMock
      .mockResolvedValueOnce({ assetId: ASSET_ID, cleaned: true })
      .mockResolvedValueOnce({ assetId: "asset-2", cleaned: false });

    const state = await call(
      handleCosplayPostDelete,
      req({ body: { postId: POST_ID, expectedVersion: 6 } }),
    );

    expect(state.status).toBe(200);
    const body = state.body as {
      postId: string;
      allCleaned: boolean;
      deletedAssets: unknown[];
    };
    expect(body.allCleaned).toBe(false);
    expect(body.deletedAssets).toHaveLength(2);
  });

  it("post sin publicaciones adjuntas: deleted_asset_ids vacío, sin llamar a la limpieza", async () => {
    fake.rpcResult = ok({ deleted_asset_ids: [] });
    const state = await call(
      handleCosplayPostDelete,
      req({ body: { postId: POST_ID, expectedVersion: 6 } }),
    );
    expect(state.status).toBe(200);
    expect(cleanupMock).not.toHaveBeenCalled();
    expect((state.body as { allCleaned: boolean }).allCleaned).toBe(true);
  });

  it("version_conflict → 409 cosplay_version_conflict, nunca se ejecuta la limpieza", async () => {
    fake.rpcResult = rpcError("version_conflict");
    const state = await call(
      handleCosplayPostDelete,
      req({ body: { postId: POST_ID, expectedVersion: 1 } }),
    );
    expect(state.status).toBe(409);
    expect((state.body as { code?: string }).code).toBe("cosplay_version_conflict");
    expect(cleanupMock).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// LECTURAS ADMIN

describe("GET cosplay-post-list-admin / cosplay-post-get-admin", () => {
  it("el listado incluye borradores (nunca filtra por status, a diferencia de la ruta pública)", async () => {
    fake.postListResult = {
      data: [
        {
          id: "p1",
          slug: "a",
          status: "draft",
          title_es: "A",
          version: 1,
          published_at: null,
        },
        {
          id: "p2",
          slug: "b",
          status: "published",
          title_es: "B",
          version: 3,
          published_at: "x",
        },
      ],
      error: null,
    };
    const state = await call(handleCosplayPostListAdmin, req({ method: "GET" }));
    expect(state.status).toBe(200);
    const body = state.body as { items: { status: string; title: string }[] };
    expect(body.items.map((i) => i.status)).toEqual(["draft", "published"]);
    // Contrato neutral (corrección de producto, 9I-3): "title", nunca "title_es" ni "titleEs".
    expect(body.items.map((i) => i.title)).toEqual(["A", "B"]);
    expect(JSON.stringify(body)).not.toContain("title_es");
  });

  it("get de una publicación inexistente → 404", async () => {
    fake.postGetResult = { data: null, error: null };
    const state = await call(
      handleCosplayPostGetAdmin,
      req({ method: "GET", query: { postId: POST_ID } }),
    );
    expect(state.status).toBe(404);
  });

  it("get de un borrador existente → 200 (visible para ADMIN, a diferencia de la ruta pública)", async () => {
    fake.postGetResult = {
      data: { id: POST_ID, slug: "x", status: "draft", title_es: "X", version: 1 },
      error: null,
    };
    const state = await call(
      handleCosplayPostGetAdmin,
      req({ method: "GET", query: { postId: POST_ID } }),
    );
    expect(state.status).toBe(200);
    expect((state.body as { status: string }).status).toBe("draft");
  });

  it("la galería usa la URL pública real (publicVariantUrl), nunca expone storage_key en bruto", async () => {
    vi.stubEnv("R2_DEV_ACCESS_KEY_ID", "test-access-key-id");
    vi.stubEnv("R2_DEV_SECRET_ACCESS_KEY", "test-secret-access-key");
    vi.stubEnv("R2_DEV_ENDPOINT", "https://test-account.r2.cloudflarestorage.com");
    vi.stubEnv("R2_DEV_PRIVATE_BUCKET", "upmina-media-dev-private");
    vi.stubEnv("R2_DEV_PUBLIC_BUCKET", "upmina-media-dev-public");
    vi.stubEnv("R2_DEV_PUBLIC_BASE_URL", "https://pub-test.r2.dev");
    const { resetR2DevConfigCache } = await import("./r2-client");
    resetR2DevConfigCache();

    fake.postGetResult = {
      data: {
        id: POST_ID,
        slug: "x",
        status: "draft",
        title_es: "X",
        version: 1,
        cosplay_post_images: [
          {
            id: IMAGE_ID,
            asset_id: ASSET_ID,
            position: 0,
            is_cover: true,
            decorative: false,
            alt_es: "alt",
            alt_en: null,
            alt_de: null,
            caption_es: null,
            caption_en: null,
            caption_de: null,
            media_assets: {
              id: ASSET_ID,
              status: "ready",
              width: 480,
              height: 640,
              storage_key: "cosplay/asset-1/w480.webp",
            },
          },
          {
            id: "img-processing",
            asset_id: "asset-processing",
            position: 1,
            is_cover: false,
            decorative: false,
            alt_es: null,
            alt_en: null,
            alt_de: null,
            caption_es: null,
            caption_en: null,
            caption_de: null,
            media_assets: {
              id: "asset-processing",
              status: "processing",
              width: 0,
              height: 0,
              storage_key: "cosplay/asset-2/staging",
            },
          },
        ],
      },
      error: null,
    };

    const state = await call(
      handleCosplayPostGetAdmin,
      req({ method: "GET", query: { postId: POST_ID } }),
    );

    expect(state.status).toBe(200);
    const body = state.body as { images: { url: string | null; assetStatus: string }[] };
    expect(body.images[0]!.url).toBe("https://pub-test.r2.dev/cosplay/asset-1/w480.webp");
    // Un asset aún no 'ready' no tiene URL pública resoluble todavía.
    expect(body.images[1]!.url).toBeNull();
    expect(body.images[1]!.assetStatus).toBe("processing");
    expect(JSON.stringify(body)).not.toContain("storage_key");
    expect(JSON.stringify(body)).not.toContain("staging");

    vi.unstubAllEnvs();
    resetR2DevConfigCache();
  });

  it("postId con formato inválido → 400 sin tocar la base de datos", async () => {
    const state = await call(
      handleCosplayPostGetAdmin,
      req({ method: "GET", query: { postId: "no-es-un-uuid" } }),
    );
    expect(state.status).toBe(400);
  });
});
