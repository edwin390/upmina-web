import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import clipsHandler from "../../api/twitch-clips";
import latestVideoHandler from "../../api/twitch-latest-video";
import statusHandler from "../../api/twitch-status";
import { resetTwitchCacheForTests } from "./twitch-shared";
import { SNAPSHOT_OPERATION_TIMEOUT_MS } from "./public-snapshots";
import { SNAPSHOT_MAX_AGE_MS, twitchSourceId } from "./public-snapshot-resources";
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

// Integración de los snapshots last-known-good en /api/twitch-clips y /api/twitch-latest-video
// (Fase 9H-4, checkpoint 3), sobre el doble de Supabase del checkpoint 2 y un Helix simulado.
// Twitch LIVE/OFFLINE (/api/twitch-status) NO tiene snapshot: se comprueba que no toca la tabla.

vi.mock("@supabase/supabase-js", async () => {
  const { fakeCreateClient } = await import("./public-snapshots-supabase-fake");
  return { createClient: fakeCreateClient };
});

const CHANNEL = "canalficticio";
const SOURCE = twitchSourceId(CHANNEL)!;
const SHORT_CACHE = "s-maxage=60, stale-while-revalidate=120";
const CLIPS_CACHE = "s-maxage=300, stale-while-revalidate=600";

interface Helix {
  users?: () => Response | Promise<Response>;
  clips?: (call: number) => Response | Promise<Response>;
  videos?: () => Response | Promise<Response>;
  token?: () => Response | Promise<Response>;
}

