import { beforeEach, describe, expect, it, vi } from "vitest";

// Primitivas de ciclo de vida de medios de Cosplay (Fase 9I-3, checkpoint 2). Supabase y R2 SIEMPRE
// mockeados: nunca golpea infraestructura real (eso ya se verificó con Postgres real en el harness
// desechable). Aquí solo importa: la lógica de decisión (qué es huérfano/limpiable) y que un fallo
// de R2 nunca borra la fila de media_assets sin confirmar.

const deletePublicVariantsMock = vi.fn();
const deletePrivateObjectMock = vi.fn();
vi.mock("./r2-client", () => ({
  deletePublicVariants: (...args: unknown[]) => deletePublicVariantsMock(...args),
  deletePrivateObject: (...args: unknown[]) => deletePrivateObjectMock(...args),
}));

const fake = vi.hoisted(() => ({
  mediaAssets: new Map<string, Record<string, unknown>>(),
  variants: new Map<string, { storage_key: string }[]>(),
  attachedAssetIds: new Set<string>(),
  deletedAssetIds: [] as string[],
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      if (table === "media_assets") {
        const builder: Record<string, unknown> = {
          filters: {} as Record<string, unknown>,
          eq(col: string, v: unknown) {
            (builder.filters as Record<string, unknown>)[col] = v;
            return builder;
          },
          async maybeSingle() {
            const id = (builder.filters as Record<string, unknown>).id as string;
            const row = fake.mediaAssets.get(id);
            return { data: row ?? null, error: null };
          },
          select() {
            return builder;
          },
          update(patch: Record<string, unknown>) {
            const updateBuilder: Record<string, unknown> = {
              filters: {} as Record<string, unknown>,
              eq(col: string, v: unknown) {
                (updateBuilder.filters as Record<string, unknown>)[col] = v;
                return updateBuilder;
              },
              async select() {
                const f = updateBuilder.filters as Record<string, string>;
                const row = fake.mediaAssets.get(f.id);
                if (!row) return { data: [], error: null };
                for (const [k, v] of Object.entries(f)) {
                  if (k !== "id" && row[k] !== v) return { data: [], error: null };
                }
                Object.assign(row, patch);
                return { data: [{ id: f.id }], error: null };
              },
            };
            return updateBuilder;
          },
          delete() {
            const deleteBuilder: Record<string, unknown> = {
              filters: {} as Record<string, unknown>,
              eq(col: string, v: unknown) {
                (deleteBuilder.filters as Record<string, unknown>)[col] = v;
                return deleteBuilder;
              },
              then(resolve: (v: unknown) => unknown) {
                const f = deleteBuilder.filters as Record<string, string>;
                const row = fake.mediaAssets.get(f.id);
                if (row && (!f.status || row.status === f.status)) {
                  fake.mediaAssets.delete(f.id);
                  fake.deletedAssetIds.push(f.id);
                }
                return Promise.resolve({ error: null }).then(resolve);
              },
            };
            return deleteBuilder;
          },
          in(col: string, values: string[]) {
            (builder.filters as Record<string, unknown>)[col] = values;
            return builder;
          },
          then(resolve: (v: unknown) => unknown) {
            const f = builder.filters as Record<string, unknown>;
            let rows: Record<string, unknown>[] = [...fake.mediaAssets.entries()].map(
              ([id, r]) => ({ id, ...r }),
            );
            if (f.domain) rows = rows.filter((r) => r.domain === f.domain);
            if (f.status) rows = rows.filter((r) => r.status === f.status);
            if (f.created_by) rows = rows.filter((r) => r.created_by === f.created_by);
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          },
        };
        return builder;
      }
      if (table === "media_asset_variants") {
        const builder: Record<string, unknown> = {
          filters: {} as Record<string, unknown>,
          eq(col: string, v: unknown) {
            (builder.filters as Record<string, unknown>)[col] = v;
            return builder;
          },
          select() {
            return builder;
          },
          then(resolve: (v: unknown) => unknown) {
            const assetId = (builder.filters as Record<string, unknown>)
              .asset_id as string;
            return Promise.resolve({
              data: fake.variants.get(assetId) ?? [],
              error: null,
            }).then(resolve);
          },
        };
        return builder;
      }
      if (table === "cosplay_post_images") {
        const builder: Record<string, unknown> = {
          filters: {} as Record<string, unknown>,
          eq(col: string, v: unknown) {
            (builder.filters as Record<string, unknown>)[col] = v;
            return builder;
          },
          select() {
            return builder;
          },
          in(col: string, values: string[]) {
            (builder.filters as Record<string, unknown>)[col] = values;
            return builder;
          },
          async maybeSingle() {
            const assetId = (builder.filters as Record<string, unknown>)
              .asset_id as string;
            return {
              data: fake.attachedAssetIds.has(assetId) ? { id: "img-1" } : null,
              error: null,
            };
          },
          then(resolve: (v: unknown) => unknown) {
            const f = builder.filters as Record<string, unknown>;
            const ids = (f.asset_id as string[] | undefined) ?? [];
            const rows = ids
              .filter((id) => fake.attachedAssetIds.has(id))
              .map((id) => ({ asset_id: id }));
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          },
        };
        return builder;
      }
      throw new Error(`tabla inesperada: ${table}`);
    },
  }),
}));

