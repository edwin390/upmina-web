import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Cliente del editor ADMIN de Cosplay (Fase 9I-3, checkpoint 3): comprueba que postJson/getJson
// (a) construyen la URL correcta de api/admin/[action].ts (path, no query param `action`), (b)
// clasifican un rechazo 401/403 con la MISMA semántica 9G-3 que media-client.ts, y (c) traducen
// snake_case↔camelCase en el único punto de la app que debe conocer ambas formas. Red y Supabase
// siempre mockeados: nunca golpea el backend real.

const supabaseFakes = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: supabaseFakes.getSession } },
}));

import {
  CosplayAdminClientError,
  deleteCosplayPost,
  detachCosplayMedia,
  getCosplayPostAdmin,
  listCosplayPostsAdmin,
  reorderCosplayImages,
  saveCosplayPost,
} from "./cosplay-admin-client";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    clone() {
      return jsonResponse(status, body);
    },
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  supabaseFakes.getSession.mockResolvedValue({
    data: { session: { access_token: "at-test" } },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("construcción de URL — api/admin/<action>, nunca ?action=", () => {
  it("listCosplayPostsAdmin → GET /api/admin/cosplay-post-list-admin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await listCosplayPostsAdmin();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/cosplay-post-list-admin",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("getCosplayPostAdmin → GET /api/admin/cosplay-post-get-admin?postId=…", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        id: "p1",
        slug: "s",
        status: "draft",
        title: "T",
        description: null,
        characterName: null,
        series: null,
        event: null,
        shotOn: null,
        photographerCredit: null,
        version: 1,
        publishedAt: null,
        images: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await getCosplayPostAdmin("p1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/cosplay-post-get-admin?postId=p1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("saveCosplayPost → POST /api/admin/cosplay-post-save con Authorization + JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        post: {
          id: "p1",
          slug: "s",
          status: "draft",
          title: "T",
          description: null,
          characterName: null,
          series: null,
          event: null,
          shotOn: null,
          photographerCredit: null,
          version: 1,
          publishedAt: null,
        },
        images: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await saveCosplayPost({
      postId: null,
      expectedVersion: null,
      status: "draft",
      title: "T",
      description: null,
      characterName: null,
      series: null,
      event: null,
      shotOn: null,
      photographerCredit: null,
      images: [],
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/admin/cosplay-post-save");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer at-test",
      "Content-Type": "application/json",
    });
  });
});

describe("modelo editorial neutral (un valor por campo, sin variantes ES/EN/DE)", () => {
  it("saveCosplayPost: el body enviado y la respuesta usan el mismo contrato neutral (title/alt/caption)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        post: {
          id: "p1",
          slug: "kirito",
          status: "published",
          title: "Kirito",
          description: null,
          characterName: "Kirito",
          series: null,
          event: null,
          shotOn: null,
          photographerCredit: null,
          version: 2,
          publishedAt: "2026-01-01T00:00:00.000Z",
        },
        images: [
          {
            id: "img-1",
            assetId: "asset-1",
            position: 0,
            isCover: true,
            decorative: false,
            alt: "alt",
            caption: null,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await saveCosplayPost({
      postId: null,
      expectedVersion: null,
      status: "published",
      title: "Kirito",
      description: null,
      characterName: null,
      series: null,
      event: null,
      shotOn: null,
      photographerCredit: null,
      images: [
        {
          assetId: "asset-1",
          position: 0,
          isCover: true,
          decorative: false,
          alt: "alt",
          caption: null,
        },
      ],
    });

    // El cuerpo HTTP ya es el contrato neutral que espera parseSavePostInput en
    // cosplay-editor-handlers.ts: NUNCA titleEs/titleEn/titleDe — este cliente no traduce nada,
    // solo transporta (el servidor mapea a las columnas *_es internas, ver ese archivo).
    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(sentBody.title).toBe("Kirito");
    expect(sentBody).not.toHaveProperty("titleEs");
    expect(sentBody.images).toEqual([
      expect.objectContaining({ assetId: "asset-1", isCover: true, alt: "alt" }),
    ]);

    expect(result.post).toEqual(
      expect.objectContaining({
        id: "p1",
        title: "Kirito",
        characterName: "Kirito",
        version: 2,
      }),
    );
    expect(result.images[0]).toEqual(
      expect.objectContaining({
        id: "img-1",
        assetId: "asset-1",
        isCover: true,
        alt: "alt",
      }),
    );
  });
});

describe("clasificación 9G-3 de rechazos privilegiados (misma semántica que media-client.ts)", () => {
  it("403 + code step_up_required → privilegedFailure = 'step_up_required'", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(403, { error: "No autorizado", code: "step_up_required" }),
        ),
    );
    try {
      await listCosplayPostsAdmin();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CosplayAdminClientError);
      const e = err as CosplayAdminClientError;
      expect(e.status).toBe(403);
      expect(e.privilegedFailure).toBe("step_up_required");
    }
  });

  it("409 cosplay_version_conflict → code expuesto, privilegedFailure null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          error: "Solicitud inválida",
          code: "cosplay_version_conflict",
        }),
      ),
    );
    try {
      await reorderCosplayImages({ postId: "p1", expectedVersion: 1, positions: [] });
      expect.unreachable();
    } catch (err) {
      const e = err as CosplayAdminClientError;
      expect(e.code).toBe("cosplay_version_conflict");
      expect(e.privilegedFailure).toBeNull();
    }
  });

  it("401 → privilegedFailure = 'unauthenticated'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(401, { error: "No autenticado" })),
    );
    try {
      await detachCosplayMedia({ postId: "p1", expectedVersion: 1, imageId: "img-1" });
      expect.unreachable();
    } catch (err) {
      expect((err as CosplayAdminClientError).privilegedFailure).toBe("unauthenticated");
    }
  });

  it("un fallo de negocio normal (400) no es un rechazo de autorización: privilegedFailure = null", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(400, { error: "Solicitud inválida", code: "too_many_photos" }),
        ),
    );
    try {
      await deleteCosplayPost({ postId: "p1", expectedVersion: 1 });
      expect.unreachable();
    } catch (err) {
      const e = err as CosplayAdminClientError;
      expect(e.privilegedFailure).toBeNull();
      expect(e.code).toBe("too_many_photos");
    }
  });
});
