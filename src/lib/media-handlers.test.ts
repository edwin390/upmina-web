import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AdminAuthError, STEP_UP_REQUIRED_CODE } from "./admin-auth";

// Handlers del pipeline de medios (Fase 9I-2B): la pieza más sensible de seguridad de este
// checkpoint. Se mockean admin-auth (ya tiene su propia matriz de roles probada en
// admin-auth.test.ts — aquí solo se comprueba que media-handlers.ts LLAMA a requireCapability
// con "cosplay_admin" y respeta su resultado), Supabase (fake en memoria propio de este archivo,
// ver mediaDb más abajo), r2-client (nunca se golpea R2 real en tests unitarios) y
// media-processing (su propia lógica ya está probada en media-processing.test.ts; aquí solo
// importa cómo el handler reacciona a éxito/fallo).

const requireCapabilityMock = vi.fn();
// 9J-1C: complete/abort ahora autentican SIEMPRE primero (requireAuthenticated) — el domain (y
// por tanto si aplica cosplay_admin o el gate de Comunidad) solo se conoce tras leer la fila —
// así que este mock también se controla explícitamente en los tests de autorización. Por defecto
// (beforeEach) resuelve la MISMA identidad admin que requireCapabilityMock: para un asset
// domain='cosplay', authorizeForAssetRow vuelve a llamar a requireCapability (el mock de arriba),
// nunca reimplementa su lógica — así que preservar el comportamiento de Cosplay solo exige que
// ambos mocks queden sincronizados en cada test, no que se elimine ninguno de los dos.
const requireAuthenticatedMock = vi.fn();
vi.mock("./admin-auth.js", async () => {
  const actual = await vi.importActual<typeof import("./admin-auth")>("./admin-auth");
  return {
    ...actual,
    requireCapability: (...args: unknown[]) => requireCapabilityMock(...args),
    requireAuthenticated: (...args: unknown[]) => requireAuthenticatedMock(...args),
  };
});

const isProductionEnvironmentMock = vi.fn(() => false);
vi.mock("./instagram-oauth-shared.js", () => ({
  isProductionEnvironment: () => isProductionEnvironmentMock(),
}));

const r2Mocks = {
  presignPrivatePut: vi.fn(async () => "https://r2.test/private/put-url"),
  createPrivateMultipartUpload: vi.fn(async () => "upload-id-123"),
  presignPrivateUploadPart: vi.fn(
    async (_key: string, _uploadId: string, partNumber: number) =>
      `https://r2.test/private/part-${partNumber}`,
  ),
  completePrivateMultipartUpload: vi.fn(async () => undefined),
  abortPrivateMultipartUpload: vi.fn(async () => undefined),
  headPrivateObject: vi.fn(async () => ({ bytes: 1000, contentType: "image/jpeg" })),
  getPrivateObjectBytes: vi.fn(async () => Buffer.from("fake-bytes")),
  copyPrivateObject: vi.fn(async () => undefined),
  copyPrivateObjectToPublic: vi.fn(async () => undefined),
  deletePrivateObject: vi.fn(async () => undefined),
  putPublicVariant: vi.fn(async () => undefined),
  deletePublicVariants: vi.fn(async () => undefined),
  publicVariantUrl: vi.fn((key: string) => `https://pub-test.r2.dev/${key}`),
  PRESIGN_TTL_SINGLE_PUT_SECONDS: 900,
  PRESIGN_TTL_MULTIPART_PART_SECONDS: 1800,
};
vi.mock("./r2-client.js", () => r2Mocks);

const processImageMock = vi.fn();
vi.mock("./media-processing.js", async () => {
  const actual =
    await vi.importActual<typeof import("./media-processing")>("./media-processing");
  return {
    ...actual,
    processImage: (...args: unknown[]) => processImageMock(...args),
  };
});

type Row = Record<string, unknown>;

const mediaDb = {
  media_assets: [] as Row[],
  media_asset_variants: [] as Row[],
  // 9J-1C: authorizeCommunity (media-handlers.ts) consulta profiles para exigir "perfil de
  // Comunidad existente antes de reservar" — fake mínimo, solo lo que ese SELECT necesita.
  profiles: [] as Row[],
};

function resetMediaDb() {
  mediaDb.media_assets = [];
  mediaDb.media_asset_variants = [];
  mediaDb.profiles = [];
  mediaAssetsUpdateCalls.length = 0;
}

// Registra cada payload de UPDATE sobre media_assets, en orden — el fake DB no aplica CHECK
// constraints reales (a diferencia de Postgres), así que probar la regresión de
// media_assets_failure_code_presence (Fase 9I-2C) exige inspeccionar el PAYLOAD exacto que
// setStatus() envía en cada transición, no solo el estado final de la fila.
const mediaAssetsUpdateCalls: Row[] = [];
let variantsInsertError: unknown = null;
let assetReadyError: unknown = null;

class FakeQueryBuilder {
  private filters: [string, unknown][] = [];
  private single = false;

  constructor(
    private readonly table: Row[],
    private readonly op: "select" | "insert" | "update" | "delete",
    private readonly payload?: Row | Row[],
  ) {}

  eq(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }

  select(_cols?: string) {
    void _cols;
    return this;
  }

  maybeSingle() {
    this.single = true;
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every(([k, v]) => row[k] === v);
  }

