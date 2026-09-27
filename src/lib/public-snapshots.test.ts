import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SNAPSHOT_PAYLOAD_BYTES,
  SNAPSHOT_OPERATION_TIMEOUT_MS,
  deleteSocialSnapshots,
  readSnapshot,
  writeSnapshot,
} from "./public-snapshots";
import {
  SNAPSHOT_MAX_AGE_MS,
  SNAPSHOT_RESOURCES,
  socialSourceId,
  twitchSourceId,
  youtubeSourceId,
  type SnapshotResource,
} from "./public-snapshot-resources";
import {
  countSnapshotOps,
  resetSnapshotDb,
  snapshotDb,
} from "./public-snapshots-supabase-fake";
import { validPayload } from "./public-snapshot-fixtures";

// Persistencia de los snapshots públicos "last-known-good" (Fase 9H-4, checkpoint 2), sobre un
// doble en memoria de public.public_content_snapshots. Comprueba lectura/escritura/borrado, fallo
// abierto, entorno, aislamiento, revalidación y ausencia de datos sensibles.

vi.mock("@supabase/supabase-js", async () => {
  const { fakeCreateClient } = await import("./public-snapshots-supabase-fake");
  return { createClient: fakeCreateClient };
});

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const CONNECTION = "0b8e5f5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const SERVICE_ROLE_KEY = "srk-service-role-ficticia";

