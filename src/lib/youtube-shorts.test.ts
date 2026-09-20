import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import videosHandler from "../../api/youtube-videos";
import {
  MAX_UPLOAD_PAGES,
  UPLOADS_PAGE_SIZE,
  classifyYouTubeVideo,
  isoDurationSeconds,
} from "./youtube-shared";

// Separación videos normales / Shorts. La clasificación es una heurística (la
// API de YouTube no expone si un video es un Short): ver youtube-shared.ts.

describe("isoDurationSeconds", () => {
  it.each([
    ["PT45S", 45],
    ["PT1M", 60],
    ["PT8M38S", 518],
    ["PT1H2M3S", 3723],
    ["PT0S", 0],
    ["P0D", 0], // directos/estrenos sin duración
    ["basura", 0],
  ])("%s → %i s", (iso, seconds) => {
    expect(isoDurationSeconds(iso)).toBe(seconds);
  });
});

describe("classifyYouTubeVideo", () => {
  const classify = (durationSeconds: number, title = "Título", description = "") =>
    classifyYouTubeVideo({ durationSeconds, title, description });

  it("video normal: largo (8:38)", () => {
    expect(classify(518)).toBe("video");
  });

  it("Short: hasta 60 s aunque no lleve etiqueta", () => {
    expect(classify(9)).toBe("short");
    expect(classify(60)).toBe("short");
  });

  it("61-180 s: Short solo con #shorts en título o descripción", () => {
    expect(classify(90)).toBe("video");
    expect(classify(90, "Mi baile #Shorts")).toBe("short");
    expect(classify(180, "Título", "descripción #shorts #cosplay")).toBe("short");
  });

  it("más de 3 min es video normal aunque lleve #shorts", () => {
    expect(classify(181, "Vlog #shorts")).toBe("video");
  });

  it("#shorts debe ser la etiqueta completa (no #shortsfeed)", () => {
    expect(classify(90, "Algo #shortsfeed")).toBe("video");
  });

  it("duración 0 (directo o estreno sin duración) es video normal", () => {
    expect(classify(0)).toBe("video");
  });
});

// ---------- Handler ----------

const API_KEY = "AIzaSy-clave-secreta-de-prueba";

type Upload = {
  id: string;
  seconds: number;
  publishedAt?: string;
  title?: string;
  /** true = videos.list no devuelve detalles para este id (borrado/privado). */
  noDetails?: boolean;
};

function iso(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s || (!h && !m) ? `${s}S` : ""}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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

const req = (query: Record<string, string> = {}) =>
  ({ method: "GET", query }) as unknown as VercelRequest;

/**
 * Simula Google con `pages` (cada página es una lista de uploads, del más nuevo
 * al más antiguo) o, si es una función, con páginas generadas sin límite.
 */
