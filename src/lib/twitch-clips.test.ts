import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TwitchClipApiItem } from "../types/api";
import clipsHandler from "../../api/twitch-clips";
import { getRecentClips, MAX_CLIPS, MAX_HELIX_CALLS } from "./twitch-clips";
import { resetTwitchCacheForTests } from "./twitch-shared";

// Helix real: ordena por view_count DESC dentro de la ventana pedida (no por
// fecha). Estos mocks reproducen esa semántica para comprobar que el orden por
// fecha lo impone getRecentClips y no el orden recibido.

const NOW = new Date("2026-09-19T12:00:00.000Z");
const DAY = 86_400_000;

function iso(daysAgo: number, extraMs = 0): string {
  return new Date(NOW.getTime() - daysAgo * DAY - extraMs)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

function clip(
  id: string,
  daysAgo: number,
  viewCount: number,
  extraMs = 0,
): TwitchClipApiItem {
  return {
    id,
    url: `https://www.twitch.tv/canal/clip/${id}`,
    title: `clip ${id}`,
    creator_name: "creador",
    thumbnail_url: `https://cdn/${id}.jpg`,
    view_count: viewCount,
    created_at: iso(daysAgo, extraMs),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface HelixCall {
  startedAt: string;
  endedAt: string;
  after: string | null;
  first: string | null;
}

/**
 * Simula Helix: filtra el catálogo por la ventana [started_at, ended_at] y
 * devuelve los clips por view_count DESC, paginados de `pageSize` en `pageSize`.
 */
function stubHelixCatalog(catalog: TwitchClipApiItem[], pageSize = 100) {
  const calls: HelixCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/oauth2/token")) {
        return jsonResponse({ access_token: "token-de-prueba", expires_in: 3600 });
      }
      if (url.pathname.endsWith("/helix/users")) {
        return jsonResponse({ data: [{ id: "42" }] });
      }
      const startedAt = url.searchParams.get("started_at") ?? "";
      const endedAt = url.searchParams.get("ended_at") ?? "";
      const after = url.searchParams.get("after");
      calls.push({ startedAt, endedAt, after, first: url.searchParams.get("first") });

      // Los clips con fecha ausente/ilegible no se pueden filtrar por ventana:
      // se devuelven siempre, para comprobar que el código los descarta.
      const inWindow = catalog
        .filter(
          (c) =>
            !Number.isFinite(Date.parse(c.created_at)) ||
            (c.created_at >= startedAt && c.created_at <= endedAt),
        )
        .sort((a, b) => b.view_count - a.view_count);
      const offset = after ? Number(after) : 0;
      const data = inWindow.slice(offset, offset + pageSize);
      const hasMore = offset + pageSize < inWindow.length;
      return jsonResponse({
        data,
        pagination: hasMore ? { cursor: String(offset + pageSize) } : {},
      });
    }),
  );
  return calls;
}

const CREDS = {
  TWITCH_CLIENT_ID: "test-client-id",
  TWITCH_CLIENT_SECRET: "test-client-secret",
  TWITCH_CHANNEL: "canal_de_prueba",
};