const TWITCH = twitchSourceId("canalficticio")!;
const YOUTUBE = youtubeSourceId("UCabcdefghijklmnopqrstuv")!;
const IG = socialSourceId("instagram", CONNECTION, "1789")!;
const TT = socialSourceId("tiktok", CONNECTION, "open-id-01")!;

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetSnapshotDb();
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("VITE_SUPABASE_URL", "https://proyecto-ficticio.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const iso = (ms: number) => new Date(ms).toISOString();

function seed(resource: SnapshotResource, row: Record<string, unknown>) {
  snapshotDb.rows.set(resource, { resource, ...row });
}

describe("escritura", () => {
  it("guarda un valor válido en Production: resource, source_id, payload y captured_at", async () => {
    const value = validPayload("twitch-clips");
    const outcome = await writeSnapshot("twitch-clips", TWITCH, value, NOW);

    expect(outcome).toBe("written");
    expect(snapshotDb.rows.get("twitch-clips")).toEqual({
      resource: "twitch-clips",
      source_id: TWITCH,
      payload: value,
      captured_at: iso(NOW),
    });
    expect(snapshotDb.rows.size).toBe(1);
  });

  it("un valor inválido NO escribe (ni siquiera llega a Supabase)", async () => {
    const bad = validPayload("twitch-clips");
    bad[0].thumbnailUrl = "javascript:alert(1)";

    expect(await writeSnapshot("twitch-clips", TWITCH, bad, NOW)).toBe("invalid");
    expect(snapshotDb.rows.size).toBe(0);
    expect(snapshotDb.ops).toHaveLength(0);
    expect(snapshotDb.clientsCreated).toBe(0);
  });

  it("una URL http se rechaza al escribir", async () => {
    const bad = validPayload("tiktok-videos");
    bad[0].coverImageUrl = bad[0].coverImageUrl.replace("https:", "http:");
    expect(await writeSnapshot("tiktok-videos", TT, bad, NOW)).toBe("invalid");
    expect(snapshotDb.rows.size).toBe(0);
  });

  it("guarda el vacío válido de una lista y el null de un recurso de un solo elemento", async () => {
    expect(await writeSnapshot("youtube-videos", YOUTUBE, [], NOW)).toBe("written");
    expect(snapshotDb.rows.get("youtube-videos")?.payload).toEqual([]);

    expect(await writeSnapshot("twitch-latest-video", TWITCH, null, NOW)).toBe("written");
    expect(snapshotDb.rows.get("twitch-latest-video")?.payload).toEqual({ empty: true });
  });

  it("guarda solo el valor reconstruido: un campo desconocido invalida la escritura", async () => {
    const value = validPayload("instagram-profile");
    const withToken = { ...value, access_token: "tok-ficticio" } as typeof value;
    expect(await writeSnapshot("instagram-profile", IG, withToken, NOW)).toBe("invalid");
    expect(snapshotDb.rows.size).toBe(0);
  });

  it("rechaza un payload que supera el tope de tamaño y acepta uno justo por debajo", async () => {
    const base = validPayload("youtube-latest");
    const overhead = Buffer.byteLength(
      JSON.stringify({ ...base, description: "" }),
      "utf8",
    );
    // La descripción admite hasta 10 000 caracteres: se rellena con varios vídeos hasta el tope.
    const one = { ...validPayload("youtube-shorts")[0], description: "x".repeat(10_000) };
    const list = Array(24).fill(one) as (typeof one)[];
    expect(Buffer.byteLength(JSON.stringify(list), "utf8")).toBeGreaterThan(
      MAX_SNAPSHOT_PAYLOAD_BYTES,
    );
    expect(await writeSnapshot("youtube-shorts", YOUTUBE, list, NOW)).toBe("invalid");
    expect(snapshotDb.rows.size).toBe(0);

    // Justo por debajo del tope (el JSON compacto cabe): se escribe.
    const fits = Array(19).fill(one) as (typeof one)[];
    const bytes = Buffer.byteLength(JSON.stringify(fits), "utf8");
    expect(bytes).toBeLessThanOrEqual(MAX_SNAPSHOT_PAYLOAD_BYTES);
    expect(await writeSnapshot("youtube-shorts", YOUTUBE, fits, NOW)).toBe("written");
    expect(overhead).toBeGreaterThan(0);
  });

  it("el tope de código es menor que el CHECK de la base de datos (262 144 bytes)", () => {
    expect(MAX_SNAPSHOT_PAYLOAD_BYTES).toBeLessThan(262_144);
  });

  it("un recurso arbitrario (incluido twitch-status) no se acepta y no genera ninguna operación", async () => {
    for (const resource of [
      "twitch-status",
      "instagram-media",
      "instagram-comments",
      "x",
    ]) {
      const outcome = await writeSnapshot(
        // @ts-expect-error solo los recursos canónicos son válidos.
        resource,
        TWITCH,
        {},
        NOW,
      );
      expect(outcome).toBe("invalid");
    }
    expect(snapshotDb.ops).toHaveLength(0);
    expect(snapshotDb.rows.size).toBe(0);
  });

  it("un source_id de otro proveedor (cast) se rechaza", async () => {
    const outcome = await writeSnapshot(
      "twitch-clips",
      // @ts-expect-error un source_id de YouTube no es de Twitch (el tipo lo impide).
      YOUTUBE,
      validPayload("twitch-clips"),
      NOW,
    );
    expect(outcome).toBe("invalid");
    expect(snapshotDb.rows.size).toBe(0);

    const cast = "cualquier cosa" as unknown as typeof TWITCH;
    expect(
      await writeSnapshot("twitch-clips", cast, validPayload("twitch-clips"), NOW),
    ).toBe("invalid");
  });
});

describe("escritura: entorno (solo Production)", () => {
  it("Production escribe", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(
      await writeSnapshot("tiktok-videos", TT, validPayload("tiktok-videos"), NOW),
    ).toBe("written");
  });

  it.each(["preview", "development"])(
    "VERCEL_ENV=%s NO escribe ni abre una conexión",
    async (env) => {
      vi.stubEnv("VERCEL_ENV", env);
      expect(
        await writeSnapshot("tiktok-videos", TT, validPayload("tiktok-videos"), NOW),
      ).toBe("skipped");
      expect(snapshotDb.rows.size).toBe(0);
      expect(snapshotDb.clientsCreated).toBe(0);
    },
  );

  it("sin VERCEL_ENV (desarrollo local) o con NODE_ENV=production sin Vercel: no escribe", async () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(
      await writeSnapshot("tiktok-videos", TT, validPayload("tiktok-videos"), NOW),
    ).toBe("skipped");
    expect(snapshotDb.rows.size).toBe(0);
  });

  it("la lectura sí funciona fuera de Production (solo la escritura se suprime)", async () => {
    await writeSnapshot("tiktok-videos", TT, validPayload("tiktok-videos"), NOW);
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await readSnapshot("tiktok-videos", TT, NOW + HOUR))?.value).toEqual(
      validPayload("tiktok-videos"),
    );
  });
});

