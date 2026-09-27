import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import latestHandler from "../../api/youtube-latest";
import videosHandler from "../../api/youtube-videos";
import { resetYouTubeCacheForTests } from "./youtube-shared";
import { SNAPSHOT_OPERATION_TIMEOUT_MS } from "./public-snapshots";
import { SNAPSHOT_MAX_AGE_MS, youtubeSourceId } from "./public-snapshot-resources";
import { validPayload } from "./public-snapshot-fixtures";
import {
  countSnapshotOps,
  resetSnapshotDb,
  snapshotDb,
} from "./public-snapshots-supabase-fake";
import {
  HOUR,
  NOW,
  getReq,
  jsonResponse,
  mockRes,
  seedSnapshot,
  silenceErrors,
  visibleText,
} from "./snapshot-handler-testkit";

// Integración de los snapshots last-known-good en /api/youtube-latest y /api/youtube-videos
// (Fase 9H-4, checkpoint 3), sobre el doble de Supabase del checkpoint 2 y una API de Google
// simulada. Solo las peticiones CANÓNICAS de la aplicación tienen snapshot.

vi.mock("@supabase/supabase-js", async () => {
  const { fakeCreateClient } = await import("./public-snapshots-supabase-fake");
  return { createClient: fakeCreateClient };
});

const API_KEY = "AIzaSy-clave-secreta-de-prueba";
const CHANNEL_ID = "UCabcdefghijklmnopqrstuv";
const SOURCE = youtubeSourceId(CHANNEL_ID)!;
const SHORT_CACHE = "s-maxage=60, stale-while-revalidate=120";
const FRESH_CACHE = "s-maxage=900, stale-while-revalidate=1800";

type Op = "channels" | "playlistItems" | "videos";

const CHANNEL_OK = {
  items: [{ contentDetails: { relatedPlaylists: { uploads: "UUuploads" } } }],
};

