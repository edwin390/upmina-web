import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTENT_SOURCE_HEADER,
  SNAPSHOT_FALLBACK_CACHE_CONTROL,
  openSnapshot,
  sendSnapshotHeaders,
} from "./public-snapshot-fallback";
import {
  ProviderApiError,
  ProviderRequestError,
  isSnapshotFallbackEligible,
  providerErrorFromResponse,
  type ProviderFailureKind,
} from "./provider-http";
import { TwitchApiError } from "./twitch-shared";
import { YouTubeApiError, youtubeListSnapshotResource } from "./youtube-shared";
import {
  socialSourceId,
  twitchSourceId,
  youtubeSourceId,
} from "./public-snapshot-resources";
import { validPayload } from "./public-snapshot-fixtures";
import { resetSnapshotDb, snapshotDb } from "./public-snapshots-supabase-fake";
import { mockRes, seedSnapshot, silenceErrors } from "./snapshot-handler-testkit";

// Elegibilidad de fallo, sesión de snapshot y garantías estáticas de la integración de Twitch y
// YouTube (Fase 9H-4, checkpoint 3).

vi.mock("@supabase/supabase-js", async () => {
  const { fakeCreateClient } = await import("./public-snapshots-supabase-fake");
  return { createClient: fakeCreateClient };
});

const TWITCH = twitchSourceId("canalficticio")!;
const YOUTUBE = youtubeSourceId("UCabcdefghijklmnopqrstuv")!;
const headers = new Headers();

const http = (status: number, reason?: string) =>
  providerErrorFromResponse({ status, headers }, `op: HTTP ${status}`, undefined, reason);

describe("isSnapshotFallbackEligible", () => {
  it.each<ProviderFailureKind>([
    "TIMEOUT",
    "RATE_LIMITED",
    "UPSTREAM_UNAVAILABLE",
    "NETWORK_ERROR",
    "INVALID_RESPONSE",
  ])("%s es elegible", (kind) => {
    expect(isSnapshotFallbackEligible(new ProviderRequestError(kind, "m"))).toBe(true);
  });

  it("un rechazo del proveedor (UPSTREAM_REJECTED) genérico NO es elegible", () => {
    for (const status of [400, 401, 402, 403, 404, 409, 422]) {
      expect(isSnapshotFallbackEligible(http(status))).toBe(false);
    }
  });

  it("429 y 5xx clasificados por status son elegibles", () => {
    expect(isSnapshotFallbackEligible(http(429))).toBe(true);
    for (const status of [500, 502, 503, 504]) {
      expect(isSnapshotFallbackEligible(http(status))).toBe(true);
    }
  });

  it.each([
    "quotaExceeded",
    "rateLimitExceeded",
    "dailyLimitExceeded",
    "userRateLimitExceeded",
  ])("403 con reason %s (cuota/límite documentado) es elegible", (reason) => {
    expect(isSnapshotFallbackEligible(http(403, reason))).toBe(true);
  });

  it.each([
    "keyInvalid",
    "keyExpired",
    "forbidden",
    "accessNotConfigured",
    "ipRefererBlocked",
    "insufficientPermissions",
    "unknown",
    "",
  ])(
    "403 con reason %j (credenciales/configuración/autorización) NO es elegible",
    (reason) => {
      expect(isSnapshotFallbackEligible(http(403, reason))).toBe(false);
    },
  );

  it("403 sin reason NO es elegible", () => {
    expect(isSnapshotFallbackEligible(http(403))).toBe(false);
  });

  it("un reason de cuota solo cuenta con 403: en 400, 401 o 404 no", () => {
    for (const status of [400, 401, 402, 404]) {
      expect(isSnapshotFallbackEligible(http(status, "quotaExceeded"))).toBe(false);
    }
  });

  it("errores que no son de disponibilidad del proveedor NO son elegibles", () => {
    const notEligible = [
      new TwitchApiError("Faltan las credenciales de Twitch", 503),
      new TwitchApiError("El canal de Twitch no existe", 404),
      new TwitchApiError("respuesta con formato inesperado", 502),
      new YouTubeApiError("Faltan variables de entorno de YouTube", 503),
      new YouTubeApiError("respuesta con formato inesperado", 502),
      new ProviderApiError("genérico", 502),
      new TypeError("bug interno"),
      new Error("bug"),
      "texto",
      undefined,
      null,
      { kind: "TIMEOUT" },
    ];
    for (const err of notEligible) expect(isSnapshotFallbackEligible(err)).toBe(false);
  });

  it("el reason no cambia el status público ni el mensaje", () => {
    const err = http(403, "quotaExceeded");
    expect(err.status).toBe(502);
    expect(err.message).toBe("op: HTTP 403");
    expect(err.providerReason).toBe("quotaExceeded");
  });
});