describe("getRecentClips", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    Object.assign(process.env, CREDS);
    resetTwitchCacheForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    resetTwitchCacheForTests();
  });

  it("ordena por createdAt DESC (más reciente primero)", async () => {
    stubHelixCatalog([
      clip("a", 0.5, 10),
      clip("b", 0.1, 10),
      clip("c", 0.9, 10),
      clip("d", 0.3, 10),
    ]);

    const result = await getRecentClips("42", NOW);

    expect(result.map((c) => c.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("viewCount NO afecta al orden: un clip nuevo con 0 vistas va antes que uno viejo con muchas", async () => {
    stubHelixCatalog([
      clip("viejo-popular", 0.9, 1_000_000),
      clip("medio", 0.5, 500),
      clip("nuevo-sin-vistas", 0.01, 0),
    ]);

    const result = await getRecentClips("42", NOW);

    expect(result.map((c) => c.id)).toEqual([
      "nuevo-sin-vistas",
      "medio",
      "viejo-popular",
    ]);
  });

  it("garantiza fecha descendente en todo el resultado", async () => {
    const catalog = Array.from({ length: 40 }, (_, i) =>
      clip(`c${i}`, ((i * 37) % 100) / 100, (i * 7919) % 1000),
    );
    stubHelixCatalog(catalog);

    const result = await getRecentClips("42", NOW);

    const dates = result.map((c) => Date.parse(c.created_at));
    expect(dates).toEqual([...dates].sort((x, y) => y - x));
  });

  it("devuelve como máximo 12 y son LOS 12 más recientes, no los 12 más vistos", async () => {
    // 30 clips en el último día; los más recientes tienen menos vistas.
    const catalog = Array.from({ length: 30 }, (_, i) =>
      clip(`c${i}`, i / 100, 1000 - i * 10 + (i < 12 ? 0 : 5000)),
    );
    stubHelixCatalog(catalog);

    const result = await getRecentClips("42", NOW);

    expect(result).toHaveLength(MAX_CLIPS);
    expect(result.map((c) => c.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `c${i}`),
    );
  });

  it("respuesta vacía: devuelve [] y no encadena llamadas sin límite", async () => {
    const calls = stubHelixCatalog([]);

    const result = await getRecentClips("42", NOW);

    expect(result).toEqual([]);
    // Una llamada por ventana (11 ventanas), nunca más del límite duro.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThanOrEqual(MAX_HELIX_CALLS);
  });

  it("siempre envía started_at y ended_at (Helix limita a 1 semana si falta ended_at)", async () => {
    const calls = stubHelixCatalog([]);

    await getRecentClips("42", NOW);

    for (const call of calls) {
      expect(call.startedAt).not.toBe("");
      expect(call.endedAt).not.toBe("");
      expect(call.startedAt < call.endedAt).toBe(true);
    }
  });

  it("habitual: si la ventana más reciente (3 h) ya llena 12 clips, no consulta ventanas antiguas", async () => {
    const catalog = [
      ...Array.from({ length: 20 }, (_, i) => clip(`n${i}`, i / 200, 5)),
      clip("antiguo", 200, 999_999),
    ];
    const calls = stubHelixCatalog(catalog);

    const result = await getRecentClips("42", NOW);

    expect(calls).toHaveLength(1);
    expect(result.some((c) => c.id === "antiguo")).toBe(false);
  });

  it("ampliación temporal: si la ventana reciente no llena, amplía y mantiene el orden por fecha", async () => {
    const catalog = [
      clip("h1", 0.05, 1), // 1,2 h → ventana [0,3h]
      clip("h2", 0.2, 1), // 4,8 h → ventana [3h,6h]
      ...Array.from({ length: 5 }, (_, i) => clip(`s${i}`, 1.2 + i * 0.2, 50)), // ventana [1d,3d]
      ...Array.from({ length: 6 }, (_, i) => clip(`m${i}`, 15 + i, 100)), // ventana [7d,30d]
      clip("y1", 120, 9_999_999), // ventana [90d,365d]: no debe entrar
    ];
    const calls = stubHelixCatalog(catalog);

    const result = await getRecentClips("42", NOW);

    expect(result).toHaveLength(12);
    expect(result.map((c) => c.id)).toEqual([
      "h1",
      "h2",
      "s0",
      "s1",
      "s2",
      "s3",
      "s4",
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    // Ventanas contiguas y disjuntas, de lo reciente a lo antiguo, siempre con
    // started_at y ended_at: 3h, 6h, 12h, 24h, 3d, 7d y 30d (7 llamadas).
    const boundaries = [0, 0.125, 0.25, 0.5, 1, 3, 7, 30];
    expect(calls).toHaveLength(7);
    calls.forEach((call, i) => {
      expect(call.endedAt).toBe(iso(boundaries[i]!));
      expect(call.startedAt).toBe(iso(boundaries[i + 1]!));
    });
  });

  it("amplía hasta una ventana lejana cuando el canal casi no tiene clips recientes", async () => {
    stubHelixCatalog([clip("reciente", 2, 1), clip("viejo", 800, 100_000)]);

    const result = await getRecentClips("42", NOW);

    expect(result.map((c) => c.id)).toEqual(["reciente", "viejo"]);
  });

  it("pagina dentro de una ventana y deduplica clips repetidos entre páginas", async () => {
    // 250 clips en las últimas 3 h, pageSize 100 → 3 páginas.
    const catalog = Array.from({ length: 250 }, (_, i) =>
      clip(`p${i}`, (i % 12) / 100, i, i),
    );
    const calls = stubHelixCatalog(catalog);
    // Helix real puede repetir clips entre páginas: simulamos un duplicado.
    const original = globalThis.fetch as unknown as (input: string) => Promise<Response>;
    let servedPages = 0;
    vi.stubGlobal("fetch", async (input: string) => {
      const res = await original(input);
      if (input.includes("clips?") && !input.includes("oauth2")) {
        servedPages++;
        if (servedPages === 2) {
          const body = (await res.clone().json()) as {
            data: TwitchClipApiItem[];
            pagination: object;
          };
          body.data.push(catalog[0]!);
          return jsonResponse(body);
        }
      }
      return res;
    });

    const result = await getRecentClips("42", NOW);

    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(new Set(result.map((c) => c.id)).size).toBe(result.length);
    expect(result).toHaveLength(12);
  });

  it("no hay bucle infinito de paginación: un cursor que nunca termina se corta por los límites", async () => {
    let clipCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/oauth2/token")) {
          return jsonResponse({ access_token: "t", expires_in: 3600 });
        }
        clipCalls++;
        // Siempre devuelve el mismo clip y un cursor nuevo distinto cada vez.
        return jsonResponse({
          data: [clip("unico", 0.1, 1)],
          pagination: { cursor: `cursor-${clipCalls}` },
        });
      }),
    );

    const result = await getRecentClips("42", NOW);

    expect(clipCalls).toBeLessThanOrEqual(MAX_HELIX_CALLS);
    expect(result).toHaveLength(1);
  });

  it("no hay bucle infinito: un cursor repetido detiene la paginación", async () => {
    let clipCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/oauth2/token")) {
          return jsonResponse({ access_token: "t", expires_in: 3600 });
        }
        clipCalls++;
        return jsonResponse({ data: [], pagination: { cursor: "siempre-igual" } });
      }),
    );

    await getRecentClips("42", NOW);

    // 2 llamadas por ventana (la 2ª repite cursor) y tope duro global.
    expect(clipCalls).toBeLessThanOrEqual(MAX_HELIX_CALLS);
  });

  it("descarta clips sin id o sin fecha válida", async () => {
    stubHelixCatalog([
      clip("ok", 0.1, 5),
      { ...clip("sin-fecha", 0.2, 5), created_at: undefined as unknown as string },
      { ...clip("fecha-rota", 0.2, 5), created_at: "no-es-una-fecha" },
      { ...clip("", 0.3, 5) },
    ]);

    const result = await getRecentClips("42", NOW);

    expect(result.map((c) => c.id)).toEqual(["ok"]);
  });

  it("descarta clips no reproducibles (thumbnail_url vacío, en blanco o ausente)", async () => {
    stubHelixCatalog([
      clip("valido", 0.1, 5),
      { ...clip("vacio", 0.11, 5), thumbnail_url: "" },
      { ...clip("blanco", 0.12, 5), thumbnail_url: "   " },
      { ...clip("ausente", 0.13, 5), thumbnail_url: undefined as unknown as string },
    ]);

    const result = await getRecentClips("42", NOW);

    expect(result.map((c) => c.id)).toEqual(["valido"]);
  });

  it("completa hasta 12 con clips válidos de ventanas más antiguas cuando la reciente trae inválidos", async () => {
    // Ventana [0,3h]: 10 válidos + 2 rotos. Los 2 restantes salen de [3h,6h].
    const catalog = [
      ...Array.from({ length: 10 }, (_, i) => clip(`n${i}`, i / 200, 5)),
      { ...clip("roto1", 0.001, 1), thumbnail_url: "" },
      { ...clip("roto2", 0.002, 1), thumbnail_url: "" },
      clip("v1", 0.15, 5), // 3,6 h → ventana [3h,6h]
      clip("v2", 0.16, 5),
      clip("v3", 0.2, 5),
    ];
    stubHelixCatalog(catalog);

    const result = await getRecentClips("42", NOW);

    expect(result).toHaveLength(MAX_CLIPS);
    expect(result.some((c) => c.id.startsWith("roto"))).toBe(false);
    // newest → oldest y sin duplicados
    const dates = result.map((c) => Date.parse(c.created_at));
    expect(dates).toEqual([...dates].sort((x, y) => y - x));
    expect(new Set(result.map((c) => c.id)).size).toBe(result.length);
    expect(result.slice(-2).map((c) => c.id)).toEqual(["v1", "v2"]);
  });

  it("propaga un error de Helix como TwitchApiError 502 (no devuelve datos parciales)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.includes("oauth2/token")) {
          return jsonResponse({ access_token: "t", expires_in: 3600 });
        }
        return jsonResponse({ message: "boom" }, 500);
      }),
    );

    await expect(getRecentClips("42", NOW)).rejects.toMatchObject({ status: 502 });
  });
});

