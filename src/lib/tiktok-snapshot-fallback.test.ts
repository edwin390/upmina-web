import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTikTokVideos } from "./tiktok-handlers";
import {
  TikTokConnectionError,
  TIKTOK_TRANSIENT_CODES,
  isTikTokFallbackEligible,
} from "./tiktok-connection";
import { TikTokOAuthError } from "./tiktok-shared";
import { countOps, fakeDb, resetFakeDb } from "./tiktok-supabase-fake";
import { SNAPSHOT_OPERATION_TIMEOUT_MS } from "./public-snapshots";
import { SNAPSHOT_MAX_AGE_MS, socialSourceId } from "./public-snapshot-resources";
import { validPayload } from "./public-snapshot-fixtures";
import {
  countSnapshotOps,
  resetSnapshotDb,
  snapshotDb,
} from "./public-snapshots-supabase-fake";
import {
  getReq,
  jsonResponse,
  mockRes,
  seedSnapshot,
  silenceErrors,
  visibleText,
} from "./snapshot-handler-testkit";

// Integración de los snapshots last-known-good en /api/tiktok-videos (Fase 9H-4, checkpoint 4).
// Corre el handler REAL, la conexión REAL (lectura, lease y refresh) y los snapshots REALES sobre
// dobles en memoria de Supabase y un TikTok simulado. Regla congelada: un snapshot NO basta por sí
// solo; se sirve solo si esta petición estableció que la conexión existe y su autorización es
// recuperable, y solo ante un fallo transitorio de disponibilidad de TikTok.

vi.mock("@supabase/supabase-js", async () => {
  const tiktok = await import("./tiktok-supabase-fake");
  const snap = await import("./public-snapshots-supabase-fake");
  return {
    createClient: (...args: unknown[]) => {
      const social = tiktok.fakeCreateClient();
      return {
        from: (table: string) =>
          table === "public_content_snapshots"
            ? snap.fakeCreateClient(...args).from(table)
            : social.from(),
      };
    },
  };
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const CONNECTION_ID = "0b8e5f5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const OTHER_CONNECTION_ID = "9c1d2e3f-4a5b-4c6d-8e7f-a0b1c2d3e4f5";
const OPEN_ID = "open-id-1";
const SOURCE = socialSourceId("tiktok", CONNECTION_ID, OPEN_ID)!;
const ACCESS = "act.access-guardado-ficticio";
const REFRESH = "rft.refresh-guardado-ficticio";
const NEW_ACCESS = "act.access-nuevo-ficticio";
const NEW_REFRESH = "rft.refresh-nuevo-ficticio";
const SHORT_CACHE = "s-maxage=60, stale-while-revalidate=120";
const FRESH_CACHE = "s-maxage=1800, stale-while-revalidate=3600";
const ERROR_BODY = { error: "No se pudieron obtener los videos de TikTok" };
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const LIST_URL = "https://open.tiktokapis.com/v2/video/list/";

const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    provider: "tiktok",
    provider_user_id: OPEN_ID,
    access_token: ACCESS,
    refresh_token: REFRESH,
    access_token_expires_at: iso(6 * HOUR),
    refresh_token_expires_at: iso(300 * DAY),
    scope: "user.info.basic,video.list",
    refresh_lock_until: null,
    ...overrides,
  };
}

/** Access token ya vencido (recuperable con el refresh token). */
const expiredRow = (overrides: Record<string, unknown> = {}) =>
  storedRow({ access_token_expires_at: iso(-1000), ...overrides });

const apiVideo = {
  id: "7001",
  title: "Mi video",
  share_url: "https://www.tiktok.com/@cuentaficticia/video/7001",
  cover_image_url: "https://p16.tiktokcdn.com/cover.jpeg",
  create_time: 1_790_000_000,
};
const FRESH_VIDEOS = [
  {
    id: "7001",
    title: "Mi video",
    embedUrl: "https://www.tiktok.com/@cuentaficticia/video/7001",
    coverImageUrl: "https://p16.tiktokcdn.com/cover.jpeg",
    createTime: new Date(1_790_000_000 * 1000).toISOString(),
  },
];
const listOk = { data: { videos: [apiVideo], has_more: false }, error: { code: "ok" } };
const refreshOk = {
  access_token: NEW_ACCESS,
  expires_in: 86400,
  open_id: OPEN_ID,
  refresh_expires_in: 31536000,
  refresh_token: NEW_REFRESH,
  scope: "user.info.basic,video.list",
  token_type: "Bearer",
};

