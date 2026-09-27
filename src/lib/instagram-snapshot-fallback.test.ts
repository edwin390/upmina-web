import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleInstagramFeed, handleInstagramProfile } from "./instagram-handlers";
import {
  META_TRANSIENT_CODES,
  InstagramApiError,
  isInstagramFallbackEligible,
} from "./instagram-shared";
import { igFakeDb, resetIgFakeDb } from "./instagram-supabase-fake";
import { SNAPSHOT_OPERATION_TIMEOUT_MS } from "./public-snapshots";
import { SNAPSHOT_MAX_AGE_MS, socialSourceId } from "./public-snapshot-resources";
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

// Integración de los snapshots last-known-good en el feed y el perfil de Instagram (Fase 9H-4,
// checkpoint 4). Corre el handler REAL, la lectura REAL de la conexión (instagram-connection) y los
// snapshots REALES sobre dobles en memoria de Supabase (social_connections y
// public_content_snapshots) y un Meta simulado. La regla congelada: un snapshot NO basta por sí solo;
// solo se sirve si esta petición estableció que la conexión existe y es utilizable, y solo ante un
// fallo transitorio de disponibilidad de Meta.

vi.mock("@supabase/supabase-js", async () => {
  const ig = await import("./instagram-supabase-fake");
  const snap = await import("./public-snapshots-supabase-fake");
  return {
    createClient: (...args: unknown[]) => {
      const social = ig.fakeInstagramCreateClient(...args);
      return {
        from: (table: string) =>
          table === "public_content_snapshots"
            ? snap.fakeCreateClient(...args).from(table)
            : social.from(table),
      };
    },
  };
});

const CONNECTION_ID = "0b8e5f5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const OTHER_CONNECTION_ID = "9c1d2e3f-4a5b-4c6d-8e7f-a0b1c2d3e4f5";
const USER_ID = "17841400000000001";
const SOURCE = socialSourceId("instagram", CONNECTION_ID, USER_ID)!;
const TOKEN = "IGAA-token-ficticio-secreto";
const SHORT_CACHE = "s-maxage=60, stale-while-revalidate=120";
const FEED_CACHE = "s-maxage=900, stale-while-revalidate=1800";
const PROFILE_CACHE = "s-maxage=3600, stale-while-revalidate=7200";

const IMG =
  "https://scontent-iad3-2.cdninstagram.com/v/t51.29350-15/synthetic.jpg?oe=6A2C3D4E";
const AVATAR =
  "https://scontent-iad6-1.cdninstagram.com/v/t51.2885-19/synthetic-avatar.jpg";

function metaItem(id: string) {
  return {
    id,
    media_type: "IMAGE",
    media_url: IMG,
    permalink: `https://www.instagram.com/p/Synthetic${id}/`,
    timestamp: "2026-09-18T19:00:31+0000",
    username: "cuentaficticia",
    caption: `Pie ${id}`,
    like_count: 3,
    comments_count: 1,
    media_product_type: "FEED",
  };
}

const FRESH_FEED = ["1001", "1002"].map((id) => ({
  id,
  mediaType: "IMAGE",
  imageUrl: IMG,
  productType: "FEED",
  permalink: `https://www.instagram.com/p/Synthetic${id}/`,
  caption: `Pie ${id}`,
  timestamp: "2026-09-18T19:00:31+00:00",
  username: "cuentaficticia",
  likeCount: 3,
  commentsCount: 1,
}));

const FRESH_PROFILE = { username: "cuentaficticia", profilePictureUrl: AVATAR };

interface Meta {
  media?: () => Response | Promise<Response>;
  profile?: () => Response | Promise<Response>;
}