describe("openSnapshot", () => {
  beforeEach(() => {
    resetSnapshotDb();
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-service-role-ficticia");
    silenceErrors();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const unavailable = new ProviderRequestError("UPSTREAM_UNAVAILABLE", "m");

  it("sin recurso o sin fuente es inerte: no crea cliente ni opera", async () => {
    for (const session of [
      openSnapshot(undefined, TWITCH),
      openSnapshot("twitch-clips", undefined),
      openSnapshot(youtubeListSnapshotResource("video", 5), YOUTUBE),
    ]) {
      expect(await session.fallback(unavailable)).toBeUndefined();
      expect(await session.save([])).toBe("skipped");
    }
    expect(snapshotDb.clientsCreated).toBe(0);
    expect(snapshotDb.ops).toEqual([]);
  });

  it("empieza a leer al abrirse (en paralelo con el proveedor), sin esperar a fallback", async () => {
    seedSnapshot("twitch-clips", TWITCH, validPayload("twitch-clips"));
    openSnapshot("twitch-clips", TWITCH);
    await new Promise((r) => setTimeout(r, 0));

    expect(snapshotDb.ops).toEqual([{ op: "select", resource: "twitch-clips" }]);
  });

  it("fallback devuelve el snapshot solo con un fallo elegible", async () => {
    seedSnapshot("twitch-clips", TWITCH, validPayload("twitch-clips"));
    const session = openSnapshot("twitch-clips", TWITCH);

    expect((await session.fallback(unavailable))?.value).toEqual(
      validPayload("twitch-clips"),
    );
    expect(await session.fallback(new TwitchApiError("x", 503))).toBeUndefined();
    expect(await session.fallback(http(403, "keyInvalid"))).toBeUndefined();
  });

  it("un vacío válido es un snapshot (objeto), distinguible de 'no hay snapshot'", async () => {
    seedSnapshot("twitch-latest-video", TWITCH, { empty: true });
    const session = openSnapshot("twitch-latest-video", TWITCH);
    const stale = await session.fallback(unavailable);

    expect(stale).toBeDefined();
    expect(stale?.value).toBeNull();
  });

  it("no hay snapshot → undefined; base de datos caída → undefined sin lanzar", async () => {
    expect(
      await openSnapshot("twitch-clips", TWITCH).fallback(unavailable),
    ).toBeUndefined();

    snapshotDb.throwOn.select = new Error("boom");
    expect(
      await openSnapshot("twitch-clips", TWITCH).fallback(unavailable),
    ).toBeUndefined();
  });

  it("save nunca lanza: devuelve el resultado de writeSnapshot", async () => {
    const session = openSnapshot("twitch-clips", TWITCH);
    expect(await session.save(validPayload("twitch-clips"))).toBe("written");

    snapshotDb.throwOn.upsert = new Error("boom");
    expect(await session.save(validPayload("twitch-clips"))).toBe("failed");
  });

  it("no deja rechazos sin manejar aunque el fallback nunca se pida", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      snapshotDb.throwOn.select = new Error("boom");
      openSnapshot("twitch-clips", TWITCH);
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("openSnapshot — opciones para redes sociales (9H-4, checkpoint 4)", () => {
  beforeEach(() => {
    resetSnapshotDb();
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "srk-service-role-ficticia");
    silenceErrors();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const IG = socialSourceId("instagram", "0b8e5f5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", "1789")!;
  const anyError = new Error("cualquiera");
  const seedIg = () => seedSnapshot("instagram-feed", IG, validPayload("instagram-feed"));

  it("la elegibilidad inyectada REEMPLAZA a la de Twitch/YouTube", async () => {
    seedIg();
    const yes = openSnapshot("instagram-feed", IG, { eligible: () => true });
    const no = openSnapshot("instagram-feed", IG, { eligible: () => false });

    expect(await yes.fallback(anyError)).toBeDefined();
    expect(await no.fallback(new ProviderRequestError("TIMEOUT", "t"))).toBeUndefined();
  });

  it("sin elegibilidad inyectada un error de red social NO es elegible (por defecto es la de proveedores)", async () => {
    seedIg();
    expect(await openSnapshot("instagram-feed", IG).fallback(anyError)).toBeUndefined();
  });

  it("confirm se invoca solo si hay un snapshot que servir y decide si se sirve", async () => {
    const confirm = vi.fn(async () => true);
    const session = () =>
      openSnapshot("instagram-feed", IG, { eligible: () => true, confirm });

    expect(await session().fallback(anyError)).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();

    seedIg();
    expect(await session().fallback(anyError)).toBeDefined();
    expect(confirm).toHaveBeenCalledTimes(1);

    confirm.mockResolvedValueOnce(false);
    expect(await session().fallback(anyError)).toBeUndefined();
  });

  it("confirm que lanza o rechaza = fail-closed: no se sirve", async () => {
    seedIg();
    const throwing = openSnapshot("instagram-feed", IG, {
      eligible: () => true,
      confirm: async () => {
        throw new Error("boom");
      },
    });
    expect(await throwing.fallback(anyError)).toBeUndefined();
  });

  it("confirm no se invoca si el fallo no es elegible", async () => {
    seedIg();
    const confirm = vi.fn(async () => true);
    const session = openSnapshot("instagram-feed", IG, {
      eligible: () => false,
      confirm,
    });

    expect(await session.fallback(anyError)).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("cabeceras del fallback", () => {
  it("caché corta (misma sintaxis que las respuestas parciales) y cabecera de diagnóstico sin datos", () => {
    const { res, state } = mockRes();
    sendSnapshotHeaders(res);

    expect(SNAPSHOT_FALLBACK_CACHE_CONTROL).toBe(
      "s-maxage=60, stale-while-revalidate=120",
    );
    expect(state.headers).toEqual({
      "Cache-Control": "s-maxage=60, stale-while-revalidate=120",
      [CONTENT_SOURCE_HEADER]: "snapshot",
    });
  });
});

describe("canónico de YouTube", () => {
  it("solo videos=12 y shorts=24 tienen recurso", () => {
    expect(youtubeListSnapshotResource("video", 12)).toBe("youtube-videos");
    expect(youtubeListSnapshotResource("short", 24)).toBe("youtube-shorts");
    for (const n of [1, 5, 11, 13, 23, 25, 50]) {
      expect(youtubeListSnapshotResource("video", n)).toBeUndefined();
      expect(youtubeListSnapshotResource("short", n === 12 ? 12 : n)).toBeUndefined();
    }
    expect(youtubeListSnapshotResource("video", 24)).toBeUndefined();
    expect(youtubeListSnapshotResource("short", 12)).toBeUndefined();
    expect(youtubeListSnapshotResource(undefined, 12)).toBeUndefined();
    expect(youtubeListSnapshotResource(undefined, 24)).toBeUndefined();
  });
});

// Comprobaciones estáticas de invariantes estructurales (no sustituyen a los tests de
// comportamiento de los handlers).
const read = (rel: string) => readFileSync(resolve(__dirname, "../..", rel), "utf8");

describe("invariantes estructurales de la integración", () => {
  it("twitch-status no menciona snapshots ni la persistencia", () => {
    const source = read("api/twitch-status.ts");
    expect(source).not.toMatch(/snapshot/i);
    expect(source).not.toMatch(/public-snapshot|supabase/i);
  });

  it("los handlers no duplican TTL/edades: usan la definición central", () => {
    for (const file of [
      "api/twitch-clips.ts",
      "api/twitch-latest-video.ts",
      "api/youtube-latest.ts",
      "api/youtube-videos.ts",
    ]) {
      const source = read(file);
      expect(source).not.toMatch(/48\s*\*|172_?800|SNAPSHOT_MAX_AGE_MS/);
      expect(source).toContain("public-snapshot-fallback");
    }
  });

  it("no se añadió ninguna función serverless de snapshots bajo api/", () => {
    const files = (
      readdirSync(resolve(__dirname, "../../api"), { recursive: true }) as string[]
    ).map(String);
    expect(files.filter((f) => /snapshot/i.test(f))).toEqual([]);
  });
});