describe("lectura", () => {
  it("devuelve un snapshot válido y vigente con su fecha de captura", async () => {
    const value = validPayload("twitch-clips");
    await writeSnapshot("twitch-clips", TWITCH, value, NOW);

    const snapshot = await readSnapshot("twitch-clips", TWITCH, NOW + HOUR);
    expect(snapshot).toEqual({ value, capturedAt: iso(NOW) });
  });

  it("devuelve null en los recursos de un solo elemento con vacío válido", async () => {
    await writeSnapshot("youtube-latest", YOUTUBE, null, NOW);
    expect(await readSnapshot("youtube-latest", YOUTUBE, NOW)).toEqual({
      value: null,
      capturedAt: iso(NOW),
    });
  });

  it("una lista vacía es un vacío válido, no 'sin snapshot'", async () => {
    await writeSnapshot("tiktok-videos", TT, [], NOW);
    expect(await readSnapshot("tiktok-videos", TT, NOW)).toEqual({
      value: [],
      capturedAt: iso(NOW),
    });
  });

  it("no hay fila → undefined", async () => {
    expect(await readSnapshot("twitch-clips", TWITCH, NOW)).toBeUndefined();
  });

  it("caducado (24 h social / 48 h duradero) → se ignora; en el límite exacto todavía sirve", async () => {
    await writeSnapshot("tiktok-videos", TT, validPayload("tiktok-videos"), NOW);
    await writeSnapshot("twitch-clips", TWITCH, validPayload("twitch-clips"), NOW);

    expect(
      await readSnapshot("tiktok-videos", TT, NOW + SNAPSHOT_MAX_AGE_MS.social),
    ).toBeDefined();
    expect(
      await readSnapshot("tiktok-videos", TT, NOW + SNAPSHOT_MAX_AGE_MS.social + 1),
    ).toBeUndefined();
    expect(
      await readSnapshot("twitch-clips", TWITCH, NOW + SNAPSHOT_MAX_AGE_MS.durable),
    ).toBeDefined();
    expect(
      await readSnapshot("twitch-clips", TWITCH, NOW + SNAPSHOT_MAX_AGE_MS.durable + 1),
    ).toBeUndefined();
  });

  it("un recurso social NO hereda las 48 h: a las 30 h ya no sirve, uno duradero sí", async () => {
    await writeSnapshot("instagram-profile", IG, validPayload("instagram-profile"), NOW);
    await writeSnapshot("youtube-latest", YOUTUBE, validPayload("youtube-latest"), NOW);
    expect(await readSnapshot("instagram-profile", IG, NOW + 30 * HOUR)).toBeUndefined();
    expect(await readSnapshot("youtube-latest", YOUTUBE, NOW + 30 * HOUR)).toBeDefined();
  });

  it("source_id distinto → se ignora (canal cambiado, reconexión o cuenta distinta)", async () => {
    await writeSnapshot("twitch-clips", TWITCH, validPayload("twitch-clips"), NOW);
    const otherChannel = twitchSourceId("otrocanal")!;
    expect(await readSnapshot("twitch-clips", otherChannel, NOW)).toBeUndefined();

    await writeSnapshot("tiktok-videos", TT, validPayload("tiktok-videos"), NOW);
    const reconnected = socialSourceId(
      "tiktok",
      "1b8e5f5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
      "open-id-01",
    )!;
    const otherAccount = socialSourceId("tiktok", CONNECTION, "open-id-02")!;
    expect(await readSnapshot("tiktok-videos", reconnected, NOW)).toBeUndefined();
    expect(await readSnapshot("tiktok-videos", otherAccount, NOW)).toBeUndefined();
    expect(await readSnapshot("tiktok-videos", TT, NOW)).toBeDefined();
  });

  it("captured_at ilegible, ausente o del futuro → se ignora", async () => {
    const payload = validPayload("twitch-clips");
    for (const captured of [
      "no es una fecha",
      "",
      undefined,
      null,
      12345,
      iso(NOW + 10 * 60_000),
    ]) {
      seed("twitch-clips", { source_id: TWITCH, payload, captured_at: captured });
      expect(await readSnapshot("twitch-clips", TWITCH, NOW)).toBeUndefined();
    }
    // Un pequeño desfase de reloj (≤ 1 min) se tolera.
    seed("twitch-clips", { source_id: TWITCH, payload, captured_at: iso(NOW + 30_000) });
    expect(await readSnapshot("twitch-clips", TWITCH, NOW)).toBeDefined();
  });

  it("un payload guardado mal formado o que no valida → se ignora", async () => {
    for (const payload of [
      "hello",
      null,
      42,
      {},
      { data: [] },
      [{ id: "x" }],
      [
        {
          ...validPayload("twitch-clips")[0],
          thumbnailUrl: "http://static-cdn.jtvnw.net/a.jpg",
        },
      ],
      [{ ...validPayload("twitch-clips")[0], access_token: "tok" }],
    ]) {
      seed("twitch-clips", { source_id: TWITCH, payload, captured_at: iso(NOW) });
      expect(await readSnapshot("twitch-clips", TWITCH, NOW)).toBeUndefined();
    }
  });

  it("la lectura REVALIDA: una fila con contenido inseguro escrita por otra vía no se sirve", async () => {
    await writeSnapshot("tiktok-videos", TT, validPayload("tiktok-videos"), NOW);
    const row = snapshotDb.rows.get("tiktok-videos")!;
    (row.payload as { coverImageUrl: string }[])[0].coverImageUrl = "javascript:alert(1)";
    expect(await readSnapshot("tiktok-videos", TT, NOW)).toBeUndefined();
  });

  it("una fila de otro recurso o de otro tipo de contenedor no se confunde con vacío", async () => {
    seed("youtube-videos", {
      source_id: YOUTUBE,
      payload: { data: [] },
      captured_at: iso(NOW),
    });
    expect(await readSnapshot("youtube-videos", YOUTUBE, NOW)).toBeUndefined();
    seed("youtube-videos", {
      source_id: YOUTUBE,
      payload: "hello",
      captured_at: iso(NOW),
    });
    expect(await readSnapshot("youtube-videos", YOUTUBE, NOW)).toBeUndefined();
  });

  it("un recurso arbitrario no se lee ni abre una conexión", async () => {
    // @ts-expect-error solo los recursos canónicos son válidos.
    expect(await readSnapshot("twitch-status", TWITCH, NOW)).toBeUndefined();
    // @ts-expect-error solo los recursos canónicos son válidos.
    expect(await readSnapshot("no-existe", TWITCH, NOW)).toBeUndefined();
    expect(snapshotDb.ops).toHaveLength(0);
    expect(snapshotDb.clientsCreated).toBe(0);
  });

  it("source_id de otro proveedor (cast) → undefined sin consultar", async () => {
    // @ts-expect-error un source_id de YouTube no es de Twitch.
    expect(await readSnapshot("twitch-clips", YOUTUBE, NOW)).toBeUndefined();
    expect(snapshotDb.ops).toHaveLength(0);
  });
});