const {
  attemptMediaAssetCleanup,
  findOrphanedReadyCosplayAssets,
  transitionOrphanToDeleting,
} = await import("./cosplay-media-lifecycle");

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-ficticia");
  fake.mediaAssets.clear();
  fake.variants.clear();
  fake.attachedAssetIds.clear();
  fake.deletedAssetIds = [];
  deletePublicVariantsMock.mockReset().mockResolvedValue(undefined);
  deletePrivateObjectMock.mockReset().mockResolvedValue(undefined);
});

const A1 = "0a000000-0000-4000-8000-000000000001";
const A2 = "0a000000-0000-4000-8000-000000000002";
const A3 = "0a000000-0000-4000-8000-000000000003";
const A4 = "0a000000-0000-4000-8000-000000000004";
const A5 = "0a000000-0000-4000-8000-000000000005";
const VIDEO = "0a000000-0000-4000-8000-000000000006";
const FOREIGN = "0a000000-0000-4000-8000-0000000000ff";

describe("attemptMediaAssetCleanup", () => {
  it("limpia variantes públicas + original privado y borra la fila SOLO tras confirmar ambos", async () => {
    fake.mediaAssets.set(A1, {
      id: A1,
      status: "deleting",
      domain: "cosplay",
      storage_key: `cosplay/${A1}/w960.webp`,
      private_original_key: `objects/cosplay/${A1}/original.jpg`,
    });
    fake.variants.set(A1, [
      { storage_key: `cosplay/${A1}/w480.webp` },
      { storage_key: `cosplay/${A1}/w960.webp` },
    ]);

    const result = await attemptMediaAssetCleanup(A1);

    expect(result).toEqual({ assetId: A1, cleaned: true });
    expect(deletePublicVariantsMock).toHaveBeenCalledWith([
      `cosplay/${A1}/w480.webp`,
      `cosplay/${A1}/w960.webp`,
    ]);
    expect(deletePrivateObjectMock).toHaveBeenCalledWith(
      `objects/cosplay/${A1}/original.jpg`,
    );
    expect(fake.mediaAssets.has(A1)).toBe(false);
  });

  it("sin original privado residual: no intenta borrarlo, pero sí limpia variantes", async () => {
    fake.mediaAssets.set(A2, {
      id: A2,
      status: "deleting",
      domain: "cosplay",
      storage_key: null,
      private_original_key: null,
    });
    fake.variants.set(A2, [{ storage_key: `cosplay/${A2}/w480.webp` }]);

    const result = await attemptMediaAssetCleanup(A2);

    expect(result.cleaned).toBe(true);
    expect(deletePrivateObjectMock).not.toHaveBeenCalled();
  });

  it("si el borrado de variantes públicas falla: NUNCA borra la fila, deja 'deleting' para reintento", async () => {
    fake.mediaAssets.set(A3, {
      id: A3,
      status: "deleting",
      domain: "cosplay",
      storage_key: null,
      private_original_key: null,
    });
    fake.variants.set(A3, [{ storage_key: `cosplay/${A3}/w480.webp` }]);
    deletePublicVariantsMock.mockRejectedValue(new Error("R2 caído"));

    const result = await attemptMediaAssetCleanup(A3);

    expect(result).toEqual({ assetId: A3, cleaned: false });
    expect(fake.mediaAssets.has(A3)).toBe(true);
    expect(fake.mediaAssets.get(A3)!.status).toBe("deleting");
  });

  it("R4-E2: un DeleteObjects con errores parciales (error por clave) NO borra la fila", async () => {
    fake.mediaAssets.set(A3, {
      id: A3,
      status: "deleting",
      domain: "cosplay",
      storage_key: null,
      private_original_key: null,
    });
    fake.variants.set(A3, [{ storage_key: `cosplay/${A3}/w480.webp` }]);
    deletePublicVariantsMock.mockRejectedValue(
      Object.assign(new Error("partial"), { name: "R2PartialDeleteError" }),
    );
    expect((await attemptMediaAssetCleanup(A3)).cleaned).toBe(false);
    expect(fake.mediaAssets.has(A3)).toBe(true);
  });

  it("R4-E2 VÍDEO: el objeto público es storage_key (sin variantes) y se elimina", async () => {
    fake.mediaAssets.set(VIDEO, {
      id: VIDEO,
      status: "deleting",
      domain: "community",
      storage_key: `community/${VIDEO}/original.mp4`,
      private_original_key: null,
    });
    const result = await attemptMediaAssetCleanup(VIDEO);
    expect(result.cleaned).toBe(true);
    expect(deletePublicVariantsMock).toHaveBeenCalledWith([
      `community/${VIDEO}/original.mp4`,
    ]);
    expect(fake.mediaAssets.has(VIDEO)).toBe(false);
  });

  it("R4-E2: una clave que no pertenece al asset aborta TODO el borrado (nada se elimina)", async () => {
    fake.mediaAssets.set(A5, {
      id: A5,
      status: "deleting",
      domain: "community",
      storage_key: `community/${A5}/w960.webp`,
      private_original_key: `objects/community/${FOREIGN}/original.png`,
    });
    fake.variants.set(A5, [{ storage_key: `community/${A5}/w480.webp` }]);
    const result = await attemptMediaAssetCleanup(A5);
    expect(result.cleaned).toBe(false);
    expect(deletePublicVariantsMock).not.toHaveBeenCalled();
    expect(deletePrivateObjectMock).not.toHaveBeenCalled();
    expect(fake.mediaAssets.has(A5)).toBe(true);
  });

  it("un reintento posterior (misma llamada) SÍ completa la limpieza si R2 ya responde", async () => {
    fake.mediaAssets.set(A4, {
      id: A4,
      status: "deleting",
      domain: "cosplay",
      storage_key: null,
      private_original_key: null,
    });
    fake.variants.set(A4, [{ storage_key: `cosplay/${A4}/w480.webp` }]);
    deletePublicVariantsMock
      .mockRejectedValueOnce(new Error("caído"))
      .mockResolvedValue(undefined);

    const first = await attemptMediaAssetCleanup(A4);
    expect(first.cleaned).toBe(false);

    const second = await attemptMediaAssetCleanup(A4);
    expect(second.cleaned).toBe(true);
    expect(fake.mediaAssets.has(A4)).toBe(false);
  });

  it("un asset que no está 'deleting' (p. ej. todavía 'ready') nunca se toca", async () => {
    fake.mediaAssets.set(A5, {
      id: A5,
      status: "ready",
      domain: "cosplay",
      storage_key: null,
      private_original_key: null,
    });
    const result = await attemptMediaAssetCleanup(A5);
    expect(result.cleaned).toBe(false);
    expect(deletePublicVariantsMock).not.toHaveBeenCalled();
    expect(fake.mediaAssets.has(A5)).toBe(true);
  });

  it("un asset inexistente: cleaned false, sin lanzar", async () => {
    const result = await attemptMediaAssetCleanup("no-existe");
    expect(result).toEqual({ assetId: "no-existe", cleaned: false });
  });
});