describe("api/twitch-clips", () => {
  const originalEnv = { ...process.env };

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

  beforeEach(() => {
    Object.assign(process.env, CREDS);
    resetTwitchCacheForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTwitchCacheForTests();
  });

  it("devuelve como máximo 12 clips, más recientes primero, con todos los campos", async () => {
    const recent = new Date();
    const catalog = Array.from({ length: 20 }, (_, i) => ({
      ...clip(`c${i}`, 0, 1000 - i),
      created_at: new Date(recent.getTime() - i * 60_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
    }));
    stubHelixCatalog(catalog);
    const { res, state } = mockRes();

    await clipsHandler({ method: "GET" } as VercelRequest, res);

    expect(state.status).toBe(200);
    const body = state.body as Array<Record<string, unknown>>;
    expect(body).toHaveLength(12);
    expect(body.map((c) => c.id)).toEqual(Array.from({ length: 12 }, (_, i) => `c${i}`));
    expect(Object.keys(body[0]!).sort()).toEqual(
      [
        "createdAt",
        "creatorName",
        "embedUrl",
        "id",
        "thumbnailUrl",
        "title",
        "url",
        "viewCount",
      ].sort(),
    );
    expect(body[0]!.embedUrl).toBe("https://clips.twitch.tv/embed?clip=c0");
    expect(state.headers["Cache-Control"]).toContain("s-maxage");
  });

  it("no envía al frontend clips sin thumbnail (no reproducibles)", async () => {
    stubHelixCatalog([
      clip("bueno", 0.1, 5),
      { ...clip("roto", 0.05, 1), thumbnail_url: "" },
    ]);
    const { res, state } = mockRes();

    await clipsHandler({ method: "GET" } as VercelRequest, res);

    expect(state.status).toBe(200);
    expect((state.body as Array<{ id: string }>).map((c) => c.id)).toEqual(["bueno"]);
  });

  it("canal sin clips: 200 con lista vacía", async () => {
    stubHelixCatalog([]);
    const { res, state } = mockRes();

    await clipsHandler({ method: "GET" } as VercelRequest, res);

    expect(state.status).toBe(200);
    expect(state.body).toEqual([]);
  });

  it("campos opcionales ausentes no rompen la respuesta (valores por defecto)", async () => {
    const partial = {
      id: "x1",
      url: "https://www.twitch.tv/c/clip/x1",
      thumbnail_url: "https://cdn/x1.jpg",
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    } as unknown as TwitchClipApiItem;
    stubHelixCatalog([partial]);
    const { res, state } = mockRes();

    await clipsHandler({ method: "GET" } as VercelRequest, res);

    expect(state.status).toBe(200);
    expect((state.body as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: "x1",
      title: "",
      creatorName: "",
      thumbnailUrl: "https://cdn/x1.jpg",
      viewCount: 0,
    });
  });

  it("405 para métodos distintos de GET y 503 sin credenciales", async () => {
    const post = mockRes();
    await clipsHandler({ method: "POST" } as VercelRequest, post.res);
    expect(post.state.status).toBe(405);

    delete process.env.TWITCH_CLIENT_ID;
    delete process.env.TWITCH_CLIENT_SECRET;
    const noCreds = mockRes();
    await clipsHandler({ method: "GET" } as VercelRequest, noCreds.res);
    expect(noCreds.state.status).toBe(503);
  });
});
