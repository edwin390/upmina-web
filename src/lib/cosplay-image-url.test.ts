import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cosplayDb, fakeCreateClient, resetCosplayDb } from "./cosplay-supabase-fake";
import { resetR2DevConfigCache } from "./r2-client";

// Fix del URL público de imagen (Fase 9I-3, sección 3): 9I-1 dejó un placeholder deliberado
// (/cosplay-media/<storageKey>, ver el comentario que este archivo reemplaza) que 9I-2 nunca
// llegó a sustituir. Este archivo prueba EXACTAMENTE el contrato pedido: el placeholder ya no se
// usa, se devuelve la variante pública canónica real (mismo constructor que el pipeline de
// medios, publicVariantUrl — nunca un segundo sistema de URLs), y el fallo cierra en falso
// (Production sin infraestructura, o DEV mal configurado) en vez de servir cualquier URL.

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => fakeCreateClient(...args),
}));

const { handleCosplayList, handleCosplayPost } = await import("./cosplay-handlers");

function mockRes() {
  const state: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return res;
    },
  };
  return { res: res as unknown as VercelResponse, state };
}

function req(method: string, query: Record<string, string> = {}): VercelRequest {
  return { method, query } as unknown as VercelRequest;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    slug: "kirito-sao",
    status: "published",
    title_es: "Kirito",
    title_en: null,
    title_de: null,
    description_es: null,
    description_en: null,
    description_de: null,
    character_name: null,
    series: null,
    event: null,
    shot_on: null,
    photographer_credit: null,
    published_at: "2026-03-02T10:00:00.000Z",
    version: 1,
    cosplay_post_images: [
      {
        id: "img-1",
        position: 0,
        is_cover: true,
        decorative: false,
        alt_es: "Kirito con espada",
        alt_en: null,
        alt_de: null,
        caption_es: null,
        caption_en: null,
        caption_de: null,
        media_assets: {
          id: "asset-1",
          status: "ready",
          width: 1600,
          height: 2400,
          storage_key: "cosplay/asset-1/w1600.webp",
        },
      },
    ],
    ...overrides,
  };
}

function stubDevR2Env() {
  vi.stubEnv("R2_DEV_ACCESS_KEY_ID", "test-access-key-id");
  vi.stubEnv("R2_DEV_SECRET_ACCESS_KEY", "test-secret-access-key");
  vi.stubEnv("R2_DEV_ENDPOINT", "https://test-account.r2.cloudflarestorage.com");
  vi.stubEnv("R2_DEV_PRIVATE_BUCKET", "upmina-media-dev-private");
  vi.stubEnv("R2_DEV_PUBLIC_BUCKET", "upmina-media-dev-public");
  vi.stubEnv("R2_DEV_PUBLIC_BASE_URL", "https://pub-test.r2.dev");
}

beforeEach(() => {
  resetCosplayDb();
  vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetR2DevConfigCache();
});

describe("URL pública de imagen — variante canónica real, nunca el placeholder", () => {
  it("handleCosplayList devuelve la URL pública canónica de r2-client, no /cosplay-media/*", async () => {
    stubDevR2Env();
    cosplayDb.rows = [row()];
    const { res, state } = mockRes();
    await handleCosplayList(req("GET"), res);

    expect(state.status).toBe(200);
    const body = state.body as { items: { cover: { url: string } | null }[] };
    const url = body.items[0]?.cover?.url;
    expect(url).toBe("https://pub-test.r2.dev/cosplay/asset-1/w1600.webp");
    expect(url).not.toMatch(/^\/cosplay-media\//);
  });

  it("handleCosplayPost devuelve la misma URL pública canónica en la galería del detalle", async () => {
    stubDevR2Env();
    cosplayDb.rows = [row()];
    const { res, state } = mockRes();
    await handleCosplayPost(req("GET", { slug: "kirito-sao" }), res);

    expect(state.status).toBe(200);
    const body = state.body as { gallery: { url: string }[] };
    expect(body.gallery[0]?.url).toBe(
      "https://pub-test.r2.dev/cosplay/asset-1/w1600.webp",
    );
  });

  it("nunca construye la URL a partir de private_original_key: solo storage_key (variante pública) llega al mapeo", async () => {
    stubDevR2Env();
    // La fila cruda ni siquiera SELECCIONA private_original_key (ver SELECT_WITH_IMAGES en
    // cosplay-handlers.ts) — este test confirma que, aunque una fila trajera esa clave por
    // error, el mapeo público solo usa storage_key.
    cosplayDb.rows = [
      row({
        cosplay_post_images: [
          {
            id: "img-1",
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
              id: "asset-1",
              status: "ready",
              width: 100,
              height: 100,
              storage_key: "cosplay/asset-1/w480.webp",
              // Un original privado NUNCA debe filtrarse aunque esté presente en la fila cruda.
              private_original_key: "objects/cosplay/asset-1/original.jpg",
            },
          },
        ],
      }),
    ];
    const { res, state } = mockRes();
    await handleCosplayPost(req("GET", { slug: "kirito-sao" }), res);
    const body = state.body as { gallery: { url: string }[] };
    expect(body.gallery[0]?.url).not.toContain("original");
    expect(body.gallery[0]?.url).toBe(
      "https://pub-test.r2.dev/cosplay/asset-1/w480.webp",
    );
  });

  it("Production (sin infraestructura R2 de Production): falla cerrado con 500 genérico, nunca sirve una URL", async () => {
    stubDevR2Env();
    vi.stubEnv("VERCEL_ENV", "production");
    cosplayDb.rows = [row()];
    const { res, state } = mockRes();
    await handleCosplayList(req("GET"), res);

    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
    expect(JSON.stringify(state.body)).not.toContain("r2.dev");
  });

  it("DEV mal configurado (falta una variable requerida): falla cerrado con 500 genérico, nunca un placeholder", async () => {
    // Ninguna variable R2_DEV_* configurada en absoluto.
    cosplayDb.rows = [row()];
    const { res, state } = mockRes();
    await handleCosplayPost(req("GET", { slug: "kirito-sao" }), res);

    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: "Error interno" });
  });
});