describe("aislamiento", () => {
  it("cada recurso es independiente: escribir uno no afecta a los demás", async () => {
    await writeSnapshot("twitch-clips", TWITCH, validPayload("twitch-clips"), NOW);
    await writeSnapshot(
      "twitch-latest-video",
      TWITCH,
      validPayload("twitch-latest-video"),
      NOW,
    );
    await writeSnapshot("youtube-videos", YOUTUBE, validPayload("youtube-videos"), NOW);
    await writeSnapshot("youtube-shorts", YOUTUBE, validPayload("youtube-shorts"), NOW);

    expect((await readSnapshot("twitch-clips", TWITCH, NOW))?.value).toEqual(
      validPayload("twitch-clips"),
    );
    expect((await readSnapshot("twitch-latest-video", TWITCH, NOW))?.value).toEqual(
      validPayload("twitch-latest-video"),
    );
    expect((await readSnapshot("youtube-videos", YOUTUBE, NOW))?.value).toEqual(
      validPayload("youtube-videos"),
    );
    expect((await readSnapshot("youtube-shorts", YOUTUBE, NOW))?.value).toEqual(
      validPayload("youtube-shorts"),
    );
    expect(await readSnapshot("youtube-latest", YOUTUBE, NOW)).toBeUndefined();
    expect(snapshotDb.rows.size).toBe(4);
  });

  it("un proveedor no puede leer ni sobrescribir el snapshot de otro", async () => {
    await writeSnapshot("tiktok-videos", TT, validPayload("tiktok-videos"), NOW);
    // Misma clave de fila, otro source_id: se ignora al leer.
    const other = socialSourceId("tiktok", CONNECTION, "otro-usuario")!;
    expect(await readSnapshot("tiktok-videos", other, NOW)).toBeUndefined();
  });

  it("la última escritura válida gana (last-write-wins) y conserva el source_id nuevo", async () => {
    const first = validPayload("twitch-clips");
    const second = validPayload("twitch-clips");
    second[0].title = "Título más reciente";
    const otherChannel = twitchSourceId("otrocanal")!;

    await writeSnapshot("twitch-clips", TWITCH, first, NOW);
    await writeSnapshot("twitch-clips", otherChannel, second, NOW + 1000);

    expect(snapshotDb.rows.size).toBe(1);
    expect(snapshotDb.rows.get("twitch-clips")?.source_id).toBe(otherChannel);
    expect(
      (await readSnapshot("twitch-clips", otherChannel, NOW + 1000))?.value[0].title,
    ).toBe("Título más reciente");
    expect(await readSnapshot("twitch-clips", TWITCH, NOW + 1000)).toBeUndefined();
  });

  it("dos escrituras concurrentes: queda una sola fila, la de la última aplicada, sin errores", async () => {
    const a = validPayload("youtube-videos");
    const b = validPayload("youtube-videos");
    b[0].title = "B";
    const results = await Promise.all([
      writeSnapshot("youtube-videos", YOUTUBE, a, NOW),
      writeSnapshot("youtube-videos", YOUTUBE, b, NOW + 5),
    ]);
    expect(results).toEqual(["written", "written"]);
    expect(snapshotDb.rows.size).toBe(1);
    expect(
      (snapshotDb.rows.get("youtube-videos")?.payload as { title: string }[])[0].title,
    ).toBe("B");
  });

  it("una escritura y una lectura concurrentes nunca ven una fila a medias", async () => {
    await writeSnapshot("twitch-clips", TWITCH, validPayload("twitch-clips"), NOW);
    const next = validPayload("twitch-clips");
    next[0].title = "Nuevo";
    const [, read] = await Promise.all([
      writeSnapshot("twitch-clips", TWITCH, next, NOW + 10),
      readSnapshot("twitch-clips", TWITCH, NOW + 10),
    ]);
    expect(["Un clip de prueba", "Nuevo"]).toContain(read?.value[0].title);
  });

  it("nunca hay más filas que recursos canónicos (cardinalidad ≤ 8)", async () => {
    const writes: [SnapshotResource, unknown, unknown][] = [
      ["twitch-clips", TWITCH, validPayload("twitch-clips")],
      ["twitch-latest-video", TWITCH, validPayload("twitch-latest-video")],
      ["youtube-latest", YOUTUBE, validPayload("youtube-latest")],
      ["youtube-videos", YOUTUBE, validPayload("youtube-videos")],
      ["youtube-shorts", YOUTUBE, validPayload("youtube-shorts")],
      ["instagram-feed", IG, validPayload("instagram-feed")],
      ["instagram-profile", IG, validPayload("instagram-profile")],
      ["tiktok-videos", TT, validPayload("tiktok-videos")],
    ];
    for (let round = 0; round < 3; round++) {
      for (const [resource, source, value] of writes) {
        // @ts-expect-error el bucle usa tipos amplios a propósito.
        await writeSnapshot(resource, source, value, NOW + round);
      }
    }
    expect(snapshotDb.rows.size).toBe(SNAPSHOT_RESOURCES.length);
    expect([...snapshotDb.rows.keys()].sort()).toEqual([...SNAPSHOT_RESOURCES].sort());
  });
});