  private execute(): { data: unknown; error: unknown } {
    if (
      this.op === "insert" &&
      this.table === mediaDb.media_asset_variants &&
      variantsInsertError
    ) {
      return { data: null, error: variantsInsertError };
    }
    if (
      this.op === "update" &&
      this.table === mediaDb.media_assets &&
      (this.payload as Row)?.status === "ready" &&
      assetReadyError
    ) {
      return { data: null, error: assetReadyError };
    }
    if (this.op === "insert") {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload!]).map(
        (r) => ({
          ...r,
        }),
      );
      this.table.push(...rows);
      return { data: rows, error: null };
    }
    if (this.op === "update") {
      const matched = this.table.filter((r) => this.matches(r));
      matched.forEach((r) => Object.assign(r, this.payload));
      return { data: matched, error: null };
    }
    if (this.op === "delete") {
      const matched = this.table.filter((r) => this.matches(r));
      for (const r of matched) {
        const idx = this.table.indexOf(r);
        if (idx >= 0) this.table.splice(idx, 1);
      }
      return { data: matched, error: null };
    }
    const matched = this.table.filter((r) => this.matches(r)).map((r) => ({ ...r }));
    if (this.single) return { data: matched[0] ?? null, error: null };
    return { data: matched, error: null };
  }

  then<R1 = unknown, R2 = never>(
    onfulfilled?:
      ((value: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

function fakeCreateClient() {
  return {
    from(tableName: "media_assets" | "media_asset_variants" | "profiles") {
      const table = mediaDb[tableName];
      return {
        insert: (payload: Row | Row[]) => new FakeQueryBuilder(table, "insert", payload),
        update: (payload: Row) => {
          if (tableName === "media_assets") mediaAssetsUpdateCalls.push({ ...payload });
          return new FakeQueryBuilder(table, "update", payload);
        },
        delete: () => new FakeQueryBuilder(table, "delete"),
        select: (cols?: string) => new FakeQueryBuilder(table, "select").select(cols),
      };
    },
  };
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => fakeCreateClient(),
}));

const { handleMediaAbort, handleMediaComplete, handleMediaReserve } =
  await import("./media-handlers");

function makeReq(body: unknown, method = "POST"): VercelRequest {
  return { method, body, query: {}, headers: {} } as unknown as VercelRequest;
}

function makeRes(): VercelResponse & { _status?: number; _json?: unknown } {
  const res = {} as VercelResponse & { _status?: number; _json?: unknown };
  res.status = vi.fn((code: number) => {
    res._status = code;
    return res;
  }) as unknown as VercelResponse["status"];
  res.json = vi.fn((body: unknown) => {
    res._json = body;
    return res;
  }) as unknown as VercelResponse["json"];
  res.setHeader = vi.fn() as unknown as VercelResponse["setHeader"];
  return res;
}

beforeEach(() => {
  r2Mocks.putPublicVariant.mockReset();
  r2Mocks.putPublicVariant.mockResolvedValue(undefined);
  variantsInsertError = null;
  assetReadyError = null;
  resetMediaDb();
  isProductionEnvironmentMock.mockReturnValue(false);
  requireCapabilityMock.mockResolvedValue({
    userId: "admin-user-1",
    role: "admin",
    capabilities: ["cosplay_admin"],
  });
  requireAuthenticatedMock.mockResolvedValue({
    userId: "admin-user-1",
    aal: "aal2",
    mfaVerifiedAt: Math.floor(Date.now() / 1000),
  });
  vi.stubEnv("VITE_SUPABASE_URL", "https://fake.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
  for (const mock of Object.values(r2Mocks)) {
    if (typeof mock === "function" && "mockClear" in mock) mock.mockClear();
  }
  r2Mocks.presignPrivatePut.mockResolvedValue("https://r2.test/private/put-url");
  r2Mocks.createPrivateMultipartUpload.mockResolvedValue("upload-id-123");
  r2Mocks.headPrivateObject.mockResolvedValue({ bytes: 1000, contentType: "image/jpeg" });
  r2Mocks.getPrivateObjectBytes.mockResolvedValue(Buffer.from("fake-bytes"));
  processImageMock.mockReset();
  processImageMock.mockResolvedValue({
    sourceWidth: 1000,
    sourceHeight: 800,
    variants: [
      {
        variant: 480,
        width: 480,
        height: 384,
        bytes: 20000,
        buffer: Buffer.from("v480"),
      },
      {
        variant: 960,
        width: 960,
        height: 768,
        bytes: 60000,
        buffer: Buffer.from("v960"),
      },
    ],
  });
});

describe("imágenes pequeñas — tier nominal y manejo de fallos", () => {
  it.each(["community", "cosplay"])(
    "%s: procesador real de imagen pequeña inserta tier 480 y publica w480",
    async (domain) => {
      const { default: sharp } = await import("sharp");
      const { processImage } =
        await vi.importActual<typeof import("./media-processing")>("./media-processing");
      const source = await sharp({
        create: { width: 468, height: 428, channels: 3, background: "red" },
      })
        .jpeg()
        .toBuffer();
      processImageMock.mockResolvedValueOnce(await processImage(source, "image/jpeg"));
      const id = seedReserved();
      Object.assign(mediaDb.media_assets[0]!, { domain, created_by: "admin-user-1" });
      const res = makeRes();
      await handleMediaComplete(makeReq({ assetId: id }), res);
      expect(res._json).toMatchObject({
        status: "ready",
        variants: [{ variant: 480, width: 468, height: 428 }],
      });
      expect(mediaDb.media_asset_variants).toHaveLength(1);
      expect(mediaDb.media_asset_variants[0]).toMatchObject({
        asset_id: id,
        variant: 480,
        width: 468,
        height: 428,
        storage_key: `${domain}/${id}/w480.webp`,
      });
      expect(r2Mocks.putPublicVariant).toHaveBeenCalledWith(
        `${domain}/${id}/w480.webp`,
        expect.any(Buffer),
        "image/webp",
      );
    },
  );
  function seedReserved(): string {
    const id = "asset-small-image";
    mediaDb.media_assets.push({
      id,
      domain: "cosplay",
      status: "reserved",
      source_mime: "image/jpeg",
      source_bytes: 1000,
      private_original_key: `staging/cosplay/${id}/original.jpg`,
      multipart_upload_id: null,
      processing_attempts: 0,
    });
    return id;
  }
  it.each(["variant_publish", "variant_db_insert", "asset_ready_update"] as const)(
    "mantiene processing_failed y estado failed ante fallo de %s",
    async (stage) => {
      const error = { name: "PostgrestError", code: "23514" };
      if (stage === "variant_publish")
        r2Mocks.putPublicVariant.mockRejectedValueOnce(error);
      if (stage === "variant_db_insert") variantsInsertError = error;
      if (stage === "asset_ready_update") assetReadyError = error;
      const id = seedReserved();
      const res = makeRes();
      await handleMediaComplete(makeReq({ assetId: id }), res);
      expect(res._status).toBe(200);
      expect(res._json).toEqual({
        assetId: id,
        status: "failed",
        failureCode: "processing_failed",
      });
      expect(mediaDb.media_assets.find((row) => row.id === id)?.status).toBe("failed");
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────────────────────

describe("autorización — los 3 handlers exigen cosplay_admin, nunca confían en el frontend", () => {
  it.each([
    [
      "handleMediaReserve",
      () =>
        handleMediaReserve(
          makeReq({ domain: "cosplay", sourceMime: "image/jpeg", sourceBytes: 1000 }),
          makeRes(),
        ),
    ],
    [
      "handleMediaComplete",
      () => handleMediaComplete(makeReq({ assetId: "x" }), makeRes()),
    ],
    ["handleMediaAbort", () => handleMediaAbort(makeReq({ assetId: "x" }), makeRes())],
  ])(
    "%s: 403 genérico si falta la capacidad (USER/MODERATOR/DEVELOPER), SIN code",
    async (_name, run) => {
      // 9J-1C: complete/abort exigen conocer el domain de la fila ANTES de autorizar — un asset
      // domain='cosplay' real (el usuario SÍ está autenticado, solo le falta cosplay_admin;
      // requireAuthenticatedMock sigue resuelto por el beforeEach) para que la comprobación de
      // capacidad (mockeada abajo) sea la que decide, igual que antes de este checkpoint.
      mediaDb.media_assets.push({
        id: "x",
        domain: "cosplay",
        status: "reserved",
        source_mime: "image/jpeg",
        source_bytes: 1000,
        private_original_key: "staging/cosplay/x/original.jpg",
        multipart_upload_id: null,
        processing_attempts: 0,
      });
      requireCapabilityMock.mockRejectedValue(new AdminAuthError("No autorizado", 403));
      const res = (await run()) as unknown as ReturnType<typeof makeRes>;
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: "No autorizado" });
    },
  );

  it.each([
    [
      "handleMediaReserve",
      () =>
        handleMediaReserve(
          makeReq({ domain: "cosplay", sourceMime: "image/jpeg", sourceBytes: 1000 }),
          makeRes(),
        ),
    ],
    [
      "handleMediaComplete",
      () => handleMediaComplete(makeReq({ assetId: "x" }), makeRes()),
    ],
    ["handleMediaAbort", () => handleMediaAbort(makeReq({ assetId: "x" }), makeRes())],
  ])("%s: 401 sin sesión", async (_name, run) => {
    // 9J-1C: complete/abort autentican con requireAuthenticated ANTES de leer ninguna fila —
    // sin sesión válida, ninguno de los dos handlers llega a tocar la DB (ni siquiera para
    // devolver un 404 "honesto"): ambos mocks deben reflejar "no autenticado" para reproducir
    // fielmente el 401 uniforme que ya daban los tres handlers antes de este checkpoint.
    requireCapabilityMock.mockRejectedValue(new AdminAuthError("No autenticado", 401));
    requireAuthenticatedMock.mockRejectedValue(new AdminAuthError("No autenticado", 401));
    const res = (await run()) as unknown as ReturnType<typeof makeRes>;
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("ADMIN con capacidad pero SIN MFA reciente: 403 step_up_required, nunca reserva nada", async () => {
    requireCapabilityMock.mockRejectedValue(
      new AdminAuthError("No autorizado", 403, STEP_UP_REQUIRED_CODE),
    );
    const res = makeRes();
    await handleMediaReserve(
      makeReq({ domain: "cosplay", sourceMime: "image/jpeg", sourceBytes: 1000 }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "No autorizado",
      code: "step_up_required",
    });
    expect(mediaDb.media_assets).toHaveLength(0);
  });
});

describe("Production — release 9I: la reserva ya NO se rechaza solo por VERCEL_ENV=production", () => {
  // Guarda un tiempo obsoleta (sección 7 original, de cuando Production no tenía credenciales R2):
  // refuseIfProduction() devolvía 403 "No disponible en este entorno" incondicionalmente en
  // Production, sin importar que R2_PROD_* ya existiera. Se eliminó junto con sus 3 llamadas en
  // reserve/complete/abort — la única puerta de entorno real ahora vive en r2-client.ts
  // (getActiveR2Config(), probado en r2-client.test.ts), no en estos handlers.
  it("handleMediaReserve en Production: NO devuelve 403 'No disponible en este entorno', llega a R2 y crea la fila", async () => {
    isProductionEnvironmentMock.mockReturnValue(true);

    const res = makeRes();
    await handleMediaReserve(
      makeReq({ domain: "cosplay", sourceMime: "image/jpeg", sourceBytes: 1_000_000 }),
      res,
    );

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.json).not.toHaveBeenCalledWith({ error: "No disponible en este entorno" });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mediaDb.media_assets).toHaveLength(1);
    expect(r2Mocks.presignPrivatePut).toHaveBeenCalled();
  });

  it("handleMediaComplete en Production: no se rechaza por entorno (avanza a validación normal de assetId)", async () => {
    isProductionEnvironmentMock.mockReturnValue(true);

    const res = makeRes();
    await handleMediaComplete(makeReq({ assetId: "no-existe" }), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    // El asset no existe en la DB fake: 404, no 403 de entorno — prueba que pasó la guarda obsoleta.
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("handleMediaAbort en Production: no se rechaza por entorno (avanza a validación normal de assetId)", async () => {
    isProductionEnvironmentMock.mockReturnValue(true);

    const res = makeRes();
    await handleMediaAbort(makeReq({ assetId: "no-existe" }), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("fuera de Production, el comportamiento no cambia: reserva sigue funcionando igual que antes", async () => {
    isProductionEnvironmentMock.mockReturnValue(false);

    const res = makeRes();
    await handleMediaReserve(
      makeReq({ domain: "cosplay", sourceMime: "image/jpeg", sourceBytes: 1_000_000 }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mediaDb.media_assets).toHaveLength(1);
  });
});

describe("handleMediaReserve — validación y modos de subida", () => {
  it("cuerpo inválido (mime fuera de la lista cerrada): 400, sin fila creada", async () => {
    const res = makeRes();
    await handleMediaReserve(
      makeReq({ domain: "cosplay", sourceMime: "image/svg+xml", sourceBytes: 1000 }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mediaDb.media_assets).toHaveLength(0);
  });

  it("domain no soportado: 400, sin fila creada (video u otro domain futuro sin migración)", async () => {
    const res = makeRes();
    await handleMediaReserve(
      makeReq({ domain: "video", sourceMime: "image/jpeg", sourceBytes: 1000 }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mediaDb.media_assets).toHaveLength(0);
  });

  it("origen pequeño (< 16 MiB): modo single, clave server-generada, fila 'reserved'", async () => {
    const res = makeRes();
    await handleMediaReserve(
      makeReq({ domain: "cosplay", sourceMime: "image/jpeg", sourceBytes: 1_000_000 }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.mode).toBe("single");
    expect(body.uploadUrl).toBe("https://r2.test/private/put-url");
    expect(typeof body.assetId).toBe("string");

    expect(mediaDb.media_assets).toHaveLength(1);
    const row = mediaDb.media_assets[0]!;
    expect(row.status).toBe("reserved");
    expect(row.private_original_key).toBe(`staging/cosplay/${body.assetId}/original.jpg`);
    expect(row.created_by).toBe("admin-user-1");
  });

  it("origen grande (≥16 MiB): modo multipart, N partes presignadas", async () => {
    const res = makeRes();
    const sourceBytes = 20 * 1024 * 1024; // 20 MiB → 3 partes de 8 MiB
    await handleMediaReserve(
      makeReq({ domain: "cosplay", sourceMime: "image/heic", sourceBytes }),
      res,
    );
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.mode).toBe("multipart");
    expect(body.uploadId).toBe("upload-id-123");
    expect(body.parts).toHaveLength(3);
    expect(body.parts.map((p: { partNumber: number }) => p.partNumber)).toEqual([
      1, 2, 3,
    ]);
    expect(r2Mocks.createPrivateMultipartUpload).toHaveBeenCalledTimes(1);
    expect(mediaDb.media_assets[0]!.multipart_upload_id).toBe("upload-id-123");
  });

  it("si R2 falla al firmar, la fila se borra (el cliente nunca recibió el assetId para reintentar) y responde 500", async () => {
    r2Mocks.presignPrivatePut.mockRejectedValueOnce(new Error("r2 caído"));
    const res = makeRes();
    await handleMediaReserve(
      makeReq({ domain: "cosplay", sourceMime: "image/jpeg", sourceBytes: 1000 }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(mediaDb.media_assets).toHaveLength(0);
  });
});

describe("handleMediaComplete — verificación, procesado, idempotencia", () => {
  function seedReserved(overrides: Row = {}): string {
    const id = "asset-1";
    mediaDb.media_assets.push({
      id,
      domain: "cosplay",
      status: "reserved",
      source_mime: "image/jpeg",
      source_bytes: 1000,
      private_original_key: `staging/cosplay/${id}/original.jpg`,
      multipart_upload_id: null,
      processing_attempts: 0,
      ...overrides,
    });
    return id;
  }

  it("assetId inexistente: 404", async () => {
    const res = makeRes();
    await handleMediaComplete(makeReq({ assetId: "no-existe" }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("ya 'ready': idempotente — responde el estado actual, NUNCA vuelve a procesar", async () => {
    const id = seedReserved({ status: "ready" });
    mediaDb.media_asset_variants.push({
      asset_id: id,
      variant: 480,
      width: 480,
      height: 384,
      bytes: 20000,
      storage_key: "cosplay/asset-1/w480.webp",
    });
    const res = makeRes();
    await handleMediaComplete(makeReq({ assetId: id }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(processImageMock).not.toHaveBeenCalled();
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.status).toBe("ready");
    expect(body.variants).toHaveLength(1);
    // Regresión (Fase 9I-2C): la ruta idempotente (ya ready) también debe traer el nominal y los
    // bytes, no solo width/height/url.
    expect(body.variants[0]).toMatchObject({ variant: 480, bytes: 20000 });
  });

  it("ya 'processing': idempotente — responde el estado actual sin relanzar el procesado", async () => {
    const id = seedReserved({ status: "processing" });
    const res = makeRes();
    await handleMediaComplete(makeReq({ assetId: id }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(processImageMock).not.toHaveBeenCalled();
  });

  it("estado no completable (p. ej. 'deleting'): 409", async () => {
    const id = seedReserved({ status: "deleting" });
    const res = makeRes();
    await handleMediaComplete(makeReq({ assetId: id }), res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("multipart sin 'parts' en el body: 400, no completa nada en R2", async () => {
    const id = seedReserved({ multipart_upload_id: "upload-id-123" });
    const res = makeRes();
    await handleMediaComplete(makeReq({ assetId: id }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(r2Mocks.completePrivateMultipartUpload).not.toHaveBeenCalled();
  });

  it("HEAD no coincide con los bytes declarados: failed/upload_incomplete, nunca procesa", async () => {
    r2Mocks.headPrivateObject.mockResolvedValueOnce({
      bytes: 500,
      contentType: "image/jpeg",
    });
    const id = seedReserved();
    const res = makeRes();
    await handleMediaComplete(makeReq({ assetId: id }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.status).toBe("failed");
    expect(body.failureCode).toBe("upload_incomplete");
    expect(processImageMock).not.toHaveBeenCalled();
    expect(mediaDb.media_assets.find((r) => r.id === id)?.status).toBe("failed");
  });

  it("HEIC con perfil no soportado: failed/heic_unsupported_profile, el original NO se borra", async () => {
    const { ProcessingFailure } = await import("./media-processing");
    processImageMock.mockRejectedValueOnce(
      new ProcessingFailure("heic_unsupported_profile", "perfil no soportado"),
    );
    const id = seedReserved({ source_mime: "image/heic" });
    const res = makeRes();
    await handleMediaComplete(makeReq({ assetId: id }), res);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.status).toBe("failed");
    expect(body.failureCode).toBe("heic_unsupported_profile");
    expect(r2Mocks.deletePrivateObject).not.toHaveBeenCalledWith(
      expect.stringContaining("objects/cosplay"),
    );
  });

  it("camino feliz: sube variantes, inserta media_asset_variants, marca ready y borra el original", async () => {
    const id = seedReserved();
    const res = makeRes();
    await handleMediaComplete(makeReq({ assetId: id }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.status).toBe("ready");
    expect(body.variants).toHaveLength(2);
    expect(body.variants[0].url).toContain("pub-test.r2.dev");
    // Regresión (Fase 9I-2C): la respuesta debe traer el ancho NOMINAL y los bytes de cada
    // variante — sin esto, el arnés (y cualquier futuro consumidor real) no puede distinguir
    // 480/960/1600/2560 entre sí, solo dimensiones reales que a menudo se parecen visualmente.
    expect(body.variants[0]).toMatchObject({ variant: 480, bytes: expect.any(Number) });
    expect(body.variants[1]).toMatchObject({ variant: 960, bytes: expect.any(Number) });

    expect(r2Mocks.putPublicVariant).toHaveBeenCalledTimes(2);
    expect(mediaDb.media_asset_variants).toHaveLength(2);

    const row = mediaDb.media_assets.find((r) => r.id === id)!;
    expect(row.status).toBe("ready");
    expect(row.mime).toBe("image/webp");
    expect(row.private_original_key).toBeNull();
    // La variante más ancha (960) es la que se espeja en media_assets.
    expect(row.width).toBe(960);
    expect(r2Mocks.deletePrivateObject).toHaveBeenCalled();
  });

  it("fallo a mitad de subir variantes: limpia las públicas ya subidas, nunca deja un ready parcial", async () => {
    r2Mocks.putPublicVariant
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("r2 caído"));
    const id = seedReserved();
    const res = makeRes();
    await handleMediaComplete(makeReq({ assetId: id }), res);

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.status).toBe("failed");
    expect(body.failureCode).toBe("processing_failed");
    expect(r2Mocks.deletePublicVariants).toHaveBeenCalledTimes(1);
    expect(mediaDb.media_asset_variants).toHaveLength(0);
    expect(mediaDb.media_assets.find((r) => r.id === id)?.status).toBe("failed");
  });

  // Regresión real (Fase 9I-2C): la primera foto real de Edwin (WhatsApp JPEG, 720×888 — vertical)
  // falló 2/2 veces en producción local. Causa raíz: el handler usaba el ANCHO REAL de la variante
  // (389, tras encajarla en la caja 480×480) como valor de la columna `variant` y de la clave del
  // objeto público, en vez del ancho NOMINAL (480/960/1600/2560) que exige
  // media_asset_variants_variant_check. En toda foto horizontal/cuadrada de los fixtures existentes
  // ambos valores coinciden por casualidad — por eso nunca se detectó hasta una foto vertical real.
  it("imagen VERTICAL: usa el ancho NOMINAL (no el real) para la clave pública y la columna variant", async () => {
    processImageMock.mockResolvedValueOnce({
      sourceWidth: 720,
      sourceHeight: 888,
      variants: [
        { variant: 480, width: 389, height: 480, bytes: 21812, buffer: Buffer.from("v") },
      ],
    });
    const id = seedReserved();
    const res = makeRes();
    await handleMediaComplete(makeReq({ assetId: id }), res);

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.status).toBe("ready");

    expect(r2Mocks.putPublicVariant).toHaveBeenCalledWith(
      "cosplay/asset-1/w480.webp",
      expect.anything(),
      "image/webp",
    );
    expect(mediaDb.media_asset_variants[0]!.variant).toBe(480);
    expect(mediaDb.media_asset_variants[0]!.storage_key).toBe(
      "cosplay/asset-1/w480.webp",
    );
    // El ancho/alto REALES (no el nominal) siguen siendo los que se espejan en media_assets.
    const row = mediaDb.media_assets.find((r) => r.id === id)!;
    expect(row.width).toBe(389);
    expect(row.height).toBe(480);
  });

  // Regresión real (Fase 9I-2C): el primer reintento real sobre un asset failed rompía con
  // media_assets_failure_code_presence (23514) porque setStatus() nunca limpiaba failure_code al
  // salir de status=failed — Postgres rechazaba el UPDATE antes de que el reintento hiciera nada.
  it("reintento tras un fallo: el UPDATE failed→uploaded limpia failure_code (nunca viola failure_code_presence)", async () => {
    const id = seedReserved({
      status: "failed",
      failure_code: "processing_failed",
      private_original_key: `objects/cosplay/${"asset-1"}/original.jpg`,
      processing_attempts: 1,
    });
    const res = makeRes();
    await handleMediaComplete(makeReq({ assetId: id }), res);

    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].status).toBe("ready");
    const firstTransition = mediaAssetsUpdateCalls.find((c) => c.status === "uploaded");
    expect(firstTransition).toMatchObject({ status: "uploaded", failure_code: null });
  });

  // Regresión real (Fase 9I-2C): el mismo reintento, tras arreglar lo anterior, llegaba a copiar
  // el original SOBRE SÍ MISMO (private_original_key ya era la clave permanente, de un intento
  // previo) y luego lo BORRABA — destruyendo el original antes de procesar. Reproducido en R2 real:
  // el archivo de Edwin quedó irrecuperable en el primer reintento de diagnóstico.
  it("reintento cuando private_original_key YA es la clave permanente: no vuelve a copiar/borrar (no destruye el original)", async () => {
    const id = seedReserved({
      status: "failed",
      failure_code: "processing_failed",
      private_original_key: `objects/cosplay/${"asset-1"}/original.jpg`,
      processing_attempts: 1,
    });
    const res = makeRes();
    await handleMediaComplete(makeReq({ assetId: id }), res);

    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].status).toBe("ready");
    expect(r2Mocks.copyPrivateObject).not.toHaveBeenCalled();
    expect(r2Mocks.deletePrivateObject).toHaveBeenCalledTimes(1);
    // La única llamada a deletePrivateObject es la del original DESPUÉS de confirmar ready —
    // nunca la del paso de copia (que en este escenario ni siquiera debe ejecutarse).
    expect(r2Mocks.deletePrivateObject).toHaveBeenCalledWith(
      `objects/cosplay/${id}/original.jpg`,
    );
  });
});

describe("handleMediaAbort — limpieza segura, nunca por clave arbitraria del cliente", () => {
  it("assetId inexistente: 404", async () => {
    const res = makeRes();
    await handleMediaAbort(makeReq({ assetId: "no-existe" }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("aborta una reserva en curso: borra la fila y el objeto privado, ignora cualquier clave que mande el cliente", async () => {
    const id = "asset-2";
    mediaDb.media_assets.push({
      id,
      domain: "cosplay",
      status: "reserved",
      private_original_key: `staging/cosplay/${id}/original.jpg`,
      multipart_upload_id: null,
    });
    const res = makeRes();
    // El cliente intenta colar una clave de objeto distinta: se ignora por completo, el handler
    // solo lee assetId del body.
    await handleMediaAbort(
      makeReq({ assetId: id, objectKey: "objects/cosplay/OTRO-ASSET/original.jpg" }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(r2Mocks.deletePrivateObject).toHaveBeenCalledWith(
      `staging/cosplay/${id}/original.jpg`,
    );
    expect(mediaDb.media_assets).toHaveLength(0);
  });

  it("aborta una subida multipart en curso: llama a abortPrivateMultipartUpload con el uploadId real", async () => {
    const id = "asset-3";
    mediaDb.media_assets.push({
      id,
      domain: "cosplay",
      status: "uploaded",
      private_original_key: `staging/cosplay/${id}/original.heic`,
      multipart_upload_id: "upload-xyz",
    });
    const res = makeRes();
    await handleMediaAbort(makeReq({ assetId: id }), res);
    expect(r2Mocks.abortPrivateMultipartUpload).toHaveBeenCalledWith(
      `staging/cosplay/${id}/original.heic`,
      "upload-xyz",
    );
  });

  it("un asset ya 'ready' no se puede abortar (eso es borrado, no aborto): 409", async () => {
    const id = "asset-4";
    mediaDb.media_assets.push({
      id,
      domain: "cosplay",
      status: "ready",
      private_original_key: null,
      multipart_upload_id: null,
    });
    const res = makeRes();
    await handleMediaAbort(makeReq({ assetId: id }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(mediaDb.media_assets).toHaveLength(1);
  });
});

describe("domain='community' (9J-1C): autenticado + perfil existente, nunca cosplay_admin/MFA", () => {
  const COMMUNITY_USER = "community-user-1";

  beforeEach(() => {
    // Estos tests representan a un usuario NORMAL (sin fila en admin_roles): requireCapability
    // rechazaría cosplay_admin para él, así que si algún camino de reserva/complete/abort lo
    // desviara por error hacia authorize() (el gate de Cosplay), fallaría — reforzando que
    // domain='community' nunca pasa por ahí.
    requireCapabilityMock.mockRejectedValue(new AdminAuthError("No autorizado", 403));
    requireAuthenticatedMock.mockResolvedValue({
      userId: COMMUNITY_USER,
      aal: "aal1",
      mfaVerifiedAt: null,
    });
  });

  it("reserve: sin perfil de Comunidad → 422 profile_required, sin fila creada", async () => {
    const res = makeRes();
    await handleMediaReserve(
      makeReq({ domain: "community", sourceMime: "image/jpeg", sourceBytes: 1000 }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "profile_required" }),
    );
    expect(mediaDb.media_assets).toHaveLength(0);
  });

  it("reserve: sin sesión → 401 (nunca se llega a consultar profiles)", async () => {
    requireAuthenticatedMock.mockRejectedValue(new AdminAuthError("No autenticado", 401));
    const res = makeRes();
    await handleMediaReserve(
      makeReq({ domain: "community", sourceMime: "image/jpeg", sourceBytes: 1000 }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mediaDb.media_assets).toHaveLength(0);
  });

  it("reserve: CON perfil de Comunidad → 200, fila creada con domain='community' y created_by del JWT, SIN MFA/cosplay_admin", async () => {
    mediaDb.profiles.push({ user_id: COMMUNITY_USER });
    const res = makeRes();
    await handleMediaReserve(
      makeReq({ domain: "community", sourceMime: "image/jpeg", sourceBytes: 1000 }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mediaDb.media_assets).toHaveLength(1);
    expect(mediaDb.media_assets[0]).toMatchObject({
      domain: "community",
      kind: "image",
      created_by: COMMUNITY_USER,
    });
  });

  it("complete: un usuario nunca puede completar la reserva de OTRO (404 genérico, igual que inexistente)", async () => {
    mediaDb.media_assets.push({
      id: "asset-community-1",
      domain: "community",
      status: "reserved",
      source_mime: "image/jpeg",
      source_bytes: 1000,
      private_original_key: "staging/community/asset-community-1/original.jpg",
      multipart_upload_id: null,
      processing_attempts: 0,
      created_by: "otro-usuario",
    });
    const res = makeRes();
    await handleMediaComplete(makeReq({ assetId: "asset-community-1" }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("abort: el dueño SÍ puede abortar su propia reserva de Comunidad, sin cosplay_admin ni MFA", async () => {
    mediaDb.media_assets.push({
      id: "asset-community-2",
      domain: "community",
      status: "reserved",
      private_original_key: "staging/community/asset-community-2/original.jpg",
      multipart_upload_id: null,
      created_by: COMMUNITY_USER,
    });
    const res = makeRes();
    await handleMediaAbort(makeReq({ assetId: "asset-community-2" }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mediaDb.media_assets).toHaveLength(0);
  });

  it("abort: otro usuario no puede abortar una reserva de Comunidad ajena (404, la fila sobrevive)", async () => {
    mediaDb.media_assets.push({
      id: "asset-community-3",
      domain: "community",
      status: "reserved",
      private_original_key: "staging/community/asset-community-3/original.jpg",
      multipart_upload_id: null,
      created_by: "otro-usuario",
    });
    const res = makeRes();
    await handleMediaAbort(makeReq({ assetId: "asset-community-3" }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mediaDb.media_assets).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// Vídeo (Fase 9J-3): SOLO domain='community', SIN transcodificación — "procesar" un vídeo es
// copiar private→public en R2 (copyPrivateObjectToPublic), nunca processImage.

describe("kind='video' (9J-3): solo domain='community', sin processImage", () => {
  const COMMUNITY_USER = "community-video-user";

  beforeEach(() => {
    requireCapabilityMock.mockRejectedValue(new AdminAuthError("No autorizado", 403));
    requireAuthenticatedMock.mockResolvedValue({
      userId: COMMUNITY_USER,
      aal: "aal1",
      mfaVerifiedAt: null,
    });
    mediaDb.profiles.push({ user_id: COMMUNITY_USER });
  });

  it("reserve: domain='cosplay' + kind='video' se rechaza ANTES de validar mime/bytes (invalid_kind, domain spoofing)", async () => {
    requireCapabilityMock.mockResolvedValue({
      userId: "admin-user-1",
      role: "admin",
      capabilities: ["cosplay_admin"],
    });
    const res = makeRes();
    await handleMediaReserve(
      makeReq({
        domain: "cosplay",
        kind: "video",
        sourceMime: "video/mp4",
        sourceBytes: 5_000_000,
        sourceWidth: 1280,
        sourceHeight: 720,
      }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "invalid_kind" }),
    );
    expect(mediaDb.media_assets).toHaveLength(0);
  });

  it("reserve: domain='community' + kind='video' con MP4/dimensiones válidas → 200, fila kind='video'", async () => {
    const res = makeRes();
    await handleMediaReserve(
      makeReq({
        domain: "community",
        kind: "video",
        sourceMime: "video/mp4",
        sourceBytes: 5_000_000,
        sourceWidth: 1280,
        sourceHeight: 720,
        sourceDurationSeconds: 8.2,
      }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mediaDb.media_assets).toHaveLength(1);
    expect(mediaDb.media_assets[0]).toMatchObject({
      domain: "community",
      kind: "video",
      source_mime: "video/mp4",
      duration_seconds: 8.2,
      pipeline_version: "video-v1",
    });
  });

  it("reserve: vídeo de >100 MB se rechaza (too_large), sin fila creada", async () => {
    const res = makeRes();
    await handleMediaReserve(
      makeReq({
        domain: "community",
        kind: "video",
        sourceMime: "video/mp4",
        sourceBytes: 100 * 1024 * 1024 + 1,
        sourceWidth: 1280,
        sourceHeight: 720,
      }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "too_large" }));
    expect(mediaDb.media_assets).toHaveLength(0);
  });

  it("reserve: vídeo sin dimensiones se rechaza (invalid_dimensions) — el servidor nunca las decodifica", async () => {
    const res = makeRes();
    await handleMediaReserve(
      makeReq({
        domain: "community",
        kind: "video",
        sourceMime: "video/mp4",
        sourceBytes: 5_000_000,
      }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "invalid_dimensions" }),
    );
  });

  it("complete: un vídeo listo copia private→public (copyPrivateObjectToPublic), NUNCA llama a processImage, y termina 'ready' con storage_key/mime/dimensiones del ORIGINAL", async () => {
    mediaDb.media_assets.push({
      id: "asset-video-1",
      domain: "community",
      kind: "video",
      status: "reserved",
      source_mime: "video/mp4",
      source_bytes: 5_000_000,
      source_width: 1280,
      source_height: 720,
      duration_seconds: 8.2,
      private_original_key: "staging/community/asset-video-1/original.mp4",
      multipart_upload_id: null,
      processing_attempts: 0,
      created_by: COMMUNITY_USER,
    });
    r2Mocks.headPrivateObject.mockResolvedValue({
      bytes: 5_000_000,
      contentType: "video/mp4",
    });

    const res = makeRes();
    await handleMediaComplete(makeReq({ assetId: "asset-video-1" }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ready",
        kind: "video",
        width: 1280,
        height: 720,
        bytes: 5_000_000,
        durationSeconds: 8.2,
      }),
    );
    expect(processImageMock).not.toHaveBeenCalled();
    expect(r2Mocks.copyPrivateObjectToPublic).toHaveBeenCalledTimes(1);
    expect(r2Mocks.copyPrivateObjectToPublic).toHaveBeenCalledWith(
      expect.stringContaining("objects/community/asset-video-1/original.mp4"),
      "community/asset-video-1/original.mp4",
      "video/mp4",
    );
    expect(r2Mocks.putPublicVariant).not.toHaveBeenCalled();

    const finalRow = mediaDb.media_assets.find((r) => r.id === "asset-video-1");
    expect(finalRow).toMatchObject({
      status: "ready",
      mime: "video/mp4",
      width: 1280,
      height: 720,
      bytes: 5_000_000,
      storage_key: "community/asset-video-1/original.mp4",
      private_original_key: null,
    });
    // media_asset_variants es EXCLUSIVO de imagen (4 tamaños WebP): un vídeo nunca genera filas ahí.
    expect(mediaDb.media_asset_variants).toHaveLength(0);
  });

  it("complete: si copyPrivateObjectToPublic falla, el asset termina 'failed' con processing_failed (nunca 'ready' a medias)", async () => {
    mediaDb.media_assets.push({
      id: "asset-video-2",
      domain: "community",
      kind: "video",
      status: "reserved",
      source_mime: "video/webm",
      source_bytes: 2_000_000,
      source_width: 640,
      source_height: 360,
      duration_seconds: null,
      private_original_key: "staging/community/asset-video-2/original.webm",
      multipart_upload_id: null,
      processing_attempts: 0,
      created_by: COMMUNITY_USER,
    });
    r2Mocks.headPrivateObject.mockResolvedValue({
      bytes: 2_000_000,
      contentType: "video/webm",
    });
    r2Mocks.copyPrivateObjectToPublic.mockRejectedValueOnce(new Error("R2 caído"));

    const res = makeRes();
    await handleMediaComplete(makeReq({ assetId: "asset-video-2" }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", failureCode: "processing_failed" }),
    );
    const finalRow = mediaDb.media_assets.find((r) => r.id === "asset-video-2");
    expect(finalRow?.status).toBe("failed");
    expect(finalRow?.failure_code).toBe("processing_failed");
  });

  it("complete: reintento idempotente de un vídeo YA ready relee media_assets directamente (sin variantes)", async () => {
    mediaDb.media_assets.push({
      id: "asset-video-3",
      domain: "community",
      kind: "video",
      status: "ready",
      mime: "video/mp4",
      width: 1920,
      height: 1080,
      bytes: 9_000_000,
      duration_seconds: 30,
      storage_key: "community/asset-video-3/original.mp4",
      created_by: COMMUNITY_USER,
    });
    const res = makeRes();
    await handleMediaComplete(makeReq({ assetId: "asset-video-3" }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ready",
        kind: "video",
        width: 1920,
        height: 1080,
        durationSeconds: 30,
      }),
    );
  });
});