function stubMeta(routes: Meta = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/me/media") {
      return (
        routes.media?.() ?? jsonResponse({ data: [metaItem("1001"), metaItem("1002")] })
      );
    }
    if (path === "/me") {
      return (
        routes.profile?.() ??
        jsonResponse({
          id: USER_ID,
          username: "cuentaficticia",
          profile_picture_url: AVATAR,
        })
      );
    }
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const metaError =
  (code: number, status = 400, type = "OAuthException") =>
  () =>
    jsonResponse({ error: { type, code, message: `no filtrar ${TOKEN}` } }, status);

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    provider: "instagram",
    provider_user_id: USER_ID,
    access_token: TOKEN,
    // Lejos de caducar (sin renovación) y de la ventana de aviso.
    access_token_expires_at: new Date(Date.now() + 40 * 24 * HOUR).toISOString(),
    scope: "instagram_business_basic",
    refresh_lock_until: null,
    ...overrides,
  };
}

const errorLog = () =>
  vi
    .mocked(console.error)
    .mock.calls.map((c) => c.join(" "))
    .join("\n");

beforeEach(() => {
  resetSnapshotDb();
  resetIgFakeDb();
  igFakeDb.rows.instagram = connectionRow();
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-service-role-ficticia");
  vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "");
  silenceErrors();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const feed = async () => {
  const { res, state } = mockRes();
  await handleInstagramFeed(getReq(), res);
  return state;
};
const profile = async () => {
  const { res, state } = mockRes();
  await handleInstagramProfile(getReq(), res);
  return state;
};

const seedFeed = (source: string = SOURCE, at?: number) =>
  seedSnapshot("instagram-feed", source, validPayload("instagram-feed"), at);
const seedProfile = (source: string = SOURCE, at?: number) =>
  seedSnapshot("instagram-profile", source, validPayload("instagram-profile"), at);

/** Fallos de DISPONIBILIDAD de Meta: cada uno permite servir el snapshot. */
const TRANSIENT: [string, () => Response | Promise<Response>][] = [
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
  ["HTTP 500", () => jsonResponse({}, 500)],
  [
    "HTTP 502 con cuerpo no JSON",
    () => new Response("<html>bad gateway</html>", { status: 502 }),
  ],
  ["HTTP 503", () => jsonResponse({}, 503)],
  ["HTTP 429", () => jsonResponse({}, 429)],
  ...[...META_TRANSIENT_CODES].map(
    (code): [string, () => Response | Promise<Response>] => [
      `código de Meta ${code} (límite/temporal)`,
      metaError(code),
    ],
  ),
];

/** Fallos que NO son disponibilidad: nunca sirven snapshot. */
const NOT_ELIGIBLE: [string, () => Response | Promise<Response>][] = [
  ["permisos (10)", metaError(10)],
  ["permisos (200)", metaError(200)],
  ["error desconocido (1)", metaError(1)],
  ["bloqueo por políticas (368)", metaError(368)],
  ["parámetro inválido (100)", metaError(100)],
  ["HTTP 400 sin código", () => jsonResponse({}, 400)],
  ["HTTP 403", () => jsonResponse({}, 403)],
  ["HTTP 404", () => jsonResponse({}, 404)],
  [
    "HTTP 200 con cuerpo no JSON",
    () => new Response("<html>ok?</html>", { status: 200 }),
  ],
];

// ===================================================================================
describe("feed — camino fresco", () => {
  it("devuelve el feed con la forma y la caché de siempre y actualiza el snapshot", async () => {
    stubMeta();
    const state = await feed();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(FRESH_FEED);
    expect(state.headers["Cache-Control"]).toBe(FEED_CACHE);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
    expect(snapshotDb.rows.get("instagram-feed")).toMatchObject({
      resource: "instagram-feed",
      source_id: SOURCE,
      payload: FRESH_FEED,
    });
  });

  it("un feed vacío VÁLIDO ({ data: [] }) sustituye al snapshot anterior", async () => {
    seedFeed();
    stubMeta({ media: () => jsonResponse({ data: [] }) });
    const state = await feed();

    expect(state.status).toBe(200);
    expect(state.body).toEqual([]);
    expect(snapshotDb.rows.get("instagram-feed")?.payload).toEqual([]);
  });

  it("no escribe fuera de Production", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    stubMeta();
    const state = await feed();

    expect(state.status).toBe(200);
    expect(countSnapshotOps("upsert")).toBe(0);
  });

  it("éxito + fallo o excepción de escritura → respuesta fresca", async () => {
    for (const inject of [
      () => (snapshotDb.failOn.upsert = { code: "23514" }),
      () => (snapshotDb.throwOn.upsert = new Error("boom")),
    ]) {
      resetSnapshotDb();
      inject();
      stubMeta();
      const state = await feed();

      expect(state.status).toBe(200);
      expect(state.body).toEqual(FRESH_FEED);
      expect(state.headers["Cache-Control"]).toBe(FEED_CACHE);
    }
  });

  it("éxito + escritura que no termina (2 s) → respuesta fresca", async () => {
    vi.useFakeTimers({ now: NOW });
    igFakeDb.rows.instagram = connectionRow({
      access_token_expires_at: new Date(NOW + 40 * 24 * HOUR).toISOString(),
    });
    snapshotDb.hang.upsert = true;
    stubMeta();
    const pending = feed();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_OPERATION_TIMEOUT_MS + 100);
    const state = await pending;

    expect(state.status).toBe(200);
    expect(state.body).toEqual(FRESH_FEED);
  });

  it("ningún token, fuente ni dato de la conexión llega al snapshot ni a la respuesta", async () => {
    stubMeta();
    const state = await feed();
    const stored = JSON.stringify([...snapshotDb.rows.values()].map((r) => r.payload));

    for (const text of [stored, visibleText(state)]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("access_token");
      expect(text).not.toContain(CONNECTION_ID);
    }
  });
});