describe("fallo abierto", () => {
  it("lectura: error de Supabase → undefined, sin lanzar", async () => {
    await writeSnapshot("twitch-clips", TWITCH, validPayload("twitch-clips"), NOW);
    snapshotDb.failOn.select = { code: "42501", message: "permission denied" };
    await expect(readSnapshot("twitch-clips", TWITCH, NOW)).resolves.toBeUndefined();
  });

  it("lectura: excepción del cliente (red) → undefined, sin lanzar", async () => {
    snapshotDb.throwOn.select = new TypeError("fetch failed");
    await expect(readSnapshot("twitch-clips", TWITCH, NOW)).resolves.toBeUndefined();
  });

  it("lectura: Supabase no responde → vence el plazo (2 s) y devuelve undefined", async () => {
    vi.useFakeTimers();
    snapshotDb.hang.select = true;
    const pending = readSnapshot("twitch-clips", TWITCH, NOW);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_OPERATION_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await expect(pending).resolves.toBeUndefined();
    expect(SNAPSHOT_OPERATION_TIMEOUT_MS).toBe(2_000);
    // Sin reintentos: una sola operación.
    expect(countSnapshotOps("select")).toBe(0); // la operación colgada nunca llegó a aplicarse
    expect(snapshotDb.clientsCreated).toBe(1);
  });

  it("escritura: error de Supabase → 'failed' (no lanza) y no queda fila", async () => {
    snapshotDb.failOn.upsert = { code: "57014" };
    await expect(
      writeSnapshot("twitch-clips", TWITCH, validPayload("twitch-clips"), NOW),
    ).resolves.toBe("failed");
    expect(snapshotDb.rows.size).toBe(0);
  });

  it("escritura: excepción o plazo agotado → 'failed'", async () => {
    snapshotDb.throwOn.upsert = new TypeError("fetch failed");
    await expect(
      writeSnapshot("twitch-clips", TWITCH, validPayload("twitch-clips"), NOW),
    ).resolves.toBe("failed");
    snapshotDb.throwOn.upsert = undefined;

    vi.useFakeTimers();
    snapshotDb.hang.upsert = true;
    const pending = writeSnapshot(
      "twitch-clips",
      TWITCH,
      validPayload("twitch-clips"),
      NOW,
    );
    await vi.advanceTimersByTimeAsync(SNAPSHOT_OPERATION_TIMEOUT_MS + 1);
    await expect(pending).resolves.toBe("failed");
  });

  it("una escritura fallida NO destruye el snapshot bueno anterior", async () => {
    const good = validPayload("twitch-clips");
    await writeSnapshot("twitch-clips", TWITCH, good, NOW);
    snapshotDb.failOn.upsert = { code: "57014" };
    await writeSnapshot("twitch-clips", TWITCH, validPayload("twitch-clips"), NOW + 1);
    snapshotDb.failOn.upsert = undefined;
    expect((await readSnapshot("twitch-clips", TWITCH, NOW + 2))?.value).toEqual(good);
  });

  it("borrado: error, excepción o plazo → false, sin lanzar", async () => {
    snapshotDb.failOn.delete = { code: "42501" };
    await expect(deleteSocialSnapshots("tiktok")).resolves.toBe(false);
    snapshotDb.failOn.delete = undefined;
    snapshotDb.throwOn.delete = new TypeError("fetch failed");
    await expect(deleteSocialSnapshots("tiktok")).resolves.toBe(false);
    snapshotDb.throwOn.delete = undefined;

    vi.useFakeTimers();
    snapshotDb.hang.delete = true;
    const pending = deleteSocialSnapshots("instagram");
    await vi.advanceTimersByTimeAsync(SNAPSHOT_OPERATION_TIMEOUT_MS + 1);
    await expect(pending).resolves.toBe(false);
  });

  it("sin configuración de Supabase todo falla abierto y no se abre ningún cliente", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(await readSnapshot("twitch-clips", TWITCH, NOW)).toBeUndefined();
    expect(
      await writeSnapshot("twitch-clips", TWITCH, validPayload("twitch-clips"), NOW),
    ).toBe("failed");
    expect(await deleteSocialSnapshots("tiktok")).toBe(false);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
    vi.stubEnv("VITE_SUPABASE_URL", "");
    expect(await readSnapshot("twitch-clips", TWITCH, NOW)).toBeUndefined();
    expect(snapshotDb.clientsCreated).toBe(0);
  });

  it("un fallo nunca filtra payloads, source_id ni claves al registro", async () => {
    snapshotDb.failOn.select = { code: "42501", message: `secreto ${SERVICE_ROLE_KEY}` };
    snapshotDb.failOn.upsert = { code: "57014", message: `secreto ${SERVICE_ROLE_KEY}` };
    snapshotDb.failOn.delete = { code: "42501", message: `secreto ${SERVICE_ROLE_KEY}` };
    await readSnapshot("twitch-clips", TWITCH, NOW);
    await writeSnapshot("twitch-clips", TWITCH, validPayload("twitch-clips"), NOW);
    await deleteSocialSnapshots("tiktok");

    const logged = errorLog.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(logged).toContain("[public-snapshots]");
    for (const secret of [
      SERVICE_ROLE_KEY,
      "canalficticio",
      "Un clip de prueba",
      "twitch:",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("el cliente se crea con la URL y la service_role del entorno, sin sesión persistente", async () => {
    await readSnapshot("twitch-clips", TWITCH, NOW);
    expect(snapshotDb.lastClientArgs?.[0]).toBe("https://proyecto-ficticio.supabase.co");
    expect(snapshotDb.lastClientArgs?.[1]).toBe(SERVICE_ROLE_KEY);
    expect(snapshotDb.lastClientArgs?.[2]).toEqual({
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });
});

describe("borrado por desconexión (solo redes sociales)", () => {
  async function seedAll() {
    await writeSnapshot("twitch-clips", TWITCH, validPayload("twitch-clips"), NOW);
    await writeSnapshot(
      "twitch-latest-video",
      TWITCH,
      validPayload("twitch-latest-video"),
      NOW,
    );
    await writeSnapshot("youtube-latest", YOUTUBE, validPayload("youtube-latest"), NOW);
    await writeSnapshot("youtube-videos", YOUTUBE, validPayload("youtube-videos"), NOW);
    await writeSnapshot("youtube-shorts", YOUTUBE, validPayload("youtube-shorts"), NOW);
    await writeSnapshot("instagram-feed", IG, validPayload("instagram-feed"), NOW);
    await writeSnapshot("instagram-profile", IG, validPayload("instagram-profile"), NOW);
    await writeSnapshot("tiktok-videos", TT, validPayload("tiktok-videos"), NOW);
  }

  it("TikTok borra solo tiktok-videos", async () => {
    await seedAll();
    expect(await deleteSocialSnapshots("tiktok")).toBe(true);
    expect([...snapshotDb.rows.keys()].sort()).toEqual(
      SNAPSHOT_RESOURCES.filter((r) => r !== "tiktok-videos").sort(),
    );
    expect(snapshotDb.ops.at(-1)).toEqual({ op: "delete", resources: ["tiktok-videos"] });
  });

  it("Instagram borra feed y perfil, y nada más", async () => {
    await seedAll();
    expect(await deleteSocialSnapshots("instagram")).toBe(true);
    expect([...snapshotDb.rows.keys()].sort()).toEqual(
      SNAPSHOT_RESOURCES.filter(
        (r) => r !== "instagram-feed" && r !== "instagram-profile",
      ).sort(),
    );
    expect(snapshotDb.ops.at(-1)).toEqual({
      op: "delete",
      resources: ["instagram-feed", "instagram-profile"],
    });
  });

  it("no acepta un proveedor arbitrario (Twitch, YouTube, texto libre): no borra nada", async () => {
    await seedAll();
    const before = snapshotDb.rows.size;
    for (const provider of [
      "twitch",
      "youtube",
      "*",
      "",
      "instagram-feed",
      "tiktok-videos",
    ]) {
      // @ts-expect-error solo instagram y tiktok.
      expect(await deleteSocialSnapshots(provider)).toBe(false);
    }
    expect(snapshotDb.rows.size).toBe(before);
    expect(countSnapshotOps("delete")).toBe(0);
  });

  it("borrar sin filas es un éxito (idempotente)", async () => {
    expect(await deleteSocialSnapshots("tiktok")).toBe(true);
    expect(await deleteSocialSnapshots("tiktok")).toBe(true);
  });

  it("tras borrar, ya no hay snapshot que servir de esa red", async () => {
    await seedAll();
    await deleteSocialSnapshots("tiktok");
    expect(await readSnapshot("tiktok-videos", TT, NOW)).toBeUndefined();
    expect(await readSnapshot("instagram-feed", IG, NOW)).toBeDefined();
  });
});