function playlistItem(videoId: string) {
  return {
    snippet: {
      resourceId: { videoId },
      title: `Video ${videoId}`,
      description: `Descripción ${videoId}`,
      thumbnails: { high: { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` } },
      publishedAt: "2026-09-18T19:00:31Z",
    },
  };
}

const ids = (n: number, prefix: string) =>
  Array.from(
    { length: n },
    (_, i) => `${prefix}${String(i).padStart(11 - prefix.length, "0")}`,
  );

/** Google simulado: 3 videos largos (PT8M38S) y 2 Shorts (PT16S) por defecto. */
function stubGoogle(
  overrides: Partial<Record<Op, () => Response | Promise<Response>>> = {},
  options: { long?: string[]; short?: string[] } = {},
) {
  const long = options.long ?? ids(3, "L");
  const short = options.short ?? ids(2, "S");
  const all = [...long, ...short];
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    const operation = new URL(url).pathname.split("/").pop() as Op;
    calls.push(operation);
    const override = overrides[operation];
    if (override) return override();
    if (operation === "channels") return jsonResponse(CHANNEL_OK);
    if (operation === "playlistItems") {
      return jsonResponse({ items: all.map(playlistItem) });
    }
    return jsonResponse({
      items: all.map((id) => ({
        id,
        contentDetails: { duration: long.includes(id) ? "PT8M38S" : "PT16S" },
      })),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

function googleError(status: number, reason: string | undefined, apiStatus = "ERROR") {
  return () =>
    jsonResponse(
      {
        error: {
          code: status,
          message: `mensaje con la clave ${API_KEY}`,
          status: apiStatus,
          ...(reason ? { errors: [{ reason, message: "detalle" }] } : {}),
        },
      },
      status,
    );
}

const expectedVideos = (list: string[]) =>
  list.map((id) => ({
    id,
    title: `Video ${id}`,
    description: `Descripción ${id}`,
    thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    publishedAt: "2026-09-18T19:00:31Z",
    duration: id.startsWith("L") ? "8:38" : "0:16",
  }));

const originalEnv = { ...process.env };

beforeEach(() => {
  resetSnapshotDb();
  resetYouTubeCacheForTests();
  vi.stubEnv("YOUTUBE_API_KEY", API_KEY);
  vi.stubEnv("YOUTUBE_CHANNEL_ID", CHANNEL_ID);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-service-role-ficticia");
  silenceErrors();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
  resetYouTubeCacheForTests();
});

const runLatest = async () => {
  const { res, state } = mockRes();
  await latestHandler(getReq(), res);
  return state;
};
/** Petición CANÓNICA de la aplicación: videos → 12, Shorts → 24. */
const runVideos = async (
  query: Record<string, string> = { maxResults: "12", type: "videos" },
) => {
  const { res, state } = mockRes();
  await videosHandler(getReq(query), res);
  return state;
};
const runShorts = () => runVideos({ maxResults: "24", type: "shorts" });

const TRANSIENT: [string, () => Response | Promise<Response>][] = [
  [
    "429",
    () => jsonResponse({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, 429),
  ],
  ["500", () => jsonResponse({ error: { errors: [{ reason: "backendError" }] } }, 500)],
  ["503", () => jsonResponse({ error: { errors: [{ reason: "backendError" }] } }, 503)],
  [
    "cuerpo ilegible (no JSON)",
    () => new Response("<html>error</html>", { status: 200 }),
  ],
  [
    "error de red",
    () => {
      throw new TypeError("fetch failed");
    },
  ],
  ["403 quotaExceeded", googleError(403, "quotaExceeded", "PERMISSION_DENIED")],
  ["403 rateLimitExceeded", googleError(403, "rateLimitExceeded", "PERMISSION_DENIED")],
  ["403 dailyLimitExceeded", googleError(403, "dailyLimitExceeded", "PERMISSION_DENIED")],
  [
    "403 userRateLimitExceeded",
    googleError(403, "userRateLimitExceeded", "PERMISSION_DENIED"),
  ],
];

/** Fallos de credenciales, configuración o autorización: NUNCA sirven snapshot. */
const NOT_ELIGIBLE: [string, () => Response | Promise<Response>][] = [
  ["400 keyInvalid", googleError(400, "keyInvalid", "INVALID_ARGUMENT")],
  ["400 keyExpired", googleError(400, "keyExpired", "INVALID_ARGUMENT")],
  ["403 forbidden", googleError(403, "forbidden", "PERMISSION_DENIED")],
  [
    "403 accessNotConfigured",
    googleError(403, "accessNotConfigured", "PERMISSION_DENIED"),
  ],
  ["403 sin reason", googleError(403, undefined, "PERMISSION_DENIED")],
  ["403 con reason no documentado", googleError(403, "otraCosa", "PERMISSION_DENIED")],
  ["401", googleError(401, "authError", "UNAUTHENTICATED")],
  ["404", googleError(404, "notFound", "NOT_FOUND")],
];

// ===================================================================================
describe("youtube-videos — camino fresco y canónico", () => {
  it("videos: cuerpo, caché fresca y snapshot 'youtube-videos' con la fuente del canal", async () => {
    stubGoogle();
    const state = await runVideos();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(expectedVideos(ids(3, "L")));
    expect(state.headers["Cache-Control"]).toBe(FRESH_CACHE);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
    expect(snapshotDb.rows.get("youtube-videos")).toMatchObject({
      resource: "youtube-videos",
      source_id: SOURCE,
      payload: expectedVideos(ids(3, "L")),
    });
    expect(snapshotDb.rows.has("youtube-shorts")).toBe(false);
  });

  it("Shorts: actualiza 'youtube-shorts' y solo ese", async () => {
    stubGoogle();
    const state = await runShorts();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(expectedVideos(ids(2, "S")));
    expect(snapshotDb.rows.get("youtube-shorts")).toMatchObject({
      source_id: SOURCE,
      payload: expectedVideos(ids(2, "S")),
    });
    expect(snapshotDb.rows.has("youtube-videos")).toBe(false);
  });

  it("lista de videos vacía VÁLIDA sustituye al snapshot anterior", async () => {
    seedSnapshot("youtube-videos", SOURCE, validPayload("youtube-videos"));
    stubGoogle({ playlistItems: () => jsonResponse({ items: [] }) });
    const state = await runVideos();

    expect(state.status).toBe(200);
    expect(state.body).toEqual([]);
    expect(snapshotDb.rows.get("youtube-videos")?.payload).toEqual([]);
  });

  it("lista de Shorts vacía VÁLIDA sustituye al snapshot anterior", async () => {
    seedSnapshot("youtube-shorts", SOURCE, validPayload("youtube-shorts"));
    // Hay uploads, pero ninguno es Short: vacío legítimo.
    stubGoogle({}, { long: ids(3, "L"), short: [] });
    const state = await runShorts();

    expect(state.status).toBe(200);
    expect(state.body).toEqual([]);
    expect(snapshotDb.rows.get("youtube-shorts")?.payload).toEqual([]);
  });

  it("no escribe fuera de Production", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    stubGoogle();
    const state = await runVideos();

    expect(state.status).toBe(200);
    expect(countSnapshotOps("upsert")).toBe(0);
  });
});

describe("youtube — petición canónica frente a arbitraria", () => {
  const arbitrary: [string, Record<string, string>][] = [
    ["videos con otro maxResults", { maxResults: "5", type: "videos" }],
    ["videos con maxResults 50", { maxResults: "50", type: "videos" }],
    ["videos con maxResults 24 (el de Shorts)", { maxResults: "24", type: "videos" }],
    ["Shorts con maxResults 12 (el de videos)", { maxResults: "12", type: "shorts" }],
    ["Shorts sin maxResults (12 por defecto)", { type: "shorts" }],
    ["sin type (uploads sin clasificar)", { maxResults: "12" }],
  ];

  it.each(arbitrary)("%s: ni lee ni escribe snapshot", async (_n, query) => {
    seedSnapshot("youtube-videos", SOURCE, validPayload("youtube-videos"));
    seedSnapshot("youtube-shorts", SOURCE, validPayload("youtube-shorts"));
    const rowsBefore = structuredClone([...snapshotDb.rows.entries()]);
    stubGoogle();
    const state = await runVideos(query);

    expect(state.status).toBe(200);
    expect(snapshotDb.ops).toEqual([]);
    expect(snapshotDb.clientsCreated).toBe(0);
    expect([...snapshotDb.rows.entries()]).toEqual(rowsBefore);
  });

  it.each(arbitrary)(
    "%s: ante un fallo NO sirve el snapshot canónico",
    async (_n, query) => {
      seedSnapshot("youtube-videos", SOURCE, validPayload("youtube-videos"));
      seedSnapshot("youtube-shorts", SOURCE, validPayload("youtube-shorts"));
      stubGoogle({ playlistItems: () => jsonResponse({}, 503) });
      const state = await runVideos(query);

      expect(state.status).toBe(502);
      expect(state.headers["X-Content-Source"]).toBeUndefined();
      expect(snapshotDb.ops).toEqual([]);
    },
  );

  it("la petición sin maxResults de videos equivale a la canónica (12 por defecto)", async () => {
    stubGoogle();
    await runVideos({ type: "videos" });
    expect(snapshotDb.rows.has("youtube-videos")).toBe(true);
  });

  it("un parámetro type no válido sigue siendo un 400 y no toca la base de datos", async () => {
    stubGoogle();
    const state = await runVideos({ type: "otro" });
    expect(state.status).toBe(400);
    expect(snapshotDb.ops).toEqual([]);
  });

  it("los límites canónicos coinciden con los que pide el frontend", async () => {
    const hook = await import("../hooks/useYouTubeVideos");
    const { YOUTUBE_SNAPSHOT_LIMITS } = await import("./youtube-shared");
    expect(YOUTUBE_SNAPSHOT_LIMITS.video).toBe(hook.YOUTUBE_VIDEOS_LIMIT);
    expect(YOUTUBE_SNAPSHOT_LIMITS.short).toBe(hook.YOUTUBE_SHORTS_LIMIT);
  });
});

describe("youtube-videos — fallback", () => {
  beforeEach(() => {
    seedSnapshot("youtube-videos", SOURCE, validPayload("youtube-videos"));
    seedSnapshot("youtube-shorts", SOURCE, validPayload("youtube-shorts"));
  });

  it.each(TRANSIENT)("%s → snapshot de videos", async (_n, failure) => {
    stubGoogle({ playlistItems: failure });
    const state = await runVideos();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(validPayload("youtube-videos"));
    expect(state.headers["Cache-Control"]).toBe(SHORT_CACHE);
    expect(state.headers["Cache-Control"]).not.toBe(FRESH_CACHE);
    expect(state.headers["X-Content-Source"]).toBe("snapshot");
  });

  it.each(TRANSIENT)("%s → snapshot de Shorts", async (_n, failure) => {
    stubGoogle({ playlistItems: failure });
    const state = await runShorts();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(validPayload("youtube-shorts"));
  });

  it("un fallo al resolver el canal (channels) o al pedir duraciones (videos) también sirve el snapshot", async () => {
    stubGoogle({ channels: googleError(403, "quotaExceeded") });
    expect((await runVideos()).body).toEqual(validPayload("youtube-videos"));

    resetYouTubeCacheForTests();
    stubGoogle({ videos: googleError(403, "rateLimitExceeded") });
    expect((await runVideos()).body).toEqual(validPayload("youtube-videos"));
  });

  it("timeout → snapshot", async () => {
    vi.useFakeTimers({ now: NOW });
    seedSnapshot("youtube-videos", SOURCE, validPayload("youtube-videos"));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (url: string, init: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            if (url.includes("/channels")) {
              resolve(jsonResponse(CHANNEL_OK));
              return;
            }
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );
    const pending = runVideos();
    await vi.advanceTimersByTimeAsync(9_000);
    const state = await pending;

    expect(state.status).toBe(200);
    expect(state.body).toEqual(validPayload("youtube-videos"));
    expect(state.headers["X-Content-Source"]).toBe("snapshot");
  });

  it.each(NOT_ELIGIBLE)("%s → error, SIN snapshot", async (_n, failure) => {
    stubGoogle({ playlistItems: failure });
    const state = await runVideos();

    expect(state.status).toBe(502);
    expect(state.body).toEqual({ error: "No se pudieron obtener los videos de YouTube" });
    expect(state.headers["X-Content-Source"]).toBeUndefined();
    expect(countSnapshotOps("upsert")).toBe(0);
  });

  it("los rechazos de credenciales también cuentan al resolver el canal", async () => {
    stubGoogle({ channels: googleError(400, "keyInvalid", "INVALID_ARGUMENT") });
    const state = await runVideos();

    expect(state.status).toBe(502);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("API key ausente (configuración) → error, SIN snapshot", async () => {
    vi.stubEnv("YOUTUBE_API_KEY", "");
    stubGoogle();
    const state = await runVideos();

    expect(state.status).toBe(503);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("canal no configurado → sin snapshot y sin tocar la base de datos", async () => {
    vi.stubEnv("YOUTUBE_CHANNEL_ID", "");
    stubGoogle();
    const state = await runVideos();

    expect(state.status).toBe(503);
    expect(snapshotDb.ops).toEqual([]);
  });

  it("un snapshot vacío válido se sirve como vacío (no resucita contenido más antiguo)", async () => {
    seedSnapshot("youtube-videos", SOURCE, []);
    stubGoogle({ playlistItems: () => jsonResponse({}, 503) });
    const state = await runVideos();

    expect(state.status).toBe(200);
    expect(state.body).toEqual([]);
    expect(state.headers["X-Content-Source"]).toBe("snapshot");
  });

  it("la respuesta no revela la fuente, la clave ni añade campos al contrato", async () => {
    stubGoogle({ playlistItems: googleError(403, "quotaExceeded") });
    const state = await runVideos();

    expect(visibleText(state)).not.toContain("youtube:");
    expect(visibleText(state)).not.toContain(CHANNEL_ID);
    expect(visibleText(state)).not.toContain(API_KEY);
    for (const video of state.body as Record<string, unknown>[]) {
      for (const key of Object.keys(video)) {
        expect([
          "id",
          "title",
          "description",
          "thumbnailUrl",
          "coverUrl",
          "publishedAt",
          "duration",
        ]).toContain(key);
      }
    }
  });

  it("un fallo nunca sobrescribe el snapshot", async () => {
    const before = structuredClone([...snapshotDb.rows.entries()]);
    stubGoogle({ playlistItems: googleError(403, "quotaExceeded") });
    await runVideos();

    expect(countSnapshotOps("upsert")).toBe(0);
    expect([...snapshotDb.rows.entries()]).toEqual(before);
  });
});

describe("youtube — respuestas mal formadas NO son 'sin contenido'", () => {
  beforeEach(() => {
    seedSnapshot("youtube-videos", SOURCE, validPayload("youtube-videos"));
    seedSnapshot("youtube-shorts", SOURCE, validPayload("youtube-shorts"));
    seedSnapshot("youtube-latest", SOURCE, validPayload("youtube-latest"));
  });

  const badLists: [string, unknown][] = [
    ["objeto sin items", {}],
    ["items nulo", { items: null }],
    ["items no es una lista", { items: "x" }],
    ["items es un objeto", { items: {} }],
    ["cuerpo JSON null", null],
  ];

  it.each(badLists)(
    "playlistItems (%s) en videos → error, sin snapshot y sin escribir",
    async (_n, body) => {
      stubGoogle({ playlistItems: () => jsonResponse(body) });
      const state = await runVideos();

      expect(state.status).toBe(502);
      expect(state.body).not.toEqual([]);
      expect(state.headers["X-Content-Source"]).toBeUndefined();
      expect(countSnapshotOps("upsert")).toBe(0);
    },
  );

  it.each(badLists)(
    "videos.list (%s) en Shorts → error, no una lista vacía",
    async (_n, body) => {
      stubGoogle({ videos: () => jsonResponse(body) });
      const state = await runShorts();

      expect(state.status).toBe(502);
      expect(state.body).not.toEqual([]);
      expect(state.headers["X-Content-Source"]).toBeUndefined();
      expect(countSnapshotOps("upsert")).toBe(0);
    },
  );

  it.each(badLists)(
    "playlistItems (%s) en latest → error, NO 404 'Sin videos'",
    async (_n, body) => {
      stubGoogle({ playlistItems: () => jsonResponse(body) });
      const state = await runLatest();

      expect(state.status).toBe(502);
      expect(state.body).toEqual({
        error: "No se pudo obtener el último video de YouTube",
      });
      expect(countSnapshotOps("upsert")).toBe(0);
    },
  );

  it("videos.list mal formado en latest → error (no se inventa una duración)", async () => {
    stubGoogle({ videos: () => jsonResponse({}) });
    const state = await runLatest();

    expect(state.status).toBe(502);
    expect(countSnapshotOps("upsert")).toBe(0);
  });

  it("un canal sin la playlist de subidas es un esquema inesperado: error, sin snapshot", async () => {
    stubGoogle({ channels: () => jsonResponse({ items: [] }) });
    const state = await runVideos();

    expect(state.status).toBe(502);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });
});

describe("youtube — snapshot inválido o base de datos caída", () => {
  const fail = () => stubGoogle({ playlistItems: googleError(403, "quotaExceeded") });

  it("caducado → no se usa", async () => {
    seedSnapshot(
      "youtube-videos",
      SOURCE,
      validPayload("youtube-videos"),
      Date.now() - SNAPSHOT_MAX_AGE_MS.durable - 1_000,
    );
    fail();
    const state = await runVideos();

    expect(state.status).toBe(502);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("de otro canal → no se usa; cambiar el canal configurado invalida el anterior", async () => {
    seedSnapshot("youtube-videos", SOURCE, validPayload("youtube-videos"));
    fail();
    expect((await runVideos()).status).toBe(200);

    vi.stubEnv("YOUTUBE_CHANNEL_ID", "UCzyxwvutsrqponmlkjihgfe");
    resetYouTubeCacheForTests();
    fail();
    expect((await runVideos()).status).toBe(502);
  });

  it("malformado (clave desconocida, http, forma equivocada) → no se usa ni se repara", async () => {
    const good = validPayload("youtube-videos");
    const variants: unknown[] = [
      [{ ...good[0], apiKey: "x" }],
      [{ ...good[0], thumbnailUrl: "http://i.ytimg.com/vi/x/hqdefault.jpg" }],
      { items: good },
      "texto",
    ];
    for (const payload of variants) {
      resetSnapshotDb();
      seedSnapshot("youtube-videos", SOURCE, payload);
      fail();
      expect((await runVideos()).status).toBe(502);
    }
  });

  it("proveedor caído + lectura del snapshot caída → el mismo error que sin snapshots", async () => {
    fail();
    const baseline = await runVideos();

    resetSnapshotDb();
    snapshotDb.failOn.select = { code: "XX000" };
    resetYouTubeCacheForTests();
    fail();
    const withBrokenDb = await runVideos();

    expect(withBrokenDb.status).toBe(baseline.status);
    expect(withBrokenDb.body).toEqual(baseline.body);
  });

  it("excepción al leer → sin caída", async () => {
    snapshotDb.throwOn.select = new Error("boom");
    fail();
    expect((await runVideos()).status).toBe(502);
  });

  it("éxito + fallo o excepción de escritura → respuesta fresca", async () => {
    for (const inject of [
      () => (snapshotDb.failOn.upsert = { code: "23514" }),
      () => (snapshotDb.throwOn.upsert = new Error("boom")),
    ]) {
      resetSnapshotDb();
      resetYouTubeCacheForTests();
      inject();
      stubGoogle();
      const state = await runVideos();

      expect(state.status).toBe(200);
      expect(state.body).toEqual(expectedVideos(ids(3, "L")));
      expect(state.headers["Cache-Control"]).toBe(FRESH_CACHE);
    }
  });

  it("éxito + escritura que no termina (2 s) → respuesta fresca", async () => {
    vi.useFakeTimers({ now: NOW });
    snapshotDb.hang.upsert = true;
    stubGoogle();
    const pending = runVideos();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_OPERATION_TIMEOUT_MS + 100);
    const state = await pending;

    expect(state.status).toBe(200);
    expect(state.body).toEqual(expectedVideos(ids(3, "L")));
  });

  it("Supabase sin configurar: funciona como siempre", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    stubGoogle();
    expect((await runVideos()).status).toBe(200);
    expect(snapshotDb.clientsCreated).toBe(0);
  });
});

// ===================================================================================
describe("youtube-latest", () => {
  it("fresco: cuerpo, caché de siempre y snapshot 'youtube-latest'", async () => {
    stubGoogle();
    const state = await runLatest();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(expectedVideos(ids(3, "L"))[0]);
    expect(state.headers["Cache-Control"]).toBe(FRESH_CACHE);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
    expect(snapshotDb.rows.get("youtube-latest")).toMatchObject({
      source_id: SOURCE,
      payload: state.body,
    });
  });

  it("sin videos (autoritativo): 404 de siempre y SUSTITUYE al snapshot por el marcador de vacío", async () => {
    seedSnapshot("youtube-latest", SOURCE, validPayload("youtube-latest"));
    stubGoogle({ playlistItems: () => jsonResponse({ items: [] }) });
    const state = await runLatest();

    expect(state.status).toBe(404);
    expect(state.body).toEqual({ error: "Sin videos" });
    expect(snapshotDb.rows.get("youtube-latest")?.payload).toEqual({ empty: true });
  });

  it.each(TRANSIENT)("%s → snapshot", async (_n, failure) => {
    seedSnapshot("youtube-latest", SOURCE, validPayload("youtube-latest"));
    stubGoogle({ playlistItems: failure });
    const state = await runLatest();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(validPayload("youtube-latest"));
    expect(state.headers["Cache-Control"]).toBe(SHORT_CACHE);
    expect(state.headers["X-Content-Source"]).toBe("snapshot");
    expect(visibleText(state)).not.toContain("youtube:");
  });

  it("un snapshot de 'sin videos' se sirve con el contrato de siempre (404) y no resucita el video anterior", async () => {
    seedSnapshot("youtube-latest", SOURCE, { empty: true });
    stubGoogle({ playlistItems: googleError(403, "quotaExceeded") });
    const state = await runLatest();

    expect(state.status).toBe(404);
    expect(state.body).toEqual({ error: "Sin videos" });
    expect(state.headers["Cache-Control"]).toBe(SHORT_CACHE);
    expect(state.headers["X-Content-Source"]).toBe("snapshot");
  });

  it.each(NOT_ELIGIBLE)("%s → error, SIN snapshot", async (_n, failure) => {
    seedSnapshot("youtube-latest", SOURCE, validPayload("youtube-latest"));
    stubGoogle({ playlistItems: failure });
    const state = await runLatest();

    expect(state.status).toBe(502);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("caducado, de otro canal o malformado → no se usa", async () => {
    const good = validPayload("youtube-latest");
    const rows: [string, unknown, number][] = [
      [SOURCE, good, Date.now() - SNAPSHOT_MAX_AGE_MS.durable - 1_000],
      [youtubeSourceId("UCzyxwvutsrqponmlkjihgfe")!, good, Date.now() - HOUR],
      [SOURCE, { ...good, secret: "x" }, Date.now() - HOUR],
    ];
    for (const [source, payload, at] of rows) {
      resetSnapshotDb();
      resetYouTubeCacheForTests();
      seedSnapshot("youtube-latest", source, payload, at);
      stubGoogle({ playlistItems: googleError(403, "quotaExceeded") });
      expect((await runLatest()).status).toBe(502);
    }
  });

  it("proveedor caído + lectura caída → el error de siempre; éxito + escritura caída → fresco", async () => {
    snapshotDb.failOn.select = { code: "XX000" };
    stubGoogle({ playlistItems: googleError(403, "quotaExceeded") });
    expect((await runLatest()).status).toBe(502);

    resetSnapshotDb();
    resetYouTubeCacheForTests();
    snapshotDb.failOn.upsert = { code: "XX000" };
    stubGoogle();
    expect((await runLatest()).status).toBe(200);
  });
});

// ===================================================================================
describe("aislamiento entre recursos y proveedores", () => {
  it("las videos NO satisfacen una petición de Shorts", async () => {
    seedSnapshot("youtube-videos", SOURCE, validPayload("youtube-videos"));
    stubGoogle({ playlistItems: googleError(403, "quotaExceeded") });
    const state = await runShorts();

    expect(state.status).toBe(502);
    expect(snapshotDb.ops).toEqual([{ op: "select", resource: "youtube-shorts" }]);
  });

  it("los Shorts NO satisfacen 'latest'", async () => {
    seedSnapshot("youtube-shorts", SOURCE, validPayload("youtube-shorts"));
    stubGoogle({ playlistItems: googleError(403, "quotaExceeded") });
    const state = await runLatest();

    expect(state.status).toBe(502);
    expect(snapshotDb.ops).toEqual([{ op: "select", resource: "youtube-latest" }]);
  });

  it("un snapshot de Twitch no satisface ninguna petición de YouTube", async () => {
    // Filas de YouTube con una fuente de Twitch (fila corrupta o intento de reutilizar el recurso).
    const twitch = "twitch:canalficticio";
    seedSnapshot("youtube-videos", twitch, validPayload("youtube-videos"));
    seedSnapshot("youtube-shorts", twitch, validPayload("youtube-shorts"));
    seedSnapshot("youtube-latest", twitch, validPayload("youtube-latest"));
    stubGoogle({ playlistItems: googleError(403, "quotaExceeded") });

    expect((await runVideos()).status).toBe(502);
    expect((await runShorts()).status).toBe(502);
    expect((await runLatest()).status).toBe(502);
  });
});
