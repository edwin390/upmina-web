// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  POST,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";
import { runMediaGcBatch, type GcDb, type PhysicalDeleteIo } from "./media-gc";
import {
  PRESIGN_TTL_MULTIPART_PART_SECONDS,
  PRESIGN_TTL_SINGLE_PUT_SECONDS,
} from "./r2-client";

// R7: SQL REAL (PGlite en memoria) de la migración PROPUESTA 20261028120000: detección automática de
// reservas abandonadas. Los tiempos son DETERMINISTAS: el marcador acepta un «ahora» explícito
// (solo postgres puede llamarlo), así que nada depende del reloj de la máquina de pruebas. R2 es falso.

const migration = (n: string) => readFileSync(`supabase/migrations/${n}`, "utf8");
const R7 = migration("20261028120000_media_abandoned_reservations_auto.sql");
const A = (n: number) => `0a000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CUTOFF = "2026-10-09T23:00:00Z";
const NOW = "2027-03-01T12:00:00Z";
const ago = (hours: number) => new Date(Date.parse(NOW) - hours * 3600_000).toISOString();
const UP = "synthetic-upload-id-0001";
const SECRET = "synthetic-scheduler-secret-for-tests-0123456789";
const URL = "https://backend.synthetic.example/api/media/gc";
let db: TestDatabase;

beforeAll(async () => {
  db = await createAtomicTestDatabase();
  await db.exec(`create table admin_roles(user_id uuid primary key,role text);
 alter table profiles add column username text,add column display_name text;
 alter table media_assets add column storage_key text,add column width int,add column height int,
   add column duration_seconds numeric,add column private_original_key text,
   add column created_at timestamptz not null default now(),add column failure_code text,
   add column multipart_upload_id text;
 create table media_asset_variants(id uuid primary key default gen_random_uuid(),
   asset_id uuid not null references media_assets(id) on delete cascade,
   variant int, storage_key text not null);`);
  for (const n of [
    "20261007120000_moderation_foundation.sql",
    "20261009120000_moderation_workflow_core.sql",
    "20261010120000_moderation_case_foundation.sql",
    "20261011120000_community_report_submission.sql",
    "20261012120000_community_report_submission_account_race_fix.sql",
    "20261013120000_moderation_case_read_model.sql",
    "20261014120000_moderation_case_media_references.sql",
    "20261015120000_moderation_grouped_decision_core.sql",
    "20261016120000_community_controlled_write_boundary.sql",
    "20261017120000_community_author_moderation_access.sql",
    "20261018120000_community_author_resolved_notice_flag.sql",
    "20261019120000_community_media_delivery_state.sql",
    "20261020120000_community_media_purge_lifecycle.sql",
    "20261026120000_media_abandoned_cleanup.sql",
    "20261027120000_media_multipart_abort_guard.sql",
  ])
    await db.exec(migration(n));
  // Stubs mínimos de pg_net / Vault / pgcrypto (PGlite no los trae), como en el contrato del tick.
  await db.exec(`
    create schema vault;
    create table vault.decrypted_secrets(name text primary key, decrypted_secret text);
    create schema net;
    create table net.calls(id bigserial primary key, url text, headers jsonb);
    create function net.http_post(url text, body jsonb default '{}'::jsonb,
      params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb,
      timeout_milliseconds int default 5000) returns bigint language plpgsql as $f$
    declare v_id bigint;
    begin
      insert into net.calls(url, headers) values (url, headers) returning id into v_id;
      return v_id;
    end $f$;
    create schema extensions;
    create function extensions.hmac(data bytea, key bytea, algo text) returns bytea
      language sql immutable as $f$ select sha256(key || data) $f$;
  `);
  await db.exec(R7);
}, 90000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("begin");
});
afterEach(async () => {
  try {
    await db.exec("reset role");
  } catch {
    /* transacción abortada: el rollback de abajo la limpia */
  }
  await db.exec("rollback");
});

async function rejects(run: () => Promise<unknown>, pattern?: RegExp) {
  await db.exec("savepoint expected_failure");
  let error: unknown = null;
  try {
    await run();
  } catch (e) {
    error = e;
  }
  await db.exec("rollback to savepoint expected_failure");
  expect(error).not.toBeNull();
  if (pattern) expect(String((error as Error).message)).toMatch(pattern);
}

async function asset(
  n: number,
  status: string,
  opts: {
    created?: string;
    updated?: string;
    domain?: string;
    multipart?: boolean;
  } = {},
) {
  const created = opts.created ?? ago(30);
  await db.query(
    `insert into media_assets(id,domain,kind,status,created_by,private_original_key,
       multipart_upload_id,failure_code,created_at,updated_at)
     values($1,$2,'video',$3,$4,$5,$6,$7,$8,$9)`,
    [
      A(n),
      opts.domain ?? "community",
      status,
      ACTOR,
      status === "ready"
        ? null
        : `staging/${opts.domain ?? "community"}/${A(n)}/original.mp4`,
      opts.multipart ? UP : null,
      status === "failed" ? "processing_failed" : null,
      created,
      opts.updated ?? created,
    ],
  );
}
const enable = (set = "") =>
  db.query(`update media_abandon_policy set enabled = true ${set ? `, ${set}` : ""}`);
const mark = async (now: string | null = NOW) =>
  (
    await db.query<{ r: Record<string, unknown> }>(
      "select media_abandoned_reservations_mark($1) r",
      [now],
    )
  ).rows[0].r;
const statusOf = async (n: number) =>
  (
    await db.query<{ status: string }>("select status from media_assets where id=$1", [
      A(n),
    ])
  ).rows[0]?.status;
const policy = async () =>
  (await db.query<Record<string, unknown>>("select * from media_abandon_policy")).rows[0];

describe("media_abandon_policy", () => {
  it("se crea DESACTIVADA, con 24 h, lote de 20 y el corte histórico documentado", async () => {
    const p = await policy();
    expect(p).toMatchObject({ singleton: true, enabled: false, batch_limit: 20 });
    expect(JSON.stringify(p.min_age)).toMatch(/24/);
    expect(new Date(p.protected_before as string).toISOString()).toBe(
      "2026-10-09T23:00:00.000Z",
    );
  });

  it("el CHECK impide bajar la antigüedad de 2 h, un lote fuera de rango, una 2ª fila y bajar el corte", async () => {
    await rejects(() =>
      db.query("update media_abandon_policy set min_age = interval '119 minutes'"),
    );
    await rejects(() =>
      db.query("update media_abandon_policy set min_age = interval '31 days'"),
    );
    await rejects(() => db.query("update media_abandon_policy set batch_limit = 0"));
    await rejects(() => db.query("update media_abandon_policy set batch_limit = 101"));
    await rejects(() =>
      db.query("insert into media_abandon_policy(singleton) values (false)"),
    );
    await rejects(() =>
      db.query("insert into media_abandon_policy(singleton) values (true)"),
    );
    await rejects(
      () =>
        db.query(
          "update media_abandon_policy set protected_before = '2026-10-09T22:59:59Z'",
        ),
      /media_abandon_policy_cutoff_floor/,
    );
    await db.query("update media_abandon_policy set min_age = interval '2 hours'");
    await db.query("update media_abandon_policy set protected_before = '2026-12-01Z'");
  });

  it("anon, authenticated y service_role no leen ni escriben la tabla ni ejecutan el marcador", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      await rejects(() =>
        db.exec(`set role ${role}; select * from media_abandon_policy`),
      );
      await db.exec("reset role");
      await rejects(() =>
        db.exec(`set role ${role}; update media_abandon_policy set enabled = true`),
      );
      await db.exec("reset role");
      await rejects(() =>
        db.exec(`set role ${role}; select media_abandoned_reservations_mark()`),
      );
      await db.exec("reset role");
    }
    expect((await policy()).enabled).toBe(false);
  });
});

describe("media_abandoned_reservations_mark", () => {
  it("desactivado: no marca nada aunque haya candidatos evidentes", async () => {
    await asset(1, "reserved", { created: ago(500) });
    expect(await mark()).toEqual({ status: "disabled" });
    expect(await statusOf(1)).toBe("reserved");
    expect((await policy()).last_run_at).toBeNull();
  });

  it("marca los estados pendientes con ≥ 24 h de inactividad y respeta el límite exacto", async () => {
    await enable();
    await asset(1, "reserved", { created: ago(24) }); // justo en el umbral: se marca
    await asset(2, "reserved", { created: ago(23.99) }); // 14 s por debajo: NO
    await asset(3, "uploaded", { created: ago(40) });
    await asset(4, "verifying", { created: ago(40) });
    await asset(5, "processing", { created: ago(40) });
    await asset(6, "reserved", { created: ago(40), domain: "cosplay" });
    const r = await mark();
    expect(r).toMatchObject({ status: "ran", candidates: 5, marked: 5, skipped: 0 });
    expect(await statusOf(1)).toBe("deleting");
    expect(await statusOf(2)).toBe("reserved");
    for (const n of [3, 4, 5, 6]) expect(await statusOf(n)).toBe("deleting");
  });

  it("nunca toca ready, failed ni deleting, por antiguos que sean", async () => {
    await enable();
    await asset(1, "ready", { created: ago(5000) });
    await asset(2, "failed", { created: ago(5000) });
    await db.query(
      `insert into media_assets(id,domain,kind,status,created_by,created_at,updated_at)
       values($1,'community','video','deleting',$2,$3,$3)`,
      [A(3), ACTOR, ago(5000)],
    );
    expect(await mark()).toMatchObject({ candidates: 0, marked: 0 });
    expect(await statusOf(1)).toBe("ready");
    expect(await statusOf(2)).toBe("failed");
    expect(await statusOf(3)).toBe("deleting");
  });

  it("EXCLUSIÓN HISTÓRICA en la propia consulta: nada anterior al corte, ni con 2 h de umbral", async () => {
    await enable("min_age = interval '2 hours'");
    // Los tres huérfanos de DEV (18:51–18:53Z del 9-oct), un reservado antiguo y uno justo en el corte.
    await asset(1, "reserved", { created: "2026-10-09T18:51:35Z" });
    await asset(2, "reserved", { created: "2026-10-09T18:52:33Z" });
    await asset(3, "reserved", { created: "2026-10-09T18:53:01Z" });
    await asset(4, "reserved", { created: "2026-09-27T23:26:46Z", domain: "cosplay" });
    await asset(5, "reserved", { created: "2026-10-09T22:59:59Z" });
    await asset(6, "reserved", { created: CUTOFF }); // en el corte: elegible (>=)
    const r = await mark();
    expect(r).toMatchObject({ candidates: 1, marked: 1 });
    for (const n of [1, 2, 3, 4, 5]) expect(await statusOf(n)).toBe("reserved");
    expect(await statusOf(6)).toBe("deleting");
  });

  it("actividad reciente protege: un pendiente con created_at antiguo pero updated_at reciente no se marca", async () => {
    await enable();
    await asset(1, "processing", { created: ago(100), updated: ago(1) });
    await asset(2, "uploaded", { created: ago(100), updated: ago(23) });
    expect(await mark()).toMatchObject({ candidates: 0, marked: 0 });
    expect(await statusOf(1)).toBe("processing");
    expect(await statusOf(2)).toBe("uploaded");
  });

  it("el trigger de actividad renueva updated_at al cambiar de estado, así que una subida que progresa deja de ser candidata", async () => {
    await enable();
    await asset(1, "reserved", { created: ago(30) });
    await db.query("update media_assets set status = 'uploaded' where id = $1", [A(1)]);
    // updated_at pasó a clock_timestamp() (hoy), muy posterior al «ahora» de la prueba (marzo 2027)
    // solo si NOW fuese anterior; usamos un ahora real para comprobar la renovación.
    const r = await mark(new Date(Date.now() + 3600_000).toISOString());
    expect(r).toMatchObject({ candidates: 0, marked: 0 });
    expect(await statusOf(1)).toBe("uploaded");
  });

  it("límite por lote, el más antiguo primero, y reanudación en ejecuciones siguientes", async () => {
    await enable("batch_limit = 2");
    for (let n = 1; n <= 5; n++) await asset(n, "reserved", { created: ago(100 - n) });
    expect(await mark()).toMatchObject({ candidates: 2, marked: 2 });
    expect([await statusOf(1), await statusOf(2), await statusOf(3)]).toEqual([
      "deleting",
      "deleting",
      "reserved",
    ]);
    expect(await mark()).toMatchObject({ marked: 2 });
    expect(await mark()).toMatchObject({ marked: 1 });
    expect(await mark()).toMatchObject({ candidates: 0, marked: 0 });
  });

  it("es idempotente: repetir no re-marca ni cambia nada", async () => {
    await enable();
    await asset(1, "reserved", { created: ago(30) });
    await mark();
    const before = (
      await db.query<{ u: string }>(
        "select updated_at::text u from media_assets where id=$1",
        [A(1)],
      )
    ).rows[0].u;
    expect(await mark()).toMatchObject({ candidates: 0, marked: 0 });
    const after = (
      await db.query<{ u: string }>(
        "select updated_at::text u from media_assets where id=$1",
        [A(1)],
      )
    ).rows[0].u;
    expect(after).toBe(before);
  });

  it("registra métricas de la última ejecución (candidatos, marcados, omitidos, duración, sin error)", async () => {
    await enable();
    await asset(1, "reserved", { created: ago(30) });
    await mark();
    const p = await policy();
    expect(p).toMatchObject({
      last_candidates: 1,
      last_marked: 1,
      last_skipped: 0,
      last_error_class: null,
    });
    expect(p.last_run_at).not.toBeNull();
    expect(Number(p.last_duration_ms)).toBeGreaterThanOrEqual(0);
  });

  it("un fallo al marcar se contiene: devuelve error acotado, deshace el lote y lo registra", async () => {
    await enable();
    await asset(1, "reserved", { created: ago(30) });
    await asset(2, "reserved", { created: ago(31) });
    await db.exec(`create function tmp_fail() returns trigger language plpgsql as
      $f$ begin raise exception 'boom'; end $f$;
      create trigger tmp_fail before update on media_assets for each row
      execute function tmp_fail();`);
    const r = await mark();
    expect(r).toMatchObject({ status: "error" });
    expect(JSON.stringify(r)).not.toMatch(/boom/);
    expect(await statusOf(1)).toBe("reserved");
    expect(await statusOf(2)).toBe("reserved");
    expect((await policy()).last_error_class).toBe("mark_failed");
  });

  it("los argumentos de «ahora» nulos usan el reloj real: con un reservado reciente no marca nada", async () => {
    await enable();
    await db.query(
      `insert into media_assets(id,domain,kind,status,created_by,private_original_key)
       values($1,'community','video','reserved',$2,$3)`,
      [A(1), ACTOR, `staging/community/${A(1)}/original.mp4`],
    );
    expect(await mark(null)).toMatchObject({ status: "ran", candidates: 0, marked: 0 });
    expect(await statusOf(1)).toBe("reserved");
  });
});

describe("integración con el GC y la protección multipart", () => {
  const adapter: GcDb = {
    async rpc(name, args) {
      const params = Object.values(args);
      const sql = `select ${name}(${params.map((_, i) => `$${i + 1}`).join(",")}) r`;
      try {
        return {
          data: (await db.query<{ r: unknown }>(sql, params)).rows[0].r,
          error: null,
        };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
  function r2(abortFails = false) {
    const calls: string[] = [];
    const io: PhysicalDeleteIo = {
      async deletePublic(keys) {
        calls.push(`delete-public:${keys.length}`);
      },
      async deletePrivate(key) {
        calls.push(`delete-private:${key}`);
      },
      async abortMultipart(key, uploadId) {
        calls.push(`abort:${key}:${uploadId}`);
        if (abortFails) throw new Error("R2 503");
      },
    };
    return { io, calls };
  }
  const mp = async (n: number) =>
    (
      await db.query<{ m: string | null }>(
        "select multipart_upload_id m from media_assets where id=$1",
        [n === 0 ? A(1) : A(n)],
      )
    ).rows[0]?.m;

  it("marcar conserva multipart_upload_id y la clave; el GC aborta con ese id y solo entonces borra la fila", async () => {
    await enable();
    await asset(1, "reserved", { created: ago(30), multipart: true });
    await mark();
    expect(await statusOf(1)).toBe("deleting");
    expect(await mp(1)).toBe(UP);
    const { io, calls } = r2();
    const s = await runMediaGcBatch({ db: adapter, io, log: () => undefined });
    expect(s).toMatchObject({ claimed: 1, finalized: 1, failed: 0 });
    expect(calls[0]).toBe(`abort:staging/community/${A(1)}/original.mp4:${UP}`);
    expect(await statusOf(1)).toBeUndefined();
  });

  it("si el aborto falla, la fila y el identificador sobreviven y se reintenta", async () => {
    await enable();
    await asset(1, "reserved", { created: ago(30), multipart: true });
    await mark();
    const s = await runMediaGcBatch({
      db: adapter,
      io: r2(true).io,
      log: () => undefined,
    });
    expect(s).toMatchObject({ finalized: 0, failed: 1 });
    expect(await statusOf(1)).toBe("deleting");
    expect(await mp(1)).toBe(UP);
  });

  it("solo se procesan los marcados: un activo reciente y un histórico siguen intactos tras el GC", async () => {
    await enable();
    await asset(1, "reserved", { created: ago(30), multipart: true }); // abandonado
    await asset(2, "reserved", { created: ago(1), multipart: true }); // subida activa
    await asset(3, "reserved", { created: "2026-10-09T18:52:33Z", multipart: true }); // histórico
    await mark();
    const { io, calls } = r2();
    await runMediaGcBatch({ db: adapter, io, log: () => undefined });
    expect(calls.some((c) => c.includes(A(2)) || c.includes(A(3)))).toBe(false);
    expect(await statusOf(2)).toBe("reserved");
    expect(await statusOf(3)).toBe("reserved");
    expect(await mp(2)).toBe(UP);
    expect(await mp(3)).toBe(UP);
  });
});

describe("community_media_purge_tick con el paso de abandonadas", () => {
  const tick = async () =>
    (
      await db.query<{ r: Record<string, unknown> }>(
        "select public.community_media_purge_tick() r",
      )
    ).rows[0].r;
  const configure = () =>
    db.query(
      "insert into vault.decrypted_secrets values ('media_gc_shared_secret',$1),('media_gc_endpoint_url',$2)",
      [SECRET, URL],
    );
  const calls = async () =>
    (await db.query("select url from net.calls order by id")).rows as { url: string }[];
  /** Quita el suelo del corte SOLO en esta transacción para poder usar el reloj real. */
  const relaxFloor = () =>
    db.exec(`alter table media_abandon_policy drop constraint media_abandon_policy_cutoff_floor;
      update media_abandon_policy set protected_before = '2000-01-01Z',
        min_age = interval '2 hours', enabled = true`);

  it("desactivada: el tick se comporta como antes (idle) y reporta abandoned.status=disabled", async () => {
    await configure();
    const r = await tick();
    expect(r).toMatchObject({
      status: "idle",
      eligible: 0,
      abandonedFailed: false,
      abandoned: { status: "disabled" },
    });
    expect(await calls()).toHaveLength(0);
  });

  it("activada: marca la abandonada y despierta al GC en el MISMO tick con una sola petición firmada", async () => {
    await configure();
    await relaxFloor();
    await db.query(
      `insert into media_assets(id,domain,kind,status,created_by,private_original_key,created_at,updated_at)
       values($1,'community','video','reserved',$2,$3, now() - interval '5 hours', now() - interval '5 hours')`,
      [A(1), ACTOR, `staging/community/${A(1)}/original.mp4`],
    );
    await db.query(
      `insert into media_assets(id,domain,kind,status,created_by,private_original_key)
       values($1,'community','video','reserved',$2,$3)`,
      [A(2), ACTOR, `staging/community/${A(2)}/original.mp4`],
    ); // reciente: no se marca
    const r = await tick();
    expect(r).toMatchObject({
      status: "gc_enqueued",
      eligible: 1,
      abandoned: { status: "ran", candidates: 1, marked: 1 },
    });
    expect(await statusOf(1)).toBe("deleting");
    expect(await statusOf(2)).toBe("reserved");
    expect(await calls()).toHaveLength(1);
  });

  it("aislamiento: si el paso de abandonadas revienta, el tick sigue y despierta al GC", async () => {
    await configure();
    await db.query(
      `insert into media_assets(id,domain,kind,status,created_by,storage_key)
       values($1,'community','image','deleting',$2,$3)`,
      [A(9), ACTOR, `community/${A(9)}/w960.webp`],
    );
    await db.exec("alter table media_abandon_policy rename to media_abandon_policy_x");
    const r = await tick();
    expect(r).toMatchObject({
      status: "gc_enqueued",
      abandonedFailed: true,
      abandoned: null,
      eligible: 1,
    });
    expect(await calls()).toHaveLength(1);
  });
});

describe("estructura de la migración", () => {
  it("no crea, cambia ni borra jobs de cron y no invoca el barrido general", () => {
    expect(R7).not.toMatch(/cron\.(schedule|unschedule|alter_job)/);
    expect(R7).not.toMatch(/media_abandoned_sweep\s*\(/);
  });

  it("el corte histórico se aplica en la consulta SQL y solo postgres ejecuta el marcador", () => {
    const body = R7.slice(
      R7.indexOf("create function public.media_abandoned_reservations_mark"),
    );
    expect(body).toMatch(/a\.created_at >= v_pol\.protected_before/);
    expect(body).toMatch(/v_a\.created_at < v_pol\.protected_before/);
    expect(R7).toMatch(
      /revoke all on function public\.media_abandoned_reservations_mark\(timestamptz\)\s+from public, anon, authenticated, service_role/,
    );
    expect(R7).toMatch(
      /grant execute on function public\.media_abandoned_reservations_mark\(timestamptz\) to postgres/,
    );
    expect(R7).toMatch(
      /revoke all on public\.media_abandon_policy from public, anon, authenticated, service_role/,
    );
  });

  it("el tick conserva las garantías de 20261021 (lock, petición sin parámetros, firma HMAC)", () => {
    const tickSql = R7.slice(
      R7.indexOf("create or replace function public.community_media_purge_tick()"),
    );
    expect(tickSql).toMatch(/pg_try_advisory_xact_lock/);
    expect(tickSql).toMatch(/UPMINA-MEDIA-GC-V1/);
    expect(tickSql).toMatch(
      /net\.http_post\(\s*url := v_url,\s*headers :=[^;]*timeout_milliseconds := 30000\)/,
    );
    expect(tickSql).not.toMatch(/body\s*:=/);
  });
});

describe("supuesto de seguridad: las URLs de subida caducan mucho antes del mínimo duro de 2 h", () => {
  it("sin heartbeat, esto es lo que garantiza que una reserva con ≥ 2 h de inactividad ya no puede estar subiendo", () => {
    // Si alguien alarga estos TTL por encima de la mitad del mínimo duro, hay que revisar R7 antes.
    expect(PRESIGN_TTL_SINGLE_PUT_SECONDS).toBeLessThanOrEqual(3600);
    expect(PRESIGN_TTL_MULTIPART_PART_SECONDS).toBeLessThanOrEqual(3600);
    expect(R7).toMatch(/min_age >= interval '2 hours'/);
  });
});

// R7 FINAL: el marcador NO admite selección por asset; el aislamiento de una prueba remota depende solo de
// las columnas de la política (protected_before sube, min_age, batch_limit). Estas pruebas fijan ese diseño.
describe("aislamiento de la prueba B/C mediante protected_before (docs/9K-R7-FINAL-VALIDATION.md)", () => {
  const adapter: GcDb = {
    async rpc(name, args) {
      const params = Object.values(args);
      const sql = `select ${name}(${params.map((_, i) => `$${i + 1}`).join(",")}) r`;
      try {
        return {
          data: (await db.query<{ r: unknown }>(sql, params)).rows[0].r,
          error: null,
        };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
  const calls: string[] = [];
  const io: PhysicalDeleteIo = {
    async deletePublic(keys) {
      calls.push(`delete-public:${keys.length}`);
    },
    async deletePrivate(key) {
      calls.push(`delete-private:${key}`);
    },
    async abortMultipart(key, uploadId) {
      calls.push(`abort:${key}:${uploadId}`);
    },
  };
  // 1 = «Asset A» (posterior al corte original, antigua), 2 = B (abandonada), 3 = C (reciente),
  // 4-5 históricos, 6-8 ready/failed/deleting antiguos posteriores al corte.
  async function scenario(withB = true) {
    calls.length = 0;
    await asset(1, "reserved", { created: ago(40), multipart: true });
    if (withB) await asset(2, "reserved", { created: ago(25), multipart: true });
    await asset(3, "reserved", { created: ago(1), multipart: true });
    await asset(4, "reserved", { created: "2026-10-09T18:52:33Z", multipart: true });
    await asset(5, "reserved", { created: "2026-09-27T23:26:46Z", domain: "cosplay" });
    await asset(6, "ready", { created: ago(40) });
    await asset(7, "failed", { created: ago(40) });
    await asset(8, "deleting", { created: ago(40) });
  }

  it("el corte original NO protege a un Asset A posterior y antiguo: sin subir protected_before, el barrido global lo marcaría", async () => {
    await scenario();
    await enable(); // min_age 24 h
    await mark();
    expect(await statusOf(1)).toBe("deleting"); // A sería víctima
  });

  it("con protected_before entre A y B, solo B se marca; A, C, históricos y ready/failed/deleting intactos", async () => {
    await scenario();
    await enable(`protected_before = '${ago(30)}'::timestamptz`);
    const r = await mark();
    expect(r).toMatchObject({ status: "ran", candidates: 1, marked: 1, skipped: 0 });
    expect(await statusOf(2)).toBe("deleting");
    for (const n of [1, 3, 4, 5]) expect(await statusOf(n)).toBe("reserved");
    expect(await statusOf(6)).toBe("ready");
    expect(await statusOf(7)).toBe("failed");
    expect(await statusOf(8)).toBe("deleting"); // ya lo estaba; no se re-marca ni cambia
    // Idempotente.
    expect(await mark()).toMatchObject({ candidates: 0, marked: 0 });
  });

  it("el GC posterior solo toca los `deleting`: aborta la sesión de B y nunca A, C ni históricos", async () => {
    await scenario();
    await db.query("delete from media_assets where id = $1", [A(8)]); // sin `deleting` ajeno
    await enable(`protected_before = '${ago(30)}'::timestamptz`);
    await mark();
    const s = await runMediaGcBatch({ db: adapter, io, log: () => undefined });
    expect(s).toMatchObject({ claimed: 1, finalized: 1, failed: 0 });
    expect(calls[0]).toBe(`abort:staging/community/${A(2)}/original.mp4:${UP}`);
    expect(calls.some((c) => [1, 3, 4, 5].some((n) => c.includes(A(n))))).toBe(false);
    expect(await statusOf(2)).toBeUndefined();
    for (const n of [1, 3, 4, 5]) expect(await statusOf(n)).toBe("reserved");
  });

  it("antes de que B cumpla min_age (24 h) y con C reciente, no se marca nada", async () => {
    await scenario(false);
    await enable(`protected_before = '${ago(30)}'::timestamptz`);
    expect(await mark()).toMatchObject({ candidates: 0, marked: 0 });
  });

  it("el corte puede subirse pero no bajarse del suelo documentado", async () => {
    await rejects(
      () =>
        db.query("update media_abandon_policy set protected_before = $1", [ago(100000)]),
      /cutoff_floor/,
    );
    await db.query("update media_abandon_policy set protected_before = $1", [ago(30)]);
  });
});

// R7 FINAL · prueba ACELERADA local (PGlite; sin PostgreSQL local disponible → sin concurrencia real).
// El reloj real (2026-10-10) deja `ahora − 25 h` por debajo del suelo del corte (2026-10-09 23:00Z), así que
// las 24 h se simulan desplazando los timestamps (UPDATE local) y adelantando el «ahora» del marcador real.
describe("prueba acelerada B/C/D/E/F con el marcador y el GC reales", () => {
  const SIM = Date.parse("2026-10-12T12:00:00Z");
  const simNow = new Date(SIM).toISOString();
  const simAgo = (h: number) => new Date(SIM - h * 3600_000).toISOString();
  const [B, C, D, E, F] = [11, 12, 13, 14, 15];
  const gcDb: GcDb = {
    async rpc(name, args) {
      const params = Object.values(args);
      try {
        return {
          data: (
            await db.query<{ r: unknown }>(
              `select ${name}(${params.map((_, i) => `$${i + 1}`).join(",")}) r`,
              params,
            )
          ).rows[0].r,
          error: null,
        };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
  function fakeR2(abortFails = false) {
    const calls: string[] = [];
    const io: PhysicalDeleteIo = {
      async deletePublic(keys) {
        calls.push(`delete-public:${keys.length}`);
      },
      async deletePrivate(key) {
        calls.push(`delete-private:${key}`);
      },
      async abortMultipart(key, uploadId) {
        calls.push(`abort:${key}:${uploadId}`);
        if (abortFails) throw new Error("R2 503");
      },
    };
    return { io, calls };
  }
  const gc = (io: PhysicalDeleteIo) =>
    runMediaGcBatch({ db: gcDb, io, log: () => undefined });
  const deletingCount = async () =>
    (
      await db.query<{ n: string }>(
        "select count(*)::text n from media_assets where id = any($1::uuid[]) and status = 'deleting'",
        [[B, C, D, E, F].map(A)],
      )
    ).rows[0].n;

  async function seed() {
    // Se crean «ahora» (reloj real) y SOLO DESPUÉS se desplazan los timestamps.
    for (const [n, status, mp] of [
      [B, "reserved", true],
      [C, "reserved", true],
      [D, "reserved", true],
      [E, "ready", false],
      [F, "failed", false],
    ] as const)
      await asset(n, status, { multipart: mp, created: new Date().toISOString() });
    await db.query(
      "insert into community_post_media(post_id,asset_id,position) values($1,$2,9)",
      [POST, A(E)],
    );
    const shift = (n: number, created: string) =>
      db.query("update media_assets set created_at=$2, updated_at=$2 where id=$1", [
        A(n),
        created,
      ]);
    await shift(B, simAgo(25)); // abandonada, posterior al corte
    await shift(C, simAgo(1)); // reciente de control
    await shift(D, "2026-10-01T01:02:45Z"); // histórica protegida
    await shift(E, simAgo(30)); // publicada (ready y enlazada a un post)
    await shift(F, simAgo(30)); // fallida
    await enable(); // 24 h por defecto
  }

  it("los timestamps desplazados se conservan (el trigger de actividad no los pisa)", async () => {
    await seed();
    const r = await db.query<{ ok: boolean }>(
      "select updated_at = $2::timestamptz as ok from media_assets where id=$1",
      [A(B), simAgo(25)],
    );
    expect(r.rows[0].ok).toBe(true);
  });

  it("el marcador real marca SOLO B; C, D, E y F intactos", async () => {
    await seed();
    const r = await mark(simNow);
    expect(r).toMatchObject({ status: "ran", candidates: 1, marked: 1, skipped: 0 });
    expect(await statusOf(B)).toBe("deleting");
    expect(await statusOf(C)).toBe("reserved");
    expect(await statusOf(D)).toBe("reserved");
    expect(await statusOf(E)).toBe("ready");
    expect(await statusOf(F)).toBe("failed");
    expect(await deletingCount()).toBe("1");
  });

  it("el GC (R2 simulado) aborta SOLO la sesión de B con su uploadId y finaliza solo B", async () => {
    await seed();
    await mark(simNow);
    const { io, calls } = fakeR2();
    expect(await gc(io)).toMatchObject({ claimed: 1, finalized: 1, failed: 0 });
    expect(calls[0]).toBe(`abort:staging/community/${A(B)}/original.mp4:${UP}`);
    expect(calls.filter((c) => c.startsWith("abort:"))).toHaveLength(1);
    expect(calls.some((c) => [C, D, E, F].some((n) => c.includes(A(n))))).toBe(false);
    expect(await statusOf(B)).toBeUndefined();
    expect(await statusOf(C)).toBe("reserved");
    expect(await statusOf(D)).toBe("reserved");
    expect(await statusOf(E)).toBe("ready");
    expect(await statusOf(F)).toBe("failed");
  });

  it("idempotencia: repetir marcador y GC no cambia nada ni vuelve a llamar a R2", async () => {
    await seed();
    await mark(simNow);
    await gc(fakeR2().io);
    expect(await mark(simNow)).toMatchObject({ candidates: 0, marked: 0 });
    const second = fakeR2();
    expect(await gc(second.io)).toMatchObject({ claimed: 0, finalized: 0 });
    expect(second.calls).toHaveLength(0);
  });

  it("reintento: si R2 falla, B y su uploadId sobreviven y el marcador no lo re-elige", async () => {
    await seed();
    await mark(simNow);
    expect(await gc(fakeR2(true).io)).toMatchObject({ finalized: 0, failed: 1 });
    expect(await statusOf(B)).toBe("deleting");
    const up = await db.query<{ m: string }>(
      "select multipart_upload_id m from media_assets where id=$1",
      [A(B)],
    );
    expect(up.rows[0].m).toBe(UP);
    expect(await mark(simNow)).toMatchObject({ candidates: 0, marked: 0 });
    expect(await statusOf(C)).toBe("reserved");
    expect(await statusOf(D)).toBe("reserved");
  });

  it("error del marcador: se contiene, no marca nada y B se marca en la siguiente ejecución sana", async () => {
    await seed();
    await db.exec(`create function tmp_fail2() returns trigger language plpgsql as
      $f$ begin raise exception 'boom'; end $f$;
      create trigger tmp_fail2 before update on media_assets for each row
      execute function tmp_fail2();`);
    const bad = await mark(simNow);
    expect(bad).toMatchObject({ status: "error" });
    expect(JSON.stringify(bad)).not.toMatch(/boom/);
    expect(await deletingCount()).toBe("0");
    await db.exec("drop trigger tmp_fail2 on media_assets");
    expect(await mark(simNow)).toMatchObject({ marked: 1 });
    expect(await statusOf(B)).toBe("deleting");
  });

  it("con el reloj real nada es elegible: las 24 h no han pasado", async () => {
    await seed();
    expect(await mark(null)).toMatchObject({ candidates: 0, marked: 0 });
  });
});

describe("umbral de 4 horas (decisión de R7: solo cambia min_age de la política)", () => {
  it("el CHECK admite 4 h y la función usa exactamente ese valor", async () => {
    await enable("min_age = interval '4 hours'");
    expect((await policy()).min_age).toBe("04:00:00");
    expect(await mark()).toMatchObject({ status: "ran", minAge: "04:00:00" });
  });

  it("A protegido, B abandonado, C reciente y D activo: solo B se marca; el límite exacto es 4 h", async () => {
    await enable("min_age = interval '4 hours', batch_limit = 1");
    await asset(1, "reserved", { created: "2026-10-09T23:06:39Z", multipart: true }); // A: anterior al corte
    await db.query("update media_abandon_policy set protected_before = $1", [
      "2026-10-10T14:47:55Z",
    ]);
    await asset(2, "reserved", { created: ago(4.2), multipart: true }); // B: >4 h sin actividad
    await asset(3, "reserved", { created: ago(1), multipart: true }); // C: reciente
    await asset(4, "reserved", {
      created: ago(10),
      updated: ago(0.5),
      multipart: true,
    }); // D: antigua pero con actividad hace 30 min
    await asset(5, "reserved", { created: ago(3.99) }); // por debajo del umbral
    const r = await mark();
    expect(r).toMatchObject({ status: "ran", candidates: 1, marked: 1 });
    expect(await statusOf(2)).toBe("deleting");
    for (const n of [1, 3, 4, 5]) expect(await statusOf(n)).toBe("reserved");
  });

  it("una subida con actividad reciente no se elimina por superar las 4 h desde su creación", async () => {
    await enable("min_age = interval '4 hours'");
    await asset(1, "processing", { created: ago(9), updated: ago(3.9) }); // actividad hace 3,9 h
    await asset(2, "processing", { created: ago(9), updated: ago(4) }); // actividad hace 4 h: se marca
    expect(await mark()).toMatchObject({ candidates: 1, marked: 1 });
    expect(await statusOf(1)).toBe("processing");
    expect(await statusOf(2)).toBe("deleting");
  });

  it("ready y failed no se tocan con 4 h (los vínculos con publicaciones exigen ready)", async () => {
    await enable("min_age = interval '4 hours'");
    await asset(1, "ready", { created: ago(100) });
    await asset(2, "failed", { created: ago(100) });
    expect(await mark()).toMatchObject({ candidates: 0, marked: 0 });
    expect(await statusOf(1)).toBe("ready");
    expect(await statusOf(2)).toBe("failed");
  });
});