describe("feed — malformado NO es vacío", () => {
  const malformed: [string, () => Response][] = [
    ["cuerpo {}", () => jsonResponse({})],
    ["data nulo", () => jsonResponse({ data: null })],
    ["data no es una lista", () => jsonResponse({ data: { id: "1" } })],
    ["data es un texto", () => jsonResponse({ data: "x" })],
    ["cuerpo null", () => jsonResponse(null)],
    ["cuerpo es una lista", () => jsonResponse([])],
    ["cuerpo es un texto", () => jsonResponse("hola")],
    [
      "elementos que no parecen media",
      () => jsonResponse({ data: [{ foo: 1 }, { bar: 2 }] }),
    ],
    ["elementos nulos o escalares", () => jsonResponse({ data: [null, 3] })],
    ["HTTP 200 con cuerpo no JSON", () => new Response("<html>", { status: 200 })],
  ];

  it.each(malformed)(
    "%s → error 502, nunca [] ni snapshot, y no escribe",
    async (_n, media) => {
      seedFeed();
      const before = structuredClone([...snapshotDb.rows.entries()]);
      stubMeta({ media });
      const state = await feed();

      expect(state.status).toBe(502);
      expect(state.body).toEqual({ error: "No se pudo obtener el feed de Instagram" });
      expect(state.headers["X-Content-Source"]).toBeUndefined();
      expect(countSnapshotOps("upsert")).toBe(0);
      expect([...snapshotDb.rows.entries()]).toEqual(before);
    },
  );

  it("un elemento suelto que no se puede pintar se descarta sin romper la lista", async () => {
    stubMeta({
      media: () =>
        jsonResponse({
          data: [metaItem("1001"), { id: "9", media_type: "STORY" }, metaItem("1002")],
        }),
    });
    const state = await feed();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(FRESH_FEED);
  });
});

