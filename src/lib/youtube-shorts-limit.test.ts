import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import videosHandler from "../../api/youtube-videos";
import { YOUTUBE_SHORTS_LIMIT, YOUTUBE_VIDEOS_LIMIT } from "@/hooks/useYouTubeVideos";
import {
  MAX_UPLOAD_PAGES,
  UPLOADS_PAGE_SIZE,
  resetYouTubeCacheForTests,
} from "./youtube-shared";

// Trabajo acotado del listado de Shorts (9H-2.5): con un límite de 24 la búsqueda se detiene en
// cuanto hay suficientes, nunca recorre más de MAX_UPLOAD_PAGES páginas y devuelve menos si no hay
// más. Google simulado y determinista: sin red ni cuota real.

const API_KEY = "AIzaSy-clave-sintetica-de-prueba";
const CHANNEL_ID = "UCcanal-de-prueba";

type Kind = "S" | "V";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Uploads del canal, del más nuevo al más antiguo. `S` = Short (20 s), `V` = video (8 min). */
function uploads(kinds: Kind[]) {
  return kinds.map((kind, i) => ({
    id: `${kind === "S" ? "s" : "v"}${String(i).padStart(4, "0")}`,
    kind,
    publishedAt: new Date(Date.UTC(2026, 8, 25) - i * 3_600_000).toISOString(),
  }));
}

function stubGoogle(all: ReturnType<typeof uploads>) {
  const calls = { channels: 0, playlistItems: 0, videos: 0 };
  const byId = new Map(all.map((u) => [u.id, u]));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const operation = parsed.pathname.split("/").pop();
      if (operation === "channels") {
        calls.channels++;
        return json({
          items: [{ contentDetails: { relatedPlaylists: { uploads: "UUuploads" } } }],
        });
      }
      if (operation === "playlistItems") {
        calls.playlistItems++;
        const size = Number(parsed.searchParams.get("maxResults"));
        const token = parsed.searchParams.get("pageToken");
        const start = token ? Number(token.slice(1)) : 0;
        const slice = all.slice(start, start + size);
        const nextStart = start + size;
        return json({
          items: slice.map((u) => ({
            snippet: {
              resourceId: { videoId: u.id },
              title: `Título ${u.id}`,
              description: "",
              thumbnailUrl: undefined,
              thumbnails: { high: { url: `https://i.ytimg.com/vi/${u.id}/hq.jpg` } },
              publishedAt: u.publishedAt,
            },
          })),
          nextPageToken: nextStart < all.length ? `p${nextStart}` : undefined,
        });
      }
      calls.videos++;
      const ids = (parsed.searchParams.get("id") ?? "").split(",");
      return json({
        items: ids.map((id) => ({
          id,
          contentDetails: { duration: byId.get(id)?.kind === "S" ? "PT20S" : "PT8M" },
        })),
      });
    }),
  );
  return calls;
}

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

const req = (query: Record<string, string>) =>
  ({ method: "GET", query }) as unknown as VercelRequest;

async function shorts(maxResults: string | undefined) {
  const { res, state } = mockRes();
  await videosHandler(
    req(maxResults === undefined ? { type: "shorts" } : { type: "shorts", maxResults }),
    res,
  );
  return state;
}

const originalEnv = { ...process.env };

beforeEach(() => {
  Object.assign(process.env, {
    YOUTUBE_API_KEY: API_KEY,
    YOUTUBE_CHANNEL_ID: CHANNEL_ID,
  });
  resetYouTubeCacheForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetYouTubeCacheForTests();
});

// Patrones de uploads: `S` cada `every` posiciones son Shorts.
const pattern = (total: number, isShort: (i: number) => boolean): Kind[] =>
  Array.from({ length: total }, (_v, i) => (isShort(i) ? "S" : "V"));

describe("límite de Shorts", () => {
  it("el frontend pide 24 Shorts y 12 videos largos", () => {
    expect(YOUTUBE_SHORTS_LIMIT).toBe(24);
    expect(YOUTUBE_VIDEOS_LIMIT).toBe(12);
  });

  it("maxResults=24: devuelve 24 Shorts, del más nuevo al más antiguo", async () => {
    // 60 uploads, 5 de cada 6 son Shorts: 24 caben en la primera página.
    const all = uploads(pattern(60, (i) => i % 6 !== 5));
    stubGoogle(all);

    const state = await shorts("24");

    expect(state.status).toBe(200);
    const body = state.body as { id: string; publishedAt: string }[];
    expect(body).toHaveLength(24);
    expect(body.every((v) => v.id.startsWith("s"))).toBe(true);
    const dates = body.map((v) => Date.parse(v.publishedAt));
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
    expect(state.headers["Cache-Control"]).toBe(
      "s-maxage=900, stale-while-revalidate=1800",
    );
  });

  it("con maxResults=12 devuelve 12 (el límite lo decide quien pregunta)", async () => {
    stubGoogle(uploads(pattern(60, () => true)));

    expect(((await shorts("12")).body as unknown[]).length).toBe(12);
  });

  it("sin maxResults el valor por defecto sigue siendo 12; nunca más de 50", async () => {
    stubGoogle(uploads(pattern(200, () => true)));

    expect(((await shorts(undefined)).body as unknown[]).length).toBe(12);
    expect(((await shorts("999")).body as unknown[]).length).toBe(50);
  });
});