describe("findOrphanedReadyCosplayAssets", () => {
  it("un asset ready y SIN fila de galería es elegible", async () => {
    fake.mediaAssets.set("orphan-1", {
      domain: "cosplay",
      status: "ready",
      created_at: "2026-01-01T00:00:00Z",
    });
    const result = await findOrphanedReadyCosplayAssets();
    expect(result).toEqual([{ assetId: "orphan-1", createdAt: "2026-01-01T00:00:00Z" }]);
  });

  it("un asset ready pero YA adjunto a una publicación queda excluido", async () => {
    fake.mediaAssets.set("attached-1", {
      domain: "cosplay",
      status: "ready",
      created_at: "2026-01-01T00:00:00Z",
    });
    fake.attachedAssetIds.add("attached-1");
    const result = await findOrphanedReadyCosplayAssets();
    expect(result).toEqual([]);
  });

  it("un asset todavía 'processing' (no ready) nunca es candidato", async () => {
    fake.mediaAssets.set("processing-1", {
      domain: "cosplay",
      status: "processing",
      created_at: "2026-01-01T00:00:00Z",
    });
    const result = await findOrphanedReadyCosplayAssets();
    expect(result).toEqual([]);
  });

  it("filtro por createdBy: solo assets de ese propietario", async () => {
    fake.mediaAssets.set("mine", {
      domain: "cosplay",
      status: "ready",
      created_at: "2026-01-01T00:00:00Z",
      created_by: "admin-1",
    });
    fake.mediaAssets.set("other", {
      domain: "cosplay",
      status: "ready",
      created_at: "2026-01-01T00:00:00Z",
      created_by: "admin-2",
    });
    const result = await findOrphanedReadyCosplayAssets({ createdBy: "admin-1" });
    expect(result.map((r) => r.assetId)).toEqual(["mine"]);
  });
});

describe("transitionOrphanToDeleting", () => {
  it("un huérfano ready elegible transiciona a 'deleting'", async () => {
    fake.mediaAssets.set("orphan-2", { domain: "cosplay", status: "ready" });
    const ok = await transitionOrphanToDeleting("orphan-2");
    expect(ok).toBe(true);
    expect(fake.mediaAssets.get("orphan-2")!.status).toBe("deleting");
  });

  it("un asset YA adjunto nunca transiciona, aunque esté ready", async () => {
    fake.mediaAssets.set("attached-2", { domain: "cosplay", status: "ready" });
    fake.attachedAssetIds.add("attached-2");
    const ok = await transitionOrphanToDeleting("attached-2");
    expect(ok).toBe(false);
    expect(fake.mediaAssets.get("attached-2")!.status).toBe("ready");
  });

  it("un asset que ya no está 'ready' (p. ej. otro proceso lo cambió) no transiciona", async () => {
    fake.mediaAssets.set("already-deleting", { domain: "cosplay", status: "deleting" });
    const ok = await transitionOrphanToDeleting("already-deleting");
    expect(ok).toBe(false);
  });
});