type Route = () => Response | Promise<Response>;

function stubTikTok(list: Route = () => jsonResponse(listOk), refresh?: Route) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === TOKEN_URL) return (refresh ?? (() => jsonResponse(refreshOk)))();
    if (url.startsWith(LIST_URL)) return list();
    return new Response("", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const listError = (status: number, code: string) => () =>
  jsonResponse({ data: {}, error: { code, message: "no filtrar", log_id: "x" } }, status);

const errorLog = () =>
  vi
    .mocked(console.error)
    .mock.calls.map((c) => c.join(" "))
    .join("\n");

beforeEach(() => {
  resetSnapshotDb();
  resetFakeDb();
  fakeDb.row = storedRow();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-service-role-ficticia");
  vi.stubEnv("TIKTOK_CLIENT_KEY", "ck-ficticio");
  vi.stubEnv("TIKTOK_CLIENT_SECRET", "cs-secreto-ficticio");
  silenceErrors();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const videos = async () => {
  const { res, state } = mockRes();
  await handleTikTokVideos(getReq(), res);
  return state;
};

/** Ejecuta la petición avanzando el reloj (la espera de un refresh ajeno usa setTimeout). */
async function videosWithTimers() {
  vi.useFakeTimers({ now: NOW });
  const pending = videos();
  await vi.advanceTimersByTimeAsync(10_000);
  return pending;
}

const seed = (source: string = SOURCE, at: number = NOW - HOUR) =>
  seedSnapshot("tiktok-videos", source, validPayload("tiktok-videos"), at);

const TRANSIENT: [string, Route][] = [
  [
    "error de red",
    () => {
      throw new TypeError("fetch failed");
    },
  ],
  [
    "timeout",
    () => {
      throw new DOMException("timeout", "TimeoutError");
    },
  ],
  ["HTTP 500 internal_error", listError(500, "internal_error")],
  [
    "HTTP 502 con cuerpo no JSON",
    () => new Response("<html>bad gateway</html>", { status: 502 }),
  ],
  ["HTTP 503", () => jsonResponse({}, 503)],
  ["HTTP 429 rate_limit_exceeded", listError(429, "rate_limit_exceeded")],
  ["rate_limit_exceeded con HTTP 200", listError(200, "rate_limit_exceeded")],
];

const NOT_ELIGIBLE: [string, Route][] = [
  ["401 access_token_invalid", listError(401, "access_token_invalid")],
  ["401 scope_not_authorized", listError(401, "scope_not_authorized")],
  ["400 scope_permission_missed", listError(400, "scope_permission_missed")],
  ["400 invalid_params", listError(400, "invalid_params")],
  ["403", () => jsonResponse({}, 403)],
  ["404", () => jsonResponse({}, 404)],
  ["código desconocido con HTTP 200", listError(200, "algo_raro")],
  [
    "HTTP 200 con cuerpo no JSON",
    () => new Response("<html>ok?</html>", { status: 200 }),
  ],
];

// ===================================================================================
describe("videos — camino fresco", () => {
  it("devuelve los videos con la forma y la caché de siempre y actualiza el snapshot", async () => {
    stubTikTok();
    const state = await videos();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(FRESH_VIDEOS);
    expect(state.headers["Cache-Control"]).toBe(FRESH_CACHE);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
    expect(snapshotDb.rows.get("tiktok-videos")).toMatchObject({
      resource: "tiktok-videos",
      source_id: SOURCE,
      payload: FRESH_VIDEOS,
    });
  });

  it("[] real (data.videos vacío) sustituye al snapshot anterior", async () => {
    seed();
    stubTikTok(() =>
      jsonResponse({ data: { videos: [], has_more: false }, error: { code: "ok" } }),
    );
    const state = await videos();

    expect(state.status).toBe(200);
    expect(state.body).toEqual([]);
    expect(snapshotDb.rows.get("tiktok-videos")?.payload).toEqual([]);
  });

  it("no escribe fuera de Production", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    stubTikTok();
    expect((await videos()).status).toBe(200);
    expect(countSnapshotOps("upsert")).toBe(0);
  });

  it("éxito + fallo o excepción de escritura → respuesta fresca", async () => {
    for (const inject of [
      () => (snapshotDb.failOn.upsert = { code: "23514" }),
      () => (snapshotDb.throwOn.upsert = new Error("boom")),
    ]) {
      resetSnapshotDb();
      inject();
      stubTikTok();
      const state = await videos();

      expect(state.status).toBe(200);
      expect(state.body).toEqual(FRESH_VIDEOS);
      expect(state.headers["Cache-Control"]).toBe(FRESH_CACHE);
    }
  });

  it("éxito + escritura que no termina (2 s) → respuesta fresca", async () => {
    snapshotDb.hang.upsert = true;
    stubTikTok();
    vi.useFakeTimers({ now: NOW });
    const pending = videos();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_OPERATION_TIMEOUT_MS + 100);
    const state = await pending;

    expect(state.status).toBe(200);
    expect(state.body).toEqual(FRESH_VIDEOS);
  });

  it("ni tokens ni datos de la conexión llegan al snapshot ni a la respuesta", async () => {
    stubTikTok();
    const state = await videos();
    const stored = JSON.stringify([...snapshotDb.rows.values()].map((r) => r.payload));

    for (const text of [stored, visibleText(state)]) {
      for (const secret of [ACCESS, REFRESH, CONNECTION_ID, OPEN_ID, "access_token"]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});

describe("videos — malformado NO es vacío", () => {
  const malformed: [string, () => Response][] = [
    [
      "HTTP 200 con cuerpo no JSON",
      () => new Response("<html>ok</html>", { status: 200 }),
    ],
    ["HTTP 200 con cuerpo vacío", () => new Response("", { status: 200 })],
    ["cuerpo {}", () => jsonResponse({})],
    ["sin data", () => jsonResponse({ error: { code: "ok" } })],
    ["data {} sin videos", () => jsonResponse({ data: {}, error: { code: "ok" } })],
    ["videos nulo", () => jsonResponse({ data: { videos: null } })],
    ["videos no es una lista", () => jsonResponse({ data: { videos: "x" } })],
    ["videos es un objeto", () => jsonResponse({ data: { videos: {} } })],
    ["data es una lista", () => jsonResponse({ data: [] })],
    ["cuerpo es una lista", () => jsonResponse([])],
    ["cuerpo null", () => jsonResponse(null)],
    [
      "elementos que no parecen videos",
      () => jsonResponse({ data: { videos: [{ foo: 1 }, { bar: 2 }] } }),
    ],
    ["elementos nulos o escalares", () => jsonResponse({ data: { videos: [null, 3] } })],
  ];

  it.each(malformed)("%s → 502, nunca [] ni snapshot, y no escribe", async (_n, list) => {
    seed();
    const before = structuredClone([...snapshotDb.rows.entries()]);
    stubTikTok(list);
    const state = await videos();

    expect(state.status).toBe(502);
    expect(state.body).toEqual(ERROR_BODY);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
    expect(countSnapshotOps("upsert")).toBe(0);
    expect([...snapshotDb.rows.entries()]).toEqual(before);
  });

  it("un video suelto incompleto se descarta sin romper la lista", async () => {
    stubTikTok(() =>
      jsonResponse({
        data: {
          videos: [apiVideo, { ...apiVideo, id: "7002", share_url: "http://x.test/v" }],
        },
      }),
    );
    const state = await videos();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(FRESH_VIDEOS);
  });
});

describe("videos — fallback ante fallos de disponibilidad", () => {
  beforeEach(() => {
    seed();
  });

  it.each(TRANSIENT)("%s + snapshot válido → snapshot", async (_n, list) => {
    stubTikTok(list);
    const state = await videos();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(validPayload("tiktok-videos"));
    expect(state.headers["Cache-Control"]).toBe(SHORT_CACHE);
    expect(state.headers["Cache-Control"]).not.toBe(FRESH_CACHE);
    expect(state.headers["X-Content-Source"]).toBe("snapshot");
  });

  it("la respuesta no revela la fuente, la cuenta ni el ciclo de vida", async () => {
    stubTikTok(() => jsonResponse({}, 503));
    const state = await videos();

    for (const text of [
      "instagram:",
      "tiktok:",
      CONNECTION_ID,
      OPEN_ID,
      ACCESS,
      REFRESH,
      "refresh",
    ]) {
      expect(visibleText(state)).not.toContain(text);
    }
  });

  it("un snapshot VACÍO válido se sirve como vacío (no resucita contenido antiguo)", async () => {
    seedSnapshot("tiktok-videos", SOURCE, [], NOW - HOUR);
    stubTikTok(() => jsonResponse({}, 503));
    const state = await videos();

    expect(state.status).toBe(200);
    expect(state.body).toEqual([]);
  });

  it("un fallo NUNCA sobrescribe el snapshot", async () => {
    const before = structuredClone([...snapshotDb.rows.entries()]);
    stubTikTok(() => jsonResponse({}, 503));
    await videos();

    expect(countSnapshotOps("upsert")).toBe(0);
    expect([...snapshotDb.rows.entries()]).toEqual(before);
  });

  it.each(NOT_ELIGIBLE)("%s → error, SIN snapshot", async (_n, list) => {
    stubTikTok(list);
    const state = await videos();

    expect(state.status).toBe(502);
    expect(state.body).toEqual(ERROR_BODY);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("proveedor caído + lectura del snapshot caída → el mismo error que sin snapshots", async () => {
    stubTikTok(() => jsonResponse({}, 503));
    resetSnapshotDb();
    const baseline = await videos();

    for (const inject of [
      () => (snapshotDb.failOn.select = { code: "XX000" }),
      () => (snapshotDb.throwOn.select = new Error("boom")),
    ]) {
      resetSnapshotDb();
      inject();
      stubTikTok(() => jsonResponse({}, 503));
      const state = await videos();
      expect(state.status).toBe(baseline.status);
      expect(state.body).toEqual(baseline.body);
    }
    expect(baseline.status).toBe(502);
  });
});

describe("videos — token rechazado NUNCA sirve snapshot", () => {
  beforeEach(() => {
    seed();
  });

  it("access_token_invalid: sin snapshot y el access token queda caducado para que el siguiente refresque", async () => {
    stubTikTok(listError(401, "access_token_invalid"));
    const state = await videos();

    expect(state.status).toBe(502);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
    expect(countOps("invalidate-access")).toBe(1);
    // Solo el access token se caduca: el refresh token (y la reautorización) no se tocan.
    expect(Date.parse(String(fakeDb.row?.access_token_expires_at))).toBeLessThanOrEqual(
      NOW,
    );
    expect(fakeDb.row?.refresh_token).toBe(REFRESH);
    expect(fakeDb.row?.refresh_token_expires_at).toBe(iso(300 * DAY));
    expect(countOps("invalidate")).toBe(0);
  });

  it("tras access_token_invalid la siguiente petición pasa por el refresh y se recupera sola", async () => {
    stubTikTok(listError(401, "access_token_invalid"));
    await videos();

    const fetchMock = stubTikTok();
    const state = await videos();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(FRESH_VIDEOS);
    expect(fetchMock.mock.calls.some(([url]) => url === TOKEN_URL)).toBe(true);
    expect(fakeDb.row?.access_token).toBe(NEW_ACCESS);
  });

  it("solo se marca el access token rechazado: una reautorización posterior no se pisa", async () => {
    stubTikTok(() => {
      // Mientras esta petición espera a TikTok, el ADMIN reautoriza (otro access token).
      fakeDb.row = storedRow({ access_token: "act.reautorizado-ficticio" });
      return listError(401, "access_token_invalid")();
    });
    await videos();

    expect(fakeDb.row?.access_token).toBe("act.reautorizado-ficticio");
    expect(fakeDb.row?.access_token_expires_at).toBe(iso(6 * HOUR));
  });

  it("invalid_grant al refrescar: persiste la reautorización y NUNCA sirve snapshot", async () => {
    fakeDb.row = expiredRow();
    stubTikTok(undefined, () => jsonResponse({ error: "invalid_grant" }, 400));
    const state = await videos();

    expect(state.status).toBe(503);
    expect(state.body).toEqual(ERROR_BODY);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
    // 9H-3: la fila queda con el refresh token caducado (reauth_required).
    expect(countOps("invalidate")).toBe(1);
    expect(Date.parse(String(fakeDb.row?.refresh_token_expires_at))).toBeLessThanOrEqual(
      NOW,
    );

    // Y la siguiente petición ni llega a TikTok ni lee el snapshot.
    resetSnapshotDb();
    seed();
    const fetchMock = stubTikTok(() => jsonResponse({}, 503));
    const again = await videos();
    expect(again.status).toBe(503);
    expect(again.headers["X-Content-Source"]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(snapshotDb.ops).toEqual([]);
  });

  it("refresh token caducado (ciclo de vida): 503, sin snapshot y sin leerlo", async () => {
    fakeDb.row = expiredRow({ refresh_token_expires_at: iso(-1000) });
    const fetchMock = stubTikTok();
    const state = await videos();

    expect(state.status).toBe(503);
    expect(state.body).toEqual(ERROR_BODY);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(snapshotDb.ops).toEqual([]);
  });

  it("access token aún vigente pero refresh token ya caducado: no se abre el snapshot", async () => {
    fakeDb.row = storedRow({ refresh_token_expires_at: iso(-1000) });
    stubTikTok(() => jsonResponse({}, 503));
    const state = await videos();

    expect(state.status).toBe(502);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
    expect(snapshotDb.ops).toEqual([]);
  });
});

describe("videos — connection-first: sin conexión utilizable NO hay snapshot", () => {
  beforeEach(() => {
    seed();
  });

  it("desconectado (sin fila): 503, sin llamar a TikTok y sin leer el snapshot", async () => {
    fakeDb.row = null;
    const fetchMock = stubTikTok();
    const state = await videos();

    expect(state.status).toBe(503);
    expect(state.body).toEqual(ERROR_BODY);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(snapshotDb.ops).toEqual([]);
  });

  it("lectura de la conexión rota (error o excepción de Supabase): sin snapshot", async () => {
    for (const inject of [
      () => (fakeDb.failOn.select = { code: "XX000" }),
      () => (fakeDb.throwOn.select = new Error("boom")),
    ]) {
      resetFakeDb();
      fakeDb.row = storedRow();
      inject();
      stubTikTok(() => jsonResponse({}, 503));
      const state = await videos();

      expect(state.status).toBe(500);
      expect(state.headers["X-Content-Source"]).toBeUndefined();
      expect(snapshotDb.ops).toEqual([]);
    }
  });

  it("fila con formato inválido: sin snapshot", async () => {
    fakeDb.row = storedRow({ refresh_token: undefined });
    stubTikTok(() => jsonResponse({}, 503));
    const state = await videos();

    expect(state.status).toBe(500);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
    expect(snapshotDb.ops).toEqual([]);
  });

  it("fila sin id de conexión: no se puede establecer la fuente → ni se lee ni se escribe", async () => {
    fakeDb.row = storedRow({ id: undefined });
    stubTikTok();
    expect((await videos()).status).toBe(200);
    expect(snapshotDb.ops).toEqual([]);

    stubTikTok(() => jsonResponse({}, 503));
    const failed = await videos();
    expect(failed.status).toBe(502);
    expect(failed.headers["X-Content-Source"]).toBeUndefined();
  });

  it("desconexión EN VUELO: TikTok falla después de desconectar → no se sirve (se relee la conexión)", async () => {
    stubTikTok(() => {
      fakeDb.row = null;
      return jsonResponse({}, 503);
    });
    const state = await videos();

    expect(state.status).toBe(502);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("reautorización pendiente EN VUELO (refresh token caducado entretanto): no se sirve", async () => {
    stubTikTok(() => {
      fakeDb.row = storedRow({ refresh_token_expires_at: iso(-1000) });
      return jsonResponse({}, 503);
    });
    expect((await videos()).headers["X-Content-Source"]).toBeUndefined();
  });

  it("lectura de la conexión rota EN VUELO (no se puede confirmar la fuente): no se sirve", async () => {
    stubTikTok(() => {
      fakeDb.failOn.select = { code: "XX000" };
      return jsonResponse({}, 503);
    });
    expect((await videos()).headers["X-Content-Source"]).toBeUndefined();
  });

  it("una desconexión con orfandad: aunque quede un snapshot escrito, sin fila nadie lo sirve", async () => {
    stubTikTok(() => {
      fakeDb.row = null;
      return jsonResponse(listOk);
    });
    await videos();
    expect(snapshotDb.rows.get("tiktok-videos")?.source_id).toBe(SOURCE);

    const fetchMock = stubTikTok(() => jsonResponse({}, 503));
    const later = await videos();
    expect(later.status).toBe(503);
    expect(later.headers["X-Content-Source"]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("videos — refresh en curso y fallos del refresh", () => {
  beforeEach(() => {
    seed();
  });

  it("refresh_in_progress (otra petición refresca, fila y refresh token vigentes) → snapshot", async () => {
    fakeDb.row = expiredRow({ refresh_lock_until: iso(20_000) });
    const fetchMock = stubTikTok();
    const state = await videosWithTimers();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(validPayload("tiktok-videos"));
    expect(state.headers["Cache-Control"]).toBe(SHORT_CACHE);
    expect(state.headers["X-Content-Source"]).toBe("snapshot");
    // Sin llamar a TikTok (ni token ni lista) y sin tocar la fila: no es un reauth_required.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fakeDb.row?.refresh_token).toBe(REFRESH);
    expect(countOps("invalidate")).toBe(0);
  });

  it("refresh_in_progress SIN snapshot válido → 503 de siempre", async () => {
    resetSnapshotDb();
    fakeDb.row = expiredRow({ refresh_lock_until: iso(20_000) });
    stubTikTok();
    const state = await videosWithTimers();

    expect(state.status).toBe(503);
    expect(state.body).toEqual(ERROR_BODY);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("refresh_in_progress con el refresh token ya caducado NO es refresh_in_progress: sin snapshot", async () => {
    fakeDb.row = expiredRow({
      refresh_lock_until: iso(20_000),
      refresh_token_expires_at: iso(-1000),
    });
    stubTikTok();
    const state = await videosWithTimers();

    expect(state.status).toBe(503);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("refresh_in_progress y la fila desaparece (desconexión) mientras se espera: sin snapshot", async () => {
    fakeDb.row = expiredRow({ refresh_lock_until: iso(20_000) });
    let reads = 0;
    fakeDb.before.select = () => {
      reads += 1;
      // Tras varias relecturas de la espera, el ADMIN desconecta.
      if (reads === 3) fakeDb.row = null;
    };
    stubTikTok();
    const state = await videosWithTimers();

    expect(state.status).toBe(503);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("refresh_in_progress sin id de conexión: no hay fuente → sin snapshot", async () => {
    fakeDb.row = expiredRow({ refresh_lock_until: iso(20_000), id: undefined });
    stubTikTok();
    const state = await videosWithTimers();

    expect(state.status).toBe(503);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
    expect(snapshotDb.ops).toEqual([]);
  });

  it("el refresh contra TikTok falla por disponibilidad (red / 5xx / 429) → snapshot", async () => {
    const failures: Route[] = [
      () => {
        throw new TypeError("fetch failed");
      },
      () => jsonResponse({ error: "server_error" }, 500),
      () => jsonResponse({ error: "temporarily_unavailable" }, 503),
      () => jsonResponse({}, 429),
    ];
    for (const failure of failures) {
      resetSnapshotDb();
      seed();
      fakeDb.row = expiredRow();
      stubTikTok(undefined, failure);
      const state = await videos();

      expect(state.status).toBe(200);
      expect(state.body).toEqual(validPayload("tiktok-videos"));
      expect(state.headers["X-Content-Source"]).toBe("snapshot");
      // La conexión sigue intacta (un fallo transitorio no es evidencia de revocación).
      expect(fakeDb.row?.refresh_token).toBe(REFRESH);
      expect(countOps("invalidate")).toBe(0);
    }
  });

  it("el refresh devuelve tokens de OTRA cuenta → error, sin snapshot", async () => {
    fakeDb.row = expiredRow();
    stubTikTok(undefined, () => jsonResponse({ ...refreshOk, open_id: "otra-cuenta" }));
    const state = await videos();

    expect(state.status).toBe(502);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("el refresh responde con un rechazo de cliente (400 invalid_client) → sin snapshot", async () => {
    fakeDb.row = expiredRow();
    stubTikTok(undefined, () => jsonResponse({ error: "invalid_client" }, 401));
    const state = await videos();

    expect(state.status).toBe(502);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("credenciales de la app ausentes → error de configuración, sin snapshot", async () => {
    fakeDb.row = expiredRow();
    vi.stubEnv("TIKTOK_CLIENT_SECRET", "");
    stubTikTok();
    const state = await videos();

    expect(state.status).toBe(503);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });
});

describe("videos — fuente: reconexión y cambio de cuenta", () => {
  it("un snapshot de OTRA conexión (desconectar y volver a conectar = otro id) no sirve", async () => {
    seed(socialSourceId("tiktok", OTHER_CONNECTION_ID, OPEN_ID)!);
    stubTikTok(() => jsonResponse({}, 503));
    const state = await videos();

    expect(state.status).toBe(502);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("un snapshot de OTRA cuenta (open_id distinto) no sirve", async () => {
    seed(socialSourceId("tiktok", CONNECTION_ID, "open-id-otra-cuenta")!);
    stubTikTok(() => jsonResponse({}, 503));
    expect((await videos()).status).toBe(502);
  });

  it("reconectar: el snapshot de la conexión antigua no sirve, el nuevo sí tras una petición buena", async () => {
    seed();
    stubTikTok(() => jsonResponse({}, 503));
    expect((await videos()).status).toBe(200);

    fakeDb.row = storedRow({ id: OTHER_CONNECTION_ID });
    stubTikTok(() => jsonResponse({}, 503));
    expect((await videos()).status).toBe(502);

    stubTikTok();
    await videos();
    expect(snapshotDb.rows.get("tiktok-videos")?.source_id).toBe(
      socialSourceId("tiktok", OTHER_CONNECTION_ID, OPEN_ID),
    );
  });

  it("cambiar de cuenta sobre la misma fila invalida el snapshot anterior", async () => {
    seed();
    fakeDb.row = storedRow({ provider_user_id: "open-id-2" });
    stubTikTok(() => jsonResponse({}, 503));

    expect((await videos()).status).toBe(502);
  });

  it("caducado (> 24 h) no sirve; con 23 h sí", async () => {
    seed(SOURCE, NOW - SNAPSHOT_MAX_AGE_MS.social - 1_000);
    stubTikTok(() => jsonResponse({}, 503));
    expect((await videos()).status).toBe(502);

    seed(SOURCE, NOW - 23 * HOUR);
    expect((await videos()).status).toBe(200);
  });

  it("malformado (clave desconocida, http, forma equivocada) → no se usa ni se repara", async () => {
    const good = validPayload("tiktok-videos");
    const variants: unknown[] = [
      [{ ...good[0], accessToken: "no-deberia-estar" }],
      [{ ...good[0], coverImageUrl: "http://p16.tiktokcdn.com/x.jpeg" }],
      { videos: good },
      "texto",
    ];
    for (const payload of variants) {
      resetSnapshotDb();
      seedSnapshot("tiktok-videos", SOURCE, payload, NOW - HOUR);
      stubTikTok(() => jsonResponse({}, 503));
      const state = await videos();

      expect(state.status).toBe(502);
      expect(countSnapshotOps("upsert")).toBe(0);
    }
  });
});

describe("aislamiento entre proveedores", () => {
  it("un snapshot de Instagram no satisface a TikTok (ni con una fila colocada a mano)", async () => {
    seedSnapshot(
      "tiktok-videos",
      socialSourceId("instagram", CONNECTION_ID, OPEN_ID)!,
      validPayload("tiktok-videos"),
      NOW - HOUR,
    );
    stubTikTok(() => jsonResponse({}, 503));
    expect((await videos()).status).toBe(502);
  });

  it("solo se toca el recurso tiktok-videos", async () => {
    stubTikTok();
    await videos();
    expect(new Set(snapshotDb.ops.map((o) => o.resource))).toEqual(
      new Set(["tiktok-videos"]),
    );
  });
});

describe("isTikTokFallbackEligible", () => {
  const oauth = (httpStatus?: number, code?: string, unreachable = false) =>
    new TikTokOAuthError("m", 502, httpStatus, code, unreachable);

  it("solo red/timeout, 5xx, 429 y los códigos documentados; y refresh_in_progress", () => {
    expect(isTikTokFallbackEligible(oauth(undefined, undefined, true))).toBe(true);
    for (const status of [500, 502, 503, 504]) {
      expect(isTikTokFallbackEligible(oauth(status))).toBe(true);
    }
    expect(isTikTokFallbackEligible(oauth(429, "rate_limit_exceeded"))).toBe(true);
    for (const code of TIKTOK_TRANSIENT_CODES) {
      expect(isTikTokFallbackEligible(oauth(200, code))).toBe(true);
    }
    expect(
      isTikTokFallbackEligible(new TikTokConnectionError("refresh_in_progress")),
    ).toBe(true);
  });

  it("los rechazos de autorización y lo desconocido NO son elegibles (lista cerrada)", () => {
    for (const code of [
      "invalid_grant",
      "access_token_invalid",
      "scope_not_authorized",
      "scope_permission_missed",
      "invalid_client",
      "access_denied",
    ]) {
      expect(isTikTokFallbackEligible(oauth(401, code))).toBe(false);
      // Ni acompañados de un 5xx o de un fallo de red.
      expect(isTikTokFallbackEligible(oauth(500, code))).toBe(false);
      expect(isTikTokFallbackEligible(oauth(undefined, code, true))).toBe(false);
    }
    expect(isTikTokFallbackEligible(oauth(400, "invalid_params"))).toBe(false);
    expect(isTikTokFallbackEligible(oauth())).toBe(false);
    expect(isTikTokFallbackEligible(oauth(400))).toBe(false);
    expect(isTikTokFallbackEligible(oauth(403))).toBe(false);
    expect(isTikTokFallbackEligible(oauth(404))).toBe(false);
    for (const reason of [
      "missing",
      "refresh_token_expired",
      "reauthorization_required",
    ] as const) {
      expect(isTikTokFallbackEligible(new TikTokConnectionError(reason))).toBe(false);
    }
    for (const err of [new Error("x"), new TypeError("y"), "texto", undefined, null]) {
      expect(isTikTokFallbackEligible(err)).toBe(false);
    }
  });
});

describe("registro", () => {
  it("un fallo con snapshot no registra tokens ni la fuente", async () => {
    seed();
    stubTikTok(listError(429, "rate_limit_exceeded"));
    await videos();

    for (const secret of [ACCESS, REFRESH, CONNECTION_ID, "tiktok:"]) {
      expect(errorLog()).not.toContain(secret);
    }
  });
});