describe("feed — fallback ante fallos de disponibilidad", () => {
  beforeEach(() => {
    seedFeed();
  });

  it.each(TRANSIENT)("%s + snapshot válido → snapshot", async (_n, media) => {
    stubMeta({ media });
    const state = await feed();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(validPayload("instagram-feed"));
    expect(state.headers["Cache-Control"]).toBe(SHORT_CACHE);
    expect(state.headers["Cache-Control"]).not.toBe(FEED_CACHE);
    expect(state.headers["X-Content-Source"]).toBe("snapshot");
  });

  it("la respuesta no revela la fuente, la cuenta ni el token", async () => {
    stubMeta({ media: () => jsonResponse({}, 503) });
    const state = await feed();

    expect(visibleText(state)).not.toContain(SOURCE);
    expect(visibleText(state)).not.toContain("instagram:");
    expect(visibleText(state)).not.toContain(CONNECTION_ID);
    expect(visibleText(state)).not.toContain(USER_ID);
    expect(visibleText(state)).not.toContain(TOKEN);
  });

  it("un snapshot VACÍO válido se sirve como vacío (no resucita contenido antiguo)", async () => {
    seedSnapshot("instagram-feed", SOURCE, []);
    stubMeta({ media: () => jsonResponse({}, 503) });
    const state = await feed();

    expect(state.status).toBe(200);
    expect(state.body).toEqual([]);
    expect(state.headers["X-Content-Source"]).toBe("snapshot");
  });

  it("un fallo NUNCA sobrescribe el snapshot", async () => {
    const before = structuredClone([...snapshotDb.rows.entries()]);
    stubMeta({ media: () => jsonResponse({}, 503) });
    await feed();

    expect(countSnapshotOps("upsert")).toBe(0);
    expect([...snapshotDb.rows.entries()]).toEqual(before);
  });

  it.each(NOT_ELIGIBLE)("%s → error, SIN snapshot", async (_n, media) => {
    stubMeta({ media });
    const state = await feed();

    expect(state.status).toBe(502);
    expect(state.body).toEqual({ error: "No se pudo obtener el feed de Instagram" });
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("proveedor caído + lectura del snapshot caída → el mismo error que sin snapshots", async () => {
    stubMeta({ media: () => jsonResponse({}, 503) });
    resetSnapshotDb();
    const baseline = await feed();

    resetSnapshotDb();
    snapshotDb.failOn.select = { code: "XX000" };
    const broken = await feed();
    resetSnapshotDb();
    snapshotDb.throwOn.select = new Error("boom");
    const thrown = await feed();

    for (const state of [broken, thrown]) {
      expect(state.status).toBe(baseline.status);
      expect(state.body).toEqual(baseline.body);
    }
    expect(baseline.status).toBe(502);
  });
});

describe("feed — connection-first: sin conexión utilizable NO hay snapshot", () => {
  beforeEach(() => {
    seedFeed();
    // Mismo fallo transitorio de Meta que sí serviría snapshot con una conexión sana.
    stubMeta({ media: () => jsonResponse({}, 503) });
  });

  const noSnapshot = (state: Awaited<ReturnType<typeof feed>>) => {
    expect(state.headers["X-Content-Source"]).toBeUndefined();
    expect(state.body).toEqual({ error: "No se pudo obtener el feed de Instagram" });
  };

  it("desconectado (sin fila): 503, sin llamar a Meta y sin leer el snapshot", async () => {
    delete igFakeDb.rows.instagram;
    const fetchMock = stubMeta();
    const state = await feed();

    expect(state.status).toBe(503);
    noSnapshot(state);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(snapshotDb.ops).toEqual([]);
  });

  it("reauth_required (token caducado): 503 y sin snapshot", async () => {
    igFakeDb.rows.instagram = connectionRow({
      access_token_expires_at: new Date(Date.now() - HOUR).toISOString(),
    });
    const state = await feed();

    expect(state.status).toBe(503);
    noSnapshot(state);
    expect(snapshotDb.ops).toEqual([]);
  });

  it("reauth_required persistido tras un rechazo previo (caducidad = ahora): sin snapshot", async () => {
    igFakeDb.rows.instagram = connectionRow({
      access_token_expires_at: new Date(Date.now()).toISOString(),
    });
    const state = await feed();

    expect(state.status).toBe(503);
    noSnapshot(state);
  });

  it("código 190: persiste la reautorización, responde 503 y NUNCA sirve snapshot", async () => {
    stubMeta({ media: metaError(190) });
    const state = await feed();

    expect(state.status).toBe(503);
    noSnapshot(state);
    // El ciclo de vida de 9H-3 se conserva: la fila queda caducada (reauth_required) al momento.
    expect(igFakeDb.ops).toContain("invalidate");
    expect(
      Date.parse(String(igFakeDb.rows.instagram?.access_token_expires_at)),
    ).toBeLessThanOrEqual(Date.now());
    // Y la siguiente petición ya ni siquiera llega a Meta.
    const fetchMock = stubMeta({ media: () => jsonResponse({}, 503) });
    const again = await feed();
    expect(again.status).toBe(503);
    noSnapshot(again);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lectura de la conexión rota (error de Supabase o excepción): sin snapshot", async () => {
    for (const inject of [
      () => (igFakeDb.failWith = { code: "XX000" }),
      () => (igFakeDb.throwWith = new Error("boom")),
    ]) {
      resetIgFakeDb();
      igFakeDb.rows.instagram = connectionRow();
      inject();
      const state = await feed();

      expect(state.status).toBe(500);
      noSnapshot(state);
      expect(snapshotDb.ops).toEqual([]);
    }
  });

  it("fila con formato inválido: sin snapshot", async () => {
    igFakeDb.rows.instagram = connectionRow({ access_token: "" });
    const state = await feed();

    expect(state.status).toBe(500);
    noSnapshot(state);
    expect(snapshotDb.ops).toEqual([]);
  });

  it("fila sin id de conexión: no se puede establecer la fuente → ni se lee ni se escribe", async () => {
    igFakeDb.rows.instagram = connectionRow({ id: undefined });
    stubMeta();
    const ok = await feed();
    expect(ok.status).toBe(200);
    expect(snapshotDb.ops).toEqual([]);

    stubMeta({ media: () => jsonResponse({}, 503) });
    const failed = await feed();
    expect(failed.status).toBe(502);
    noSnapshot(failed);
  });

  it("solo con Supabase sin configurar (token de desarrollo) hay que ir a Meta, sin snapshots", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "IGAA-solo-desarrollo");
    stubMeta();
    const state = await feed();

    expect(state.status).toBe(200);
    expect(snapshotDb.ops).toEqual([]);
  });

  it("desconexión EN VUELO: Meta falla después de desconectar → no se sirve (se relee la conexión)", async () => {
    stubMeta({
      media: () => {
        delete igFakeDb.rows.instagram; // el ADMIN desconecta mientras esta petición espera a Meta
        return jsonResponse({}, 503);
      },
    });
    const state = await feed();

    expect(state.status).toBe(502);
    noSnapshot(state);
  });

  it("reautorización pendiente EN VUELO (token rechazado entretanto): no se sirve", async () => {
    stubMeta({
      media: () => {
        igFakeDb.rows.instagram = connectionRow({
          access_token_expires_at: new Date(Date.now() - HOUR).toISOString(),
        });
        return jsonResponse({}, 503);
      },
    });
    noSnapshot(await feed());
  });

  it("lectura de la conexión rota EN VUELO (no se puede confirmar la fuente): no se sirve", async () => {
    stubMeta({
      media: () => {
        igFakeDb.failWith = { code: "XX000" };
        return jsonResponse({}, 503);
      },
    });
    noSnapshot(await feed());
  });

  it("una desconexión con orfandad: aunque quede un snapshot escrito, sin fila nadie lo sirve", async () => {
    // Petición en vuelo que termina DESPUÉS de desconectar: escribe un snapshot huérfano...
    stubMeta({
      media: () => {
        delete igFakeDb.rows.instagram;
        return jsonResponse({ data: [metaItem("1001")] });
      },
    });
    await feed();
    expect(snapshotDb.rows.get("instagram-feed")?.source_id).toBe(SOURCE);

    // ...pero las siguientes peticiones no pueden usarlo: no hay conexión.
    const fetchMock = stubMeta({ media: () => jsonResponse({}, 503) });
    const later = await feed();
    expect(later.status).toBe(503);
    expect(later.headers["X-Content-Source"]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("feed — fuente: reconexión y cambio de cuenta", () => {
  it("un snapshot de OTRA conexión (desconectar y volver a conectar = otro id) no sirve", async () => {
    seedFeed(socialSourceId("instagram", OTHER_CONNECTION_ID, USER_ID)!);
    stubMeta({ media: () => jsonResponse({}, 503) });
    const state = await feed();

    expect(state.status).toBe(502);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("un snapshot de OTRA cuenta (provider_user_id distinto) no sirve", async () => {
    seedFeed(socialSourceId("instagram", CONNECTION_ID, "17841499999999999")!);
    stubMeta({ media: () => jsonResponse({}, 503) });
    expect((await feed()).status).toBe(502);
  });

  it("reconectar: el snapshot de la conexión antigua no sirve, el nuevo sí tras una petición buena", async () => {
    seedFeed();
    stubMeta({ media: () => jsonResponse({}, 503) });
    expect((await feed()).status).toBe(200);

    // Desconectar y volver a conectar la misma cuenta: fila NUEVA (otro uuid).
    igFakeDb.rows.instagram = connectionRow({ id: OTHER_CONNECTION_ID });
    stubMeta({ media: () => jsonResponse({}, 503) });
    expect((await feed()).status).toBe(502);

    stubMeta();
    await feed();
    expect(snapshotDb.rows.get("instagram-feed")?.source_id).toBe(
      socialSourceId("instagram", OTHER_CONNECTION_ID, USER_ID),
    );
  });

  it("cambiar de cuenta sobre la misma fila invalida el snapshot anterior", async () => {
    seedFeed();
    igFakeDb.rows.instagram = connectionRow({ provider_user_id: "17841488888888888" });
    stubMeta({ media: () => jsonResponse({}, 503) });

    expect((await feed()).status).toBe(502);
  });

  it("caducado (> 24 h) no sirve; con 23 h sí", async () => {
    seedFeed(SOURCE, Date.now() - SNAPSHOT_MAX_AGE_MS.social - 1_000);
    stubMeta({ media: () => jsonResponse({}, 503) });
    expect((await feed()).status).toBe(502);

    seedFeed(SOURCE, Date.now() - 23 * HOUR);
    expect((await feed()).status).toBe(200);
  });

  it("malformado (clave desconocida, http, forma equivocada) → no se usa ni se repara", async () => {
    const good = validPayload("instagram-feed");
    const variants: unknown[] = [
      [{ ...good[0], accessToken: "no-deberia-estar" }],
      [{ ...good[0], imageUrl: "http://scontent.cdninstagram.com/x.jpg" }],
      { data: good },
      "texto",
      [{ ...good[0], mediaType: "STORY" }],
    ];
    for (const payload of variants) {
      resetSnapshotDb();
      seedSnapshot("instagram-feed", SOURCE, payload);
      stubMeta({ media: () => jsonResponse({}, 503) });
      const state = await feed();

      expect(state.status).toBe(502);
      expect(countSnapshotOps("upsert")).toBe(0);
    }
  });
});

// ===================================================================================
describe("profile", () => {
  it("fresco: cuerpo, caché de siempre y actualiza el snapshot", async () => {
    stubMeta();
    const state = await profile();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(FRESH_PROFILE);
    expect(state.headers["Cache-Control"]).toBe(PROFILE_CACHE);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
    expect(snapshotDb.rows.get("instagram-profile")).toMatchObject({
      source_id: SOURCE,
      payload: FRESH_PROFILE,
    });
  });

  it("perfil normalizado {} (Meta no devolvió campos opcionales) es válido y se guarda", async () => {
    stubMeta({ profile: () => jsonResponse({ id: USER_ID }) });
    const state = await profile();

    expect(state.status).toBe(200);
    expect(state.body).toEqual({});
    expect(snapshotDb.rows.get("instagram-profile")?.payload).toEqual({});
  });

  it("un cuerpo roto NO se convierte en {}: error, sin snapshot y sin escribir", async () => {
    seedProfile();
    const before = structuredClone([...snapshotDb.rows.entries()]);
    const bad: [string, () => Response][] = [
      ["cuerpo {}", () => jsonResponse({})],
      ["cuerpo null", () => jsonResponse(null)],
      ["lista", () => jsonResponse([])],
      ["texto", () => jsonResponse("hola")],
      ["objeto irreconocible", () => jsonResponse({ foo: 1 })],
      ["no JSON", () => new Response("<html>", { status: 200 })],
    ];
    for (const [, profileResponse] of bad) {
      stubMeta({ profile: profileResponse });
      const state = await profile();

      expect(state.status).toBe(502);
      expect(state.body).toEqual({ error: "No se pudo obtener el perfil de Instagram" });
      expect(state.body).not.toEqual({});
      expect(state.headers["X-Content-Source"]).toBeUndefined();
    }
    expect(countSnapshotOps("upsert")).toBe(0);
    expect([...snapshotDb.rows.entries()]).toEqual(before);
  });

  it.each(TRANSIENT)("%s + snapshot válido → snapshot", async (_n, profileResponse) => {
    seedProfile();
    stubMeta({ profile: profileResponse });
    const state = await profile();

    expect(state.status).toBe(200);
    expect(state.body).toEqual(validPayload("instagram-profile"));
    expect(state.headers["Cache-Control"]).toBe(SHORT_CACHE);
    expect(state.headers["X-Content-Source"]).toBe("snapshot");
  });

  it("un snapshot de perfil {} (válido) se sirve tal cual", async () => {
    seedSnapshot("instagram-profile", SOURCE, {});
    stubMeta({ profile: () => jsonResponse({}, 503) });
    const state = await profile();

    expect(state.status).toBe(200);
    expect(state.body).toEqual({});
  });

  it.each(NOT_ELIGIBLE)("%s → error, SIN snapshot", async (_n, profileResponse) => {
    seedProfile();
    stubMeta({ profile: profileResponse });
    const state = await profile();

    expect(state.status).toBe(502);
    expect(state.headers["X-Content-Source"]).toBeUndefined();
  });

  it("código 190 → 503 y sin snapshot; desconectado o con reauth pendiente → sin snapshot", async () => {
    seedProfile();
    stubMeta({ profile: metaError(190) });
    const rejected = await profile();
    expect(rejected.status).toBe(503);
    expect(rejected.headers["X-Content-Source"]).toBeUndefined();

    for (const row of [
      undefined,
      connectionRow({ access_token_expires_at: new Date(0).toISOString() }),
    ]) {
      if (row) igFakeDb.rows.instagram = row;
      else delete igFakeDb.rows.instagram;
      stubMeta({ profile: () => jsonResponse({}, 503) });
      const state = await profile();
      expect(state.status).toBe(503);
      expect(state.headers["X-Content-Source"]).toBeUndefined();
    }
  });

  it("de otra fuente, caducado o malformado → no se usa", async () => {
    const rows: [string, unknown, number][] = [
      [
        socialSourceId("instagram", OTHER_CONNECTION_ID, USER_ID)!,
        validPayload("instagram-profile"),
        Date.now() - HOUR,
      ],
      [
        SOURCE,
        validPayload("instagram-profile"),
        Date.now() - SNAPSHOT_MAX_AGE_MS.social - 1_000,
      ],
      [SOURCE, { ...validPayload("instagram-profile"), token: "x" }, Date.now() - HOUR],
    ];
    for (const [source, payload, at] of rows) {
      resetSnapshotDb();
      seedSnapshot("instagram-profile", source, payload, at);
      stubMeta({ profile: () => jsonResponse({}, 503) });
      expect((await profile()).status).toBe(502);
    }
  });

  it("proveedor caído + lectura caída → el error de siempre; éxito + escritura caída → fresco", async () => {
    snapshotDb.failOn.select = { code: "XX000" };
    stubMeta({ profile: () => jsonResponse({}, 503) });
    expect((await profile()).status).toBe(502);

    resetSnapshotDb();
    snapshotDb.failOn.upsert = { code: "XX000" };
    stubMeta();
    const state = await profile();
    expect(state.status).toBe(200);
    expect(state.body).toEqual(FRESH_PROFILE);
  });
});

describe("aislamiento entre recursos y proveedores", () => {
  it("el perfil NO satisface el feed y el feed NO satisface el perfil", async () => {
    seedProfile();
    stubMeta({ media: () => jsonResponse({}, 503) });
    expect((await feed()).status).toBe(502);
    expect(snapshotDb.ops).toEqual([{ op: "select", resource: "instagram-feed" }]);

    resetSnapshotDb();
    seedFeed();
    stubMeta({ profile: () => jsonResponse({}, 503) });
    expect((await profile()).status).toBe(502);
    expect(snapshotDb.ops).toEqual([{ op: "select", resource: "instagram-profile" }]);
  });

  it("un snapshot de TikTok no satisface a Instagram (ni con una fila colocada a mano)", async () => {
    seedSnapshot(
      "instagram-feed",
      socialSourceId("tiktok", CONNECTION_ID, USER_ID)!,
      validPayload("instagram-feed"),
    );
    stubMeta({ media: () => jsonResponse({}, 503) });
    expect((await feed()).status).toBe(502);
  });

  it("solo los recursos de feed y perfil se tocan: nunca media por id ni comentarios", async () => {
    stubMeta();
    await feed();
    await profile();

    const resources = new Set(snapshotDb.ops.map((o) => o.resource));
    expect([...resources].sort()).toEqual(["instagram-feed", "instagram-profile"]);
  });
});

describe("isInstagramFallbackEligible", () => {
  const api = (httpStatus?: number, metaCode?: number, failure?: "network" | "timeout") =>
    new InstagramApiError("m", 502, httpStatus, metaCode, undefined, failure);

  it("solo red, timeout, 5xx, 429 y los códigos de Meta documentados", () => {
    expect(isInstagramFallbackEligible(api(undefined, undefined, "network"))).toBe(true);
    expect(isInstagramFallbackEligible(api(undefined, undefined, "timeout"))).toBe(true);
    for (const status of [500, 502, 503, 504, 599]) {
      expect(isInstagramFallbackEligible(api(status))).toBe(true);
    }
    expect(isInstagramFallbackEligible(api(429))).toBe(true);
    for (const code of [2, 4, 17, 32, 341, 613, 80002]) {
      expect(isInstagramFallbackEligible(api(400, code))).toBe(true);
    }
  });

  it("lo desconocido, los permisos y el token NO son elegibles (lista cerrada)", () => {
    expect(isInstagramFallbackEligible(api())).toBe(false);
    expect(isInstagramFallbackEligible(api(400))).toBe(false);
    expect(isInstagramFallbackEligible(api(403))).toBe(false);
    expect(isInstagramFallbackEligible(api(404))).toBe(false);
    for (const code of [1, 3, 10, 100, 190, 200, 210, 299, 368, 9004]) {
      expect(isInstagramFallbackEligible(api(400, code))).toBe(false);
    }
    // 190 nunca elegible aunque llegue con un status 5xx.
    expect(isInstagramFallbackEligible(api(500, 190))).toBe(false);
    for (const err of [new Error("x"), new TypeError("y"), "texto", undefined, null]) {
      expect(isInstagramFallbackEligible(err)).toBe(false);
    }
  });
});

describe("registro", () => {
  it("un fallo con snapshot no registra tokens ni la fuente", async () => {
    seedFeed();
    stubMeta({ media: metaError(4) });
    await feed();

    expect(errorLog()).not.toContain(TOKEN);
    expect(errorLog()).not.toContain(CONNECTION_ID);
    expect(errorLog()).not.toContain("instagram:");
  });
});