function stubUploads(pages: Upload[][] | ((pageIndex: number) => Upload[])) {
  const pageAt = (i: number): Upload[] | undefined =>
    typeof pages === "function" ? pages(i) : pages[i];
  const known = new Map<string, Upload>();

  const fetchMock = vi.fn(async (url: string) => {
    const u = new URL(url);
    const operation = u.pathname.split("/").pop();

    if (operation === "channels") {
      return jsonResponse({
        items: [{ contentDetails: { relatedPlaylists: { uploads: "UUuploads" } } }],
      });
    }

    if (operation === "playlistItems") {
      const index = Number(u.searchParams.get("pageToken")?.replace("p", "") ?? 0);
      const uploads = pageAt(index) ?? [];
      uploads.forEach((upload) => known.set(upload.id, upload));
      return jsonResponse({
        items: uploads.map((upload) => ({
          snippet: {
            resourceId: { videoId: upload.id },
            title: upload.title ?? `Video ${upload.id}`,
            description: "",
            thumbnails: {
              high: { url: `https://i.ytimg.com/vi/${upload.id}/hqdefault.jpg` },
            },
            publishedAt: upload.publishedAt ?? "2026-09-01T00:00:00Z",
          },
        })),
        ...(pageAt(index + 1) ? { nextPageToken: `p${index + 1}` } : {}),
      });
    }

    const ids = (u.searchParams.get("id") ?? "").split(",");
    return jsonResponse({
      items: ids
        .map((id) => known.get(id))
        .filter((upload): upload is Upload => !!upload && !upload.noDetails)
        .map((upload) => ({
          id: upload.id,
          contentDetails: { duration: iso(upload.seconds) },
        })),
    });
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const long = (id: string, publishedAt = "2026-09-01T00:00:00Z"): Upload => ({
  id,
  seconds: 600,
  publishedAt,
});
const short = (id: string, publishedAt = "2026-09-01T00:00:00Z"): Upload => ({
  id,
  seconds: 15,
  publishedAt,
});
const manyShorts = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => short(`${prefix}${i}`));

const ids = (body: unknown) => (body as Array<{ id: string }>).map((v) => v.id);

describe("api/youtube-videos: ?type=videos|shorts", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    Object.assign(process.env, {
      YOUTUBE_API_KEY: API_KEY,
      YOUTUBE_CHANNEL_ID: "UCcanal-de-prueba",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("separa videos normales y Shorts, cada lista solo con lo suyo", async () => {
    const uploads = [short("s1"), long("v1"), short("s2"), long("v2")];

    stubUploads([uploads]);
    const videos = mockRes();
    await videosHandler(req({ type: "videos" }), videos.res);

    stubUploads([uploads]);
    const shorts = mockRes();
    await videosHandler(req({ type: "shorts" }), shorts.res);

    expect(videos.state.status).toBe(200);
    expect(ids(videos.state.body)).toEqual(["v1", "v2"]);
    expect(shorts.state.status).toBe(200);
    expect(ids(shorts.state.body)).toEqual(["s1", "s2"]);
  });

  it("mantiene el contrato de cada video y la cache", async () => {
    stubUploads([[long("v1", "2026-09-18T19:00:31Z")]]);
    const { res, state } = mockRes();

    await videosHandler(req({ type: "videos" }), res);

    expect(state.headers["Cache-Control"]).toBe(
      "s-maxage=900, stale-while-revalidate=1800",
    );
    expect(state.body).toEqual([
      {
        id: "v1",
        title: "Video v1",
        description: "",
        thumbnailUrl: "https://i.ytimg.com/vi/v1/hqdefault.jpg",
        publishedAt: "2026-09-18T19:00:31Z",
        duration: "10:00",
      },
    ]);
  });

  it("ordena del más reciente al más antiguo aunque Google los devuelva desordenados", async () => {
    stubUploads([
      [long("viejo", "2026-08-01T00:00:00Z"), long("nuevo", "2026-09-10T00:00:00Z")],
      [long("medio", "2026-09-01T00:00:00Z")],
    ]);
    const { res, state } = mockRes();

    await videosHandler(req({ type: "videos" }), res);

    expect(ids(state.body)).toEqual(["nuevo", "medio", "viejo"]);
  });

  it("no devuelve duplicados si la paginación repite un id", async () => {
    stubUploads([
      [long("v1"), long("v2")],
      [long("v2"), long("v3")],
    ]);
    const { res, state } = mockRes();

    await videosHandler(req({ type: "videos" }), res);

    expect(ids(state.body)).toEqual(["v1", "v2", "v3"]);
  });

  it("muchos Shorts no vacían 'Más videos': sigue paginando hasta encontrar videos largos", async () => {
    const fetchMock = stubUploads([
      manyShorts("a", UPLOADS_PAGE_SIZE),
      [long("v1"), ...manyShorts("b", 20), long("v2")],
    ]);
    const { res, state } = mockRes();

    await videosHandler(req({ type: "videos" }), res);

    expect(ids(state.body)).toEqual(["v1", "v2"]);
    // channels + 2 páginas × (playlistItems + videos)
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("los Shorts se detienen en cuanto hay suficientes (sin páginas de más)", async () => {
    const fetchMock = stubUploads([
      manyShorts("a", UPLOADS_PAGE_SIZE),
      manyShorts("b", 50),
    ]);
    const { res, state } = mockRes();

    await videosHandler(req({ type: "shorts", maxResults: "5" }), res);

    expect(state.body).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(3); // channels + 1 página
  });

  it("la búsqueda está acotada: nunca más de 1 + 2 × MAX_UPLOAD_PAGES llamadas", async () => {
    let n = 0;
    const fetchMock = stubUploads((page) =>
      Array.from({ length: UPLOADS_PAGE_SIZE }, () => short(`s${page}-${n++}`)),
    );
    const { res, state } = mockRes();

    await videosHandler(req({ type: "videos" }), res);

    expect(state.status).toBe(200);
    expect(state.body).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1 + 2 * MAX_UPLOAD_PAGES);
  });

  it("sin videos normales: 200 con lista vacía", async () => {
    stubUploads([[short("s1"), short("s2")]]);
    const { res, state } = mockRes();

    await videosHandler(req({ type: "videos" }), res);

    expect(state.status).toBe(200);
    expect(state.body).toEqual([]);
  });

  it("sin Shorts: 200 con lista vacía", async () => {
    stubUploads([[long("v1"), long("v2")]]);
    const { res, state } = mockRes();

    await videosHandler(req({ type: "shorts" }), res);

    expect(state.status).toBe(200);
    expect(state.body).toEqual([]);
  });

  it("canal sin uploads: 200 con lista vacía sin pedir detalles", async () => {
    const fetchMock = stubUploads([[]]);
    const { res, state } = mockRes();

    await videosHandler(req({ type: "shorts" }), res);

    expect(state.body).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // channels + playlistItems
  });

  it("ignora uploads sin detalles (borrados/privados) en las listas por tipo", async () => {
    stubUploads([[{ ...long("fantasma"), noDetails: true }, long("v1")]]);
    const { res, state } = mockRes();

    await videosHandler(req({ type: "videos" }), res);

    expect(ids(state.body)).toEqual(["v1"]);
  });

  it("respeta maxResults (tope 50) sobre cada tipo", async () => {
    stubUploads([Array.from({ length: 30 }, (_, i) => long(`v${i}`))]);
    const { res, state } = mockRes();

    await videosHandler(req({ type: "videos", maxResults: "7" }), res);

    expect(state.body).toHaveLength(7);
  });

  it.each(["short", "all", "", "constructor", "__proto__"])(
    "type=%j no válido: 400 sin llamar a Google",
    async (type) => {
      const fetchMock = stubUploads([[long("v1")]]);
      const { res, state } = mockRes();

      await videosHandler(req({ type }), res);

      expect(state.status).toBe(400);
      expect(state.body).toEqual({ error: "Parámetro type no válido" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("sin type: contrato original (uploads recientes sin clasificar, una sola página)", async () => {
    const fetchMock = stubUploads([[short("s1"), long("v1"), short("s2")]]);
    const { res, state } = mockRes();

    await videosHandler(req(), res);

    expect(ids(state.body)).toEqual(["s1", "v1", "s2"]);
    expect(fetchMock).toHaveBeenCalledTimes(3); // channels + playlistItems + videos
  });

  it("un fallo de Google en una página posterior mantiene el error 502 genérico", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const operation = new URL(url).pathname.split("/").pop();
        if (operation === "channels") {
          return jsonResponse({
            items: [{ contentDetails: { relatedPlaylists: { uploads: "UUuploads" } } }],
          });
        }
        if (operation === "playlistItems" && ++calls === 2) {
          return jsonResponse({ error: { errors: [{ reason: "quotaExceeded" }] } }, 403);
        }
        if (operation === "playlistItems") {
          return jsonResponse({
            items: [
              {
                snippet: {
                  resourceId: { videoId: "s1" },
                  title: "s",
                  description: "",
                  publishedAt: "2026-09-01T00:00:00Z",
                },
              },
            ],
            nextPageToken: "p1",
          });
        }
        return jsonResponse({
          items: [{ id: "s1", contentDetails: { duration: "PT9S" } }],
        });
      }),
    );
    const { res, state } = mockRes();

    await videosHandler(req({ type: "videos" }), res);

    expect(state.status).toBe(502);
    expect(state.body).toEqual({ error: "No se pudieron obtener los videos de YouTube" });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain(
      "HTTP 403 (quotaExceeded)",
    );
  });
});