/** Cliente Helix simulado. Lo no indicado responde con lo normal. */
function stubHelix(routes: Helix = {}) {
  let clipCalls = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("oauth2/token")) {
      return (
        routes.token?.() ??
        jsonResponse({ access_token: "token-de-prueba", expires_in: 3600 })
      );
    }
    if (url.includes("helix/users")) {
      return routes.users?.() ?? jsonResponse({ data: [{ id: "42" }] });
    }
    if (url.includes("helix/clips")) {
      clipCalls += 1;
      return routes.clips?.(clipCalls) ?? jsonResponse({ data: helixClips(12) });
    }
    if (url.includes("helix/videos")) {
      return routes.videos?.() ?? jsonResponse({ data: [helixVideo()] });
    }
    if (url.includes("helix/streams")) return jsonResponse({ data: [] });
    return jsonResponse({ data: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function helixClips(n: number, from = 0) {
  return Array.from({ length: n }, (_, i) => {
    const id = `SyntheticClip${from + i}`;
    return {
      id,
      url: `https://www.twitch.tv/${CHANNEL}/clip/${id}`,
      title: `Clip ${from + i}`,
      creator_name: "creadorficticio",
      thumbnail_url: `https://static-cdn.jtvnw.net/twitch-clips-thumbnails-prod/${id}/preview-480x272.jpg`,
      view_count: from + i,
      created_at: new Date(NOW - (from + i + 1) * 60_000).toISOString(),
    };
  });
}

function helixVideo() {
  return {
    id: "2882064767",
    url: "https://www.twitch.tv/videos/2882064767",
    title: "Último stream de prueba",
    thumbnail_url:
      "https://static-cdn.jtvnw.net/cf_vods/synthetic/thumb/thumb0-%{width}x%{height}.jpg",
    created_at: "2026-09-23T18:00:00Z",
    duration: "3h28m10s",
    type: "archive",
  };
}

const FRESH_CLIPS = helixClips(12).map((c) => ({
  id: c.id,
  url: c.url,
  title: c.title,
  creatorName: c.creator_name,
  embedUrl: `https://clips.twitch.tv/embed?clip=${c.id}`,
  thumbnailUrl: c.thumbnail_url,
  viewCount: c.view_count,
  createdAt: c.created_at,
}));

const FRESH_VIDEO = {
  id: "2882064767",
  url: "https://www.twitch.tv/videos/2882064767",
  title: "Último stream de prueba",
  thumbnailUrl: "https://static-cdn.jtvnw.net/cf_vods/synthetic/thumb/thumb0-640x360.jpg",
  createdAt: "2026-09-23T18:00:00Z",
  duration: "3h28m10s",
};

const originalEnv = { ...process.env };

beforeEach(() => {
  resetSnapshotDb();
  resetTwitchCacheForTests();
  vi.stubEnv("TWITCH_CLIENT_ID", "id-ficticio");
  vi.stubEnv("TWITCH_CLIENT_SECRET", "secreto-ficticio");
  vi.stubEnv("TWITCH_CHANNEL", CHANNEL);
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
  resetTwitchCacheForTests();
});

const runClips = async () => {
  const { res, state } = mockRes();
  await clipsHandler(getReq(), res);
  return state;
};
const runVideo = async () => {
  const { res, state } = mockRes();
  await latestVideoHandler(getReq(), res);
  return state;
};

/** Fallos de disponibilidad del proveedor: cada uno debe permitir servir el snapshot. */
const TRANSIENT: [string, () => Response | Promise<Response>][] = [
  ["429", () => jsonResponse({ message: "rate" }, 429, { "retry-after": "30" })],
  ["502", () => jsonResponse({ message: "bad gateway" }, 502)],
  ["503", () => jsonResponse({ message: "unavailable" }, 503)],
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
];

// ===================================================================================
describe("twitch-clips — camino fresco", () => {
  it("devuelve los clips frescos con la forma y la caché de siempre", async () => {
    stubHelix();
    const state = await runClips();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(FRESH_CLIPS);
    expect(state.headers["Cache-Control"]).toBe(CLIPS_CACHE);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("una lista completa actualiza el snapshot (mismo valor, fuente del canal configurado)", async () => {
    stubHelix();
    await runClips();

    expect(snapshotDb.rows.get("twitch-clips")).toMatchObject({
      resource: "twitch-clips",
      source_id: SOURCE,
      payload: FRESH_CLIPS,
    });
  });

  it("la lista vacía VÁLIDA sustituye al snapshot anterior (un clip borrado no resucita)", async () => {
    seedSnapshot("twitch-clips", SOURCE, validPayload("twitch-clips"));
    stubHelix({ clips: () => jsonResponse({ data: [] }) });
    const state = await runClips();

    expect(state.status).toBe(200);
    expect(state.body).toEqual([]);
    expect(snapshotDb.rows.get("twitch-clips")?.payload).toEqual([]);
  });

  it("no escribe fuera de Production (Preview comparte base de datos)", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    stubHelix();
    const state = await runClips();

    expect(state.status).toBe(200);
    expect(countSnapshotOps("upsert")).toBe(0);
  });
});

describe("twitch-clips — resultado parcial (9H-2)", () => {
  /** 3 clips y después un 503 a mitad de la búsqueda. */
  const partial = () =>
    stubHelix({
      clips: (call) =>
        call === 1
          ? jsonResponse({ data: helixClips(3) })
          : jsonResponse({ message: "unavailable" }, 503),
    });

  it("se sirve el parcial fresco, con la caché corta de siempre", async () => {
    partial();
    const state = await runClips();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(FRESH_CLIPS.slice(0, 3));
    expect(state.headers["Cache-Control"]).toBe(SHORT_CACHE);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("el parcial NO sobrescribe el snapshot completo", async () => {
    const full = validPayload("twitch-clips");
    seedSnapshot("twitch-clips", SOURCE, full);
    const before = structuredClone(snapshotDb.rows.get("twitch-clips"));
    partial();
    await runClips();

    expect(countSnapshotOps("upsert")).toBe(0);
    expect(snapshotDb.rows.get("twitch-clips")).toEqual(before);
  });

  it("el parcial fresco NO se sustituye por el snapshot completo antiguo", async () => {
    seedSnapshot("twitch-clips", SOURCE, validPayload("twitch-clips"));
    partial();
    const state = await runClips();

    expect(state.body).toEqual(FRESH_CLIPS.slice(0, 3));
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("sin ningún clip el fallo NO se oculta: es elegible y sirve el snapshot", async () => {
    seedSnapshot("twitch-clips", SOURCE, validPayload("twitch-clips"));
    stubHelix({ clips: () => jsonResponse({ message: "unavailable" }, 503) });
    const state = await runClips();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(validPayload("twitch-clips"));
    expect(state.headers["X-Content-Source"]).toBe("snapshot");
  });

  it("si la búsqueda termina con poco plazo, no intenta escribir (un snapshot no puede causar un 504)", async () => {
    vi.useFakeTimers({ now: NOW });
    stubHelix({
      clips: () => {
        // La petición "tarda": queda menos plazo que lo que puede tardar la escritura.
        vi.setSystemTime(Date.now() + 8_000 - SNAPSHOT_OPERATION_TIMEOUT_MS + 500);
        return jsonResponse({ data: helixClips(12) });
      },
    });
    const state = await runClips();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(FRESH_CLIPS);
    expect(countSnapshotOps("upsert")).toBe(0);
  });
});

describe("twitch-clips — fallback ante fallos transitorios", () => {
  beforeEach(() => {
    seedSnapshot("twitch-clips", SOURCE, validPayload("twitch-clips"));
  });

  it.each(TRANSIENT)("%s con snapshot válido → snapshot", async (_name, failure) => {
    stubHelix({ clips: failure });
    const state = await runClips();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(validPayload("twitch-clips"));
  });

  it("fallo transitorio al resolver el canal (users) → snapshot", async () => {
    stubHelix({ users: () => jsonResponse({ message: "x" }, 503) });
    const state = await runClips();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(validPayload("twitch-clips"));
  });

  it("fallo transitorio del token de Twitch (5xx) → snapshot", async () => {
    stubHelix({ token: () => jsonResponse({ message: "x" }, 503) });
    const state = await runClips();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(validPayload("twitch-clips"));
  });

  it("timeout → snapshot", async () => {
    vi.useFakeTimers({ now: NOW });
    seedSnapshot("twitch-clips", SOURCE, validPayload("twitch-clips"));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (url: string, init: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            if (url.includes("oauth2/token")) {
              resolve(jsonResponse({ access_token: "t", expires_in: 3600 }));
              return;
            }
            if (url.includes("helix/users")) {
              resolve(jsonResponse({ data: [{ id: "42" }] }));
              return;
            }
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );
    const pending = runClips();
    await vi.advanceTimersByTimeAsync(9_000);
    const state = await pending;

    expect(state.status).toBe(200);
    expect(state.body).toEqual(validPayload("twitch-clips"));
  });

  it("la respuesta de fallback tiene caché CORTA y la cabecera de diagnóstico (nunca la caché fresca)", async () => {
    stubHelix({ clips: () => jsonResponse({}, 503) });
    const state = await runClips();

    expect(state.headers["Cache-Control"]).toBe(SHORT_CACHE);
    expect(state.headers["Cache-Control"]).not.toBe(CLIPS_CACHE);
    expect(state.headers["X-Content-Source"]).toBe("snapshot");
  });

  it("la respuesta no revela la fuente ni añade campos al contrato", async () => {
    stubHelix({ clips: () => jsonResponse({}, 503) });
    const state = await runClips();

    expect(visibleText(state)).not.toContain(SOURCE);
    expect(visibleText(state)).not.toContain("twitch:");
    expect(Array.isArray(state.body)).toBe(true);
    for (const clip of state.body as Record<string, unknown>[]) {
      expect(Object.keys(clip).sort()).toEqual(
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
    }
  });

  it("un snapshot VACÍO válido se sirve como vacío (no resucita contenido más antiguo)", async () => {
    seedSnapshot("twitch-clips", SOURCE, []);
    stubHelix({ clips: () => jsonResponse({}, 503) });
    const state = await runClips();

    expect(state.status).toBe(200);
    expect(state.body).toEqual([]);
    expect(state.headers["X-Content-Source"]).toBe("snapshot");
  });

  it("un fallo NUNCA sobrescribe el snapshot", async () => {
    const before = structuredClone(snapshotDb.rows.get("twitch-clips"));
    stubHelix({ clips: () => jsonResponse({}, 503) });
    await runClips();

    expect(countSnapshotOps("upsert")).toBe(0);
    expect(snapshotDb.rows.get("twitch-clips")).toEqual(before);
  });
});

describe("twitch-clips — fallos que NO usan snapshot", () => {
  beforeEach(() => {
    seedSnapshot("twitch-clips", SOURCE, validPayload("twitch-clips"));
  });

  const expectProviderError = (state: Awaited<ReturnType<typeof runClips>>) => {
    expect(state.status).toBeGreaterThanOrEqual(400);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
    expect(state.body).toMatchObject({
      error: "No se pudieron obtener los clips de Twitch",
    });
  };

  it("credenciales rechazadas al pedir el token (400/401) → error, sin snapshot", async () => {
    for (const status of [400, 401, 403]) {
      resetTwitchCacheForTests();
      stubHelix({ token: () => jsonResponse({ message: "invalid client" }, status) });
      expectProviderError(await runClips());
    }
  });

  it("401/403 de Helix (configuración/autorización) → error, sin snapshot", async () => {
    for (const status of [401, 403, 404]) {
      resetTwitchCacheForTests();
      stubHelix({ clips: () => jsonResponse({ message: "no" }, status) });
      expectProviderError(await runClips());
    }
  });

  it("credenciales ausentes (configuración) → error, sin snapshot", async () => {
    vi.stubEnv("TWITCH_CLIENT_SECRET", "");
    stubHelix();
    const state = await runClips();

    expectProviderError(state);
    expect(state.status).toBe(503);
  });

  it("canal inexistente → error, sin snapshot", async () => {
    stubHelix({ users: () => jsonResponse({ data: [] }) });
    const state = await runClips();

    expectProviderError(state);
    expect(state.status).toBe(404);
  });

  it("JSON válido con esquema inesperado → error, sin snapshot y sin escribir", async () => {
    const cases: unknown[] = [
      {},
      { data: null },
      { data: "no es una lista" },
      { data: { id: "x" } },
      null,
      // Elementos irreconocibles: sin id/fecha o sin ningún campo de clip.
      { data: [{ foo: 1 }, { bar: 2 }] },
      // Cambio de contrato: ningún elemento trae thumbnail_url.
      { data: [{ id: "a", created_at: "2026-09-26T04:00:00Z", title: "x" }] },
    ];
    for (const body of cases) {
      resetSnapshotDb();
      seedSnapshot("twitch-clips", SOURCE, validPayload("twitch-clips"));
      stubHelix({ clips: () => jsonResponse(body) });
      const state = await runClips();

      expectProviderError(state);
      expect(state.body).not.toEqual([]);
      expect(countSnapshotOps("upsert")).toBe(0);
    }
  });

  it("un elemento suelto sin miniatura (procesado fallido) se descarta, no rompe la respuesta", async () => {
    const list = helixClips(3);
    list[1] = { ...list[1]!, thumbnail_url: "" };
    stubHelix({ clips: () => jsonResponse({ data: list }) });
    const state = await runClips();

    expect(state.status).toBe(200);
    expect((state.body as unknown[]).length).toBe(2);
  });
});

describe("twitch-clips — snapshot inválido o base de datos caída", () => {
  it("snapshot caducado (> 48 h) → no se usa", async () => {
    seedSnapshot(
      "twitch-clips",
      SOURCE,
      validPayload("twitch-clips"),
      Date.now() - SNAPSHOT_MAX_AGE_MS.durable - 1_000,
    );
    stubHelix({ clips: () => jsonResponse({}, 503) });
    const state = await runClips();

    expect(state.status).toBe(502);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("snapshot de otro canal → no se usa", async () => {
    seedSnapshot(
      "twitch-clips",
      twitchSourceId("otrocanal")!,
      validPayload("twitch-clips"),
    );
    stubHelix({ clips: () => jsonResponse({}, 503) });
    const state = await runClips();

    expect(state.status).toBe(502);
  });

  it("cambiar el canal configurado invalida el snapshot anterior", async () => {
    seedSnapshot("twitch-clips", SOURCE, validPayload("twitch-clips"));
    stubHelix({ clips: () => jsonResponse({}, 503) });
    expect((await runClips()).status).toBe(200);

    vi.stubEnv("TWITCH_CHANNEL", "canalnuevo");
    resetTwitchCacheForTests();
    stubHelix({ clips: () => jsonResponse({}, 503) });
    expect((await runClips()).status).toBe(502);
  });

  it("snapshot malformado (clave desconocida, forma equivocada, http) → no se usa ni se repara", async () => {
    const bad = validPayload("twitch-clips");
    const variants: unknown[] = [
      [{ ...bad[0], accessToken: "no-deberia-estar" }],
      { data: bad },
      "texto",
      [{ ...bad[0], thumbnailUrl: "http://static-cdn.jtvnw.net/x.jpg" }],
      [{ ...bad[0], id: 7 }],
    ];
    for (const payload of variants) {
      resetSnapshotDb();
      seedSnapshot("twitch-clips", SOURCE, payload);
      stubHelix({ clips: () => jsonResponse({}, 503) });
      const state = await runClips();

      expect(state.status).toBe(502);
      expect(countSnapshotOps("upsert")).toBe(0);
    }
  });

  it("fallo del proveedor + fallo de LECTURA del snapshot → el mismo error que sin snapshots", async () => {
    stubHelix({ clips: () => jsonResponse({}, 503) });
    const baseline = await runClips();

    resetSnapshotDb();
    snapshotDb.failOn.select = { code: "XX000" };
    stubHelix({ clips: () => jsonResponse({}, 503) });
    const withBrokenDb = await runClips();

    expect(withBrokenDb.status).toBe(baseline.status);
    expect(withBrokenDb.body).toEqual(baseline.body);
    expect(withBrokenDb.status).toBe(502);
  });

  it("fallo del proveedor + excepción al leer → el mismo error, sin caída", async () => {
    snapshotDb.throwOn.select = new Error("boom");
    stubHelix({ clips: () => jsonResponse({}, 503) });
    const state = await runClips();

    expect(state.status).toBe(502);
    expect(state.body).toMatchObject({
      error: "No se pudieron obtener los clips de Twitch",
    });
  });

  it("éxito del proveedor + fallo de ESCRITURA → respuesta fresca", async () => {
    for (const inject of [
      () => (snapshotDb.failOn.upsert = { code: "23514" }),
      () => (snapshotDb.throwOn.upsert = new Error("boom")),
    ]) {
      resetSnapshotDb();
      inject();
      stubHelix();
      const state = await runClips();

      expect(state.status).toBe(200);
      expect(state.body).toEqual(FRESH_CLIPS);
      expect(state.headers["Cache-Control"]).toBe(CLIPS_CACHE);
    }
  });

  it("éxito del proveedor + escritura que no termina (timeout de 2 s) → respuesta fresca", async () => {
    vi.useFakeTimers({ now: NOW });
    snapshotDb.hang.upsert = true;
    stubHelix();
    const pending = runClips();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_OPERATION_TIMEOUT_MS + 100);
    const state = await pending;

    expect(state.status).toBe(200);
    expect(state.body).toEqual(FRESH_CLIPS);
  });

  it("Supabase sin configurar: el endpoint funciona como siempre", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    stubHelix();
    const ok = await runClips();
    expect(ok.status).toBe(200);
    expect(snapshotDb.clientsCreated).toBe(0);

    stubHelix({ clips: () => jsonResponse({}, 503) });
    expect((await runClips()).status).toBe(502);
  });
});

// ===================================================================================
describe("twitch-latest-video", () => {
  it("fresco: cuerpo y caché de siempre, y actualiza el snapshot", async () => {
    stubHelix();
    const state = await runVideo();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(FRESH_VIDEO);
    expect(state.headers["Cache-Control"]).toBe(CLIPS_CACHE);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
    expect(snapshotDb.rows.get("twitch-latest-video")).toMatchObject({
      source_id: SOURCE,
      payload: FRESH_VIDEO,
    });
  });

  it("sin VOD (autoritativo): 204 y SUSTITUYE al snapshot anterior por el marcador de vacío", async () => {
    seedSnapshot("twitch-latest-video", SOURCE, validPayload("twitch-latest-video"));
    stubHelix({ videos: () => jsonResponse({ data: [] }) });
    const state = await runVideo();

    expect(state.status).toBe(204);
    expect(state.ended).toBe(true);
    expect(state.headers["Cache-Control"]).toBe(CLIPS_CACHE);
    expect(snapshotDb.rows.get("twitch-latest-video")?.payload).toEqual({ empty: true });
  });

  it.each(TRANSIENT)("%s con snapshot válido → snapshot", async (_name, failure) => {
    seedSnapshot("twitch-latest-video", SOURCE, validPayload("twitch-latest-video"));
    stubHelix({ videos: failure });
    const state = await runVideo();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(validPayload("twitch-latest-video"));
    expect(state.headers["Cache-Control"]).toBe(SHORT_CACHE);
    expect(state.headers["X-Content-Source"]).toBe("snapshot");
    expect(visibleText(state)).not.toContain("twitch:");
  });

  it("un snapshot de 'sin VOD' se sirve con el contrato de sin video (204), sin resucitar el VOD anterior", async () => {
    seedSnapshot("twitch-latest-video", SOURCE, { empty: true });
    stubHelix({ videos: () => jsonResponse({}, 503) });
    const state = await runVideo();

    expect(state.status).toBe(204);
    expect(state.ended).toBe(true);
    expect(state.headers["Cache-Control"]).toBe(SHORT_CACHE);
    expect(state.headers["X-Content-Source"]).toBe("snapshot");
  });

  it("errores de credenciales/configuración/autorización → error, sin snapshot", async () => {
    seedSnapshot("twitch-latest-video", SOURCE, validPayload("twitch-latest-video"));
    for (const status of [400, 401, 403, 404]) {
      resetTwitchCacheForTests();
      stubHelix({ videos: () => jsonResponse({ message: "no" }, status) });
      const state = await runVideo();

      expect(state.status).toBeGreaterThanOrEqual(400);
      expect(state.headers["X-Content-Source"]).toBeUndefined();
    }
    resetTwitchCacheForTests();
    vi.stubEnv("TWITCH_CLIENT_ID", "");
    stubHelix();
    const missing = await runVideo();
    expect(missing.status).toBe(503);
    expect(missing.headers["X-Content-Source"]).toBeUndefined();
  });

  it("JSON válido con esquema inesperado NO es 'sin video': error, sin snapshot y sin escribir", async () => {
    const cases: unknown[] = [
      {},
      null,
      { data: null },
      { data: {} },
      { data: "x" },
      { data: [{}] },
      { data: [{ id: 5, url: "u", title: "t", created_at: "c", duration: "d" }] },
      { data: [null] },
    ];
    for (const body of cases) {
      resetSnapshotDb();
      seedSnapshot("twitch-latest-video", SOURCE, validPayload("twitch-latest-video"));
      stubHelix({ videos: () => jsonResponse(body) });
      const state = await runVideo();

      expect(state.status).toBe(502);
      expect(state.ended).toBe(false);
      expect(state.headers["X-Content-Source"]).toBeUndefined();
      expect(countSnapshotOps("upsert")).toBe(0);
    }
  });

  it("snapshot caducado, de otro canal o malformado → no se usa", async () => {
    const good = validPayload("twitch-latest-video");
    const rows: [string, string, unknown, number][] = [
      ["caducado", SOURCE, good, Date.now() - SNAPSHOT_MAX_AGE_MS.durable - 1_000],
      ["otro canal", twitchSourceId("otrocanal")!, good, Date.now() - HOUR],
      ["malformado", SOURCE, { ...good, token: "x" }, Date.now() - HOUR],
    ];
    for (const [, source, payload, at] of rows) {
      resetSnapshotDb();
      seedSnapshot("twitch-latest-video", source, payload, at);
      stubHelix({ videos: () => jsonResponse({}, 503) });
      expect((await runVideo()).status).toBe(502);
    }
  });

  it("proveedor caído + lectura del snapshot caída → el error de siempre", async () => {
    snapshotDb.failOn.select = { code: "XX000" };
    stubHelix({ videos: () => jsonResponse({}, 503) });
    const state = await runVideo();

    expect(state.status).toBe(502);
    expect(state.body).toMatchObject({
      error: "No se pudo obtener el último stream de Twitch",
    });
  });

  it("éxito + fallo de escritura → respuesta fresca", async () => {
    snapshotDb.failOn.upsert = { code: "XX000" };
    stubHelix();
    const state = await runVideo();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(FRESH_VIDEO);
  });

  it("un fallo nunca sobrescribe el snapshot", async () => {
    seedSnapshot("twitch-latest-video", SOURCE, validPayload("twitch-latest-video"));
    stubHelix({ videos: () => jsonResponse({}, 503) });
    await runVideo();

    expect(countSnapshotOps("upsert")).toBe(0);
  });
});

// ===================================================================================
describe("twitch-status — SIN snapshot (LIVE/OFFLINE nunca usa last-known-good)", () => {
  it("con todo configurado no lee, no escribe y ni siquiera crea un cliente de Supabase", async () => {
    stubHelix();
    const { res, state } = mockRes();
    await statusHandler(getReq(), res);

    expect(state.status).toBe(200);
    expect(snapshotDb.clientsCreated).toBe(0);
    expect(snapshotDb.ops).toEqual([]);
  });

  it("ante un fallo del proveedor NO sirve un estado guardado, aunque existan filas", async () => {
    for (const resource of ["twitch-clips", "twitch-latest-video"] as const) {
      seedSnapshot(resource, SOURCE, validPayload(resource));
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("oauth2/token")
          ? jsonResponse({ access_token: "t", expires_in: 3600 })
          : jsonResponse({}, 503),
      ),
    );
    const { res, state } = mockRes();
    await statusHandler(getReq(), res);

    expect(state.status).toBeGreaterThanOrEqual(500);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
    expect(snapshotDb.clientsCreated).toBe(0);
    expect(snapshotDb.ops).toEqual([]);
  });
});