describe("trabajo del proveedor acotado", () => {
  it("objetivo alcanzado en la primera página: NO se pide otra (1 playlistItems + 1 videos)", async () => {
    const calls = stubGoogle(uploads(pattern(120, () => true)));

    await shorts("24");

    expect(calls).toEqual({ channels: 1, playlistItems: 1, videos: 1 });
  });

  it("si la primera página no basta se pide la siguiente y se detiene al reunir el objetivo", async () => {
    // Primeros 50 uploads: 10 Shorts. Siguientes 50: todos Shorts. → 24 tras la 2.ª página.
    const kinds: Kind[] = [
      ...pattern(50, (i) => i < 10),
      ...pattern(50, () => true),
      ...pattern(100, () => true),
    ];
    const calls = stubGoogle(uploads(kinds));

    const body = (await shorts("24")).body as unknown[];

    expect(body).toHaveLength(24);
    expect(calls.playlistItems).toBe(2);
    expect(calls.videos).toBe(2);
  });

  it("muy pocos Shorts: recorre como máximo MAX_UPLOAD_PAGES páginas y devuelve los que haya", async () => {
    // 5 Shorts repartidos en los primeros 200 uploads; hay 300 en total.
    const kinds = pattern(300, (i) => i % 40 === 0 && i < 200);
    const calls = stubGoogle(uploads(kinds));

    const body = (await shorts("24")).body as unknown[];

    expect(body).toHaveLength(5);
    expect(MAX_UPLOAD_PAGES).toBe(4);
    expect(calls.playlistItems).toBe(MAX_UPLOAD_PAGES);
    expect(calls.videos).toBe(MAX_UPLOAD_PAGES);
    // Peor caso en frío: 1 + 2 × MAX_UPLOAD_PAGES llamadas (= unidades de cuota).
    expect(calls.channels + calls.playlistItems + calls.videos).toBe(
      1 + 2 * MAX_UPLOAD_PAGES,
    );
  });

  it("sin ningún Short: lista vacía tras el mismo límite de páginas, nunca una búsqueda sin fin", async () => {
    const calls = stubGoogle(uploads(pattern(1_000, () => false)));

    const state = await shorts("24");

    expect(state.status).toBe(200);
    expect(state.body).toEqual([]);
    expect(calls.playlistItems).toBe(MAX_UPLOAD_PAGES);
  });

  it("los Shorts fuera del alcance de las 4 páginas no se buscan", async () => {
    // Un solo Short, en el upload 250 (fuera de las 200 primeras).
    const kinds = pattern(300, (i) => i === 250);
    stubGoogle(kinds.length ? uploads(kinds) : []);

    expect((await shorts("24")).body).toEqual([]);
  });

  it("cada página son UPLOADS_PAGE_SIZE uploads: el coste por página no depende del límite", async () => {
    const calls12 = stubGoogle(uploads(pattern(300, (i) => i % 40 === 0)));
    await shorts("12");
    resetYouTubeCacheForTests();
    const calls36 = stubGoogle(uploads(pattern(300, (i) => i % 40 === 0)));
    await shorts("36");

    expect(UPLOADS_PAGE_SIZE).toBe(50);
    expect(calls12.playlistItems).toBe(calls36.playlistItems);
  });
});

describe("heurística, dedupe y orden sin cambios", () => {
  it("clasificación: ≤60 s es Short; 61-180 s solo con #shorts; más de 180 s no", async () => {
    const all = uploads(["V", "V", "V", "V"]);
    const durations: Record<string, string> = {
      [all[0].id]: "PT45S", // Short
      [all[1].id]: "PT2M", // sin etiqueta: video
      [all[2].id]: "PT2M", // con #shorts en el título: Short
      [all[3].id]: "PT5M", // video
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url);
        const op = parsed.pathname.split("/").pop();
        if (op === "channels") {
          return json({
            items: [{ contentDetails: { relatedPlaylists: { uploads: "UUuploads" } } }],
          });
        }
        if (op === "playlistItems") {
          return json({
            items: all.map((u, i) => ({
              snippet: {
                resourceId: { videoId: u.id },
                title: i === 2 ? "Con etiqueta #shorts" : `Título ${i}`,
                description: "",
                thumbnails: {},
                publishedAt: u.publishedAt,
              },
            })),
          });
        }
        return json({
          items: (parsed.searchParams.get("id") ?? "")
            .split(",")
            .map((id) => ({ id, contentDetails: { duration: durations[id] } })),
        });
      }),
    );

    const body = (await shorts("24")).body as { id: string }[];

    expect(body.map((v) => v.id)).toEqual([all[0].id, all[2].id]);
  });

  it("un id repetido entre páginas (upload nuevo que desplaza la paginación) cuenta una sola vez", async () => {
    const base = uploads(pattern(100, () => true));
    // La página 2 empieza repitiendo el último de la 1.
    const all = [...base.slice(0, 50), base[49], ...base.slice(50)];
    stubGoogle(all);

    const body = (await shorts("50")).body as { id: string }[];

    expect(new Set(body.map((v) => v.id)).size).toBe(body.length);
    expect(body).toHaveLength(50);
  });

  it("orden por fecha descendente aunque la página llegue desordenada", async () => {
    const base = uploads(pattern(10, () => true));
    stubGoogle([base[3], base[0], base[2], base[1], ...base.slice(4)]);

    const body = (await shorts("24")).body as { publishedAt: string }[];
    const dates = body.map((v) => Date.parse(v.publishedAt));

    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });
});
