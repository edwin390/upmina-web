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

// R5-S1: SQL REAL (PGlite en memoria, ninguna infraestructura externa) de la migración PROPUESTA
// 20261026120000_media_abandoned_cleanup.sql: descarte voluntario, barrido de abandonados y claves
// canónicas del GC. Los R2 de este archivo son falsos: NO prueban borrado físico real en Cloudflare.

const migration = (n: string) => readFileSync(`supabase/migrations/${n}`, "utf8");
const A = (n: number) => `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OTHER = "44444444-4444-4444-8444-444444444444";
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
}, 60000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("begin");
});
afterEach(async () => {
  await db.exec("rollback");
  await db.exec("reset role");
});

/** Ejecuta algo que DEBE fallar sin abortar la transacción del test (savepoint). */
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
  ageHours: number,
  extra: { domain?: string; owner?: string; priv?: string | null } = {},
) {
  const domain = extra.domain ?? "community";
  await db.query(
    `insert into media_assets(id,domain,kind,status,created_by,storage_key,private_original_key,
       failure_code,created_at,updated_at)
     values($1,$2,'image',$3,$4,$5,$6,$7, now() - make_interval(hours => $8),
       now() - make_interval(hours => $8))`,
    [
      A(n),
      domain,
      status,
      extra.owner ?? ACTOR,
      status === "ready" ? `${domain}/${A(n)}/w960.webp` : null,
      extra.priv === undefined
        ? status === "ready"
          ? null
          : `staging/${domain}/${A(n)}/original.jpg`
        : extra.priv,
      status === "failed" ? "processing_failed" : null,
      ageHours,
    ],
  );
}
const statusOf = async (n: number) =>
  (
    await db.query<{ status: string }>("select status from media_assets where id=$1", [
      A(n),
    ])
  ).rows[0]?.status;
const discard = async (n: number, actor = ACTOR) =>
  (
    await db.query<{ r: { result: string } }>(
      "select community_media_asset_discard($1,$2) r",
      [A(n), actor],
    )
  ).rows[0].r.result;
/** Notación nombrada: SQL no admite DEFAULT como argumento posicional en una llamada. */
const sweep = async (args: Record<string, string> = {}) =>
  (
    await db.query<{ r: Record<string, number> }>(
      `select media_abandoned_sweep(${Object.entries(args)
        .map(([k, v]) => `${k} => ${v}`)
        .join(", ")}) r`,
    )
  ).rows[0].r;

describe("community_media_asset_discard", () => {
  it("marca como deleting un ready propio sin referencias, conservando fila y claves", async () => {
    await asset(1, "ready", 1);
    expect(await discard(1)).toBe("marked");
    expect(await statusOf(1)).toBe("deleting");
    const row = (
      await db.query<{ k: string }>(
        "select storage_key k from media_assets where id=$1",
        [A(1)],
      )
    ).rows[0];
    expect(row.k).toBe(`community/${A(1)}/w960.webp`);
  });

  it("es idempotente: la segunda llamada informa already_deleting y no cambia nada", async () => {
    await asset(1, "ready", 1);
    await discard(1);
    expect(await discard(1)).toBe("already_deleting");
  });

  it("no toca un ready vinculado a una publicación de Community", async () => {
    await asset(1, "ready", 1);
    await db.query(
      "insert into community_post_media(post_id,asset_id,position) values($1,$2,5)",
      [POST, A(1)],
    );
    expect(await discard(1)).toBe("referenced");
    expect(await statusOf(1)).toBe("ready");
  });

  it("no toca un ready vinculado a una publicación de Cosplay", async () => {
    await asset(1, "ready", 1);
    await db.query("insert into cosplay_post_images values($1)", [A(1)]);
    expect(await discard(1)).toBe("referenced");
    expect(await statusOf(1)).toBe("ready");
  });

  it("asset ajeno, inexistente o de Cosplay: not_found (indistinguibles) y sin cambios", async () => {
    await asset(1, "ready", 1);
    await asset(2, "ready", 1, { domain: "cosplay" });
    expect(await discard(1, OTHER)).toBe("not_found");
    expect(await discard(2)).toBe("not_found");
    expect(await discard(99)).toBe("not_found");
    expect(await statusOf(1)).toBe("ready");
    expect(await statusOf(2)).toBe("ready");
  });

  it("un asset que todavía se está subiendo/procesando no es descartable aquí (not_ready)", async () => {
    await asset(1, "processing", 1);
    expect(await discard(1)).toBe("not_ready");
    expect(await statusOf(1)).toBe("processing");
  });

  it("solo service_role puede ejecutarla", async () => {
    await rejects(() =>
      db.exec(
        `set role authenticated; select community_media_asset_discard('${A(1)}','${ACTOR}')`,
      ),
    );
    await db.exec("reset role");
  });
});

describe("media_abandoned_sweep", () => {
  it("reclama solo lo suficientemente viejo; lo reciente/activo y lo referenciado NO se toca", async () => {
    await asset(1, "ready", 73); // abandonado
    await asset(2, "ready", 10); // reciente: editor abierto
    await asset(3, "ready", 73); // viejo pero vinculado
    await db.query(
      "insert into community_post_media(post_id,asset_id,position) values($1,$2,6)",
      [POST, A(3)],
    );
    await asset(4, "ready", 73); // vinculado solo a Cosplay
    await db.query("insert into cosplay_post_images values($1)", [A(4)]);
    await asset(5, "reserved", 25); // reserva abandonada
    await asset(6, "reserved", 1); // subida activa
    await asset(7, "processing", 25); // procesado atascado
    await asset(8, "processing", 1); // procesado activo
    await asset(9, "failed", 80); // fallo abandonado
    await asset(10, "failed", 10); // fallo reciente: el usuario puede reintentar

    const result = await sweep();
    expect(result).toMatchObject({ readyMarked: 1, pendingMarked: 2, failedMarked: 1 });
    expect(await statusOf(1)).toBe("deleting");
    expect(await statusOf(5)).toBe("deleting");
    expect(await statusOf(7)).toBe("deleting");
    expect(await statusOf(9)).toBe("deleting");
    for (const n of [2, 3, 4, 6, 8, 10]) expect(await statusOf(n)).not.toBe("deleting");
    expect(await statusOf(3)).toBe("ready");
    expect(await statusOf(4)).toBe("ready");
    const failure = await db.query<{ f: string | null }>(
      "select failure_code f from media_assets where id=$1",
      [A(9)],
    );
    expect(failure.rows[0].f).toBeNull(); // failure_code solo existe con status=failed
  });

  it("es idempotente y no reclama dos veces ni toca lo que ya está en la cola", async () => {
    await asset(1, "ready", 73);
    await asset(2, "reserved", 30);
    expect(await sweep()).toMatchObject({ readyMarked: 1, pendingMarked: 1 });
    expect(await sweep()).toMatchObject({
      readyMarked: 0,
      pendingMarked: 0,
      failedMarked: 0,
    });
  });

  it("no afecta a los assets que ya están deleting (cola GC: reclamos, backoff, lease)", async () => {
    await asset(1, "reserved", 30);
    await db.query("select community_media_asset_discard($1,$2)", [A(1), ACTOR]);
    await db.query(
      "update media_assets set status='deleting', purge_attempts=3, purge_next_attempt_at=now()+interval '1 hour' where id=$1",
      [A(1)],
    );
    await sweep();
    const row = (
      await db.query<{ a: number }>(
        "select purge_attempts a from media_assets where id=$1",
        [A(1)],
      )
    ).rows[0];
    expect(row.a).toBe(3);
  });

  it("Cosplay ready queda fuera por defecto; con el interruptor explícito solo cae lo no referenciado", async () => {
    await asset(1, "ready", 100, { domain: "cosplay" });
    await asset(2, "ready", 100, { domain: "cosplay" });
    await db.query("insert into cosplay_post_images values($1)", [A(2)]);
    await sweep();
    expect(await statusOf(1)).toBe("ready");
    await sweep({ p_include_cosplay_ready: "true" });
    expect(await statusOf(1)).toBe("deleting");
    expect(await statusOf(2)).toBe("ready");
  });

  it("reserved/failed de Cosplay SÍ se barren (no son material preparado)", async () => {
    await asset(1, "reserved", 30, { domain: "cosplay" });
    await asset(2, "failed", 100, { domain: "cosplay" });
    await sweep();
    expect(await statusOf(1)).toBe("deleting");
    expect(await statusOf(2)).toBe("deleting");
  });

  it("el límite no se agota con ready YA publicados: los referenciados no ocupan plazas (sin inanición)", async () => {
    // Un ready publicado y más antiguo que el abandonado: con límite 1, el candidato debe ser el abandonado.
    await asset(1, "ready", 200);
    await db.query(
      "insert into community_post_media(post_id,asset_id,position) values($1,$2,7)",
      [POST, A(1)],
    );
    await asset(2, "ready", 100);
    expect(await sweep({ p_limit: "1" })).toMatchObject({ readyMarked: 1 });
    expect(await statusOf(1)).toBe("ready");
    expect(await statusOf(2)).toBe("deleting");
  });

  it("un failed REINTENTADO (transición reciente) o un asset en procesado activo NO se reclaman aunque se reservaran hace días", async () => {
    await asset(1, "failed", 200);
    await db.query("update media_assets set status='uploaded' where id=$1", [A(1)]); // reintento: failed → uploaded
    await asset(2, "reserved", 200);
    await db.query("update media_assets set status='processing' where id=$1", [A(2)]);
    expect(await sweep()).toMatchObject({
      readyMarked: 0,
      pendingMarked: 0,
      failedMarked: 0,
    });
    expect(await statusOf(1)).toBe("uploaded");
    expect(await statusOf(2)).toBe("processing");
  });

  it("un ready cuenta desde que LLEGÓ a ready, no desde la reserva original", async () => {
    await asset(1, "reserved", 200);
    await db.query(
      "update media_assets set status='ready', storage_key='x' where id=$1",
      [A(1)],
    );
    expect(await sweep()).toMatchObject({ readyMarked: 0 });
    expect(await statusOf(1)).toBe("ready");
  });

  it("las escrituras del GC (claim/fail/lease) no refrescan la actividad ni reordenan la cola", async () => {
    await asset(1, "reserved", 30);
    await sweep();
    const before = (
      await db.query<{ u: string }>(
        "select updated_at::text u from media_assets where id=$1",
        [A(1)],
      )
    ).rows[0].u;
    await db.query("select community_asset_gc_claim(10, 300)");
    const after = (
      await db.query<{ u: string }>(
        "select updated_at::text u from media_assets where id=$1",
        [A(1)],
      )
    ).rows[0].u;
    expect(after).toBe(before);
  });

  it("respeta el límite por ejecución", async () => {
    await asset(1, "reserved", 30);
    await asset(2, "reserved", 31);
    await asset(3, "reserved", 32);
    expect(await sweep({ p_limit: "2" })).toMatchObject({ pendingMarked: 2 });
    expect(await sweep({ p_limit: "2" })).toMatchObject({ pendingMarked: 1 });
  });

  it.each([
    ["ready < 6 h", { p_ready_min_age: "interval '1 hour'" }],
    ["pending < 2 h", { p_pending_min_age: "interval '10 minutes'" }],
    ["failed < 6 h", { p_failed_min_age: "interval '1 hour'" }],
    ["límite 0", { p_limit: "0" }],
    ["límite > 200", { p_limit: "201" }],
    ["nulos", { p_ready_min_age: "null" }],
  ] as [string, Record<string, string>][])(
    "rechaza argumentos peligrosos (%s): no puede reclamar trabajo en curso",
    async (_n, args) => {
      await asset(1, "reserved", 3);
      await rejects(() => sweep(args), /invalid_argument/);
      expect(await statusOf(1)).toBe("reserved");
    },
  );

  it("no se programa solo: ningún job de pg_cron ni el tick lo invocan", () => {
    const sql = migration("20261026120000_media_abandoned_cleanup.sql");
    expect(sql).not.toMatch(/cron\.schedule/i);
    expect(migration("20261021120000_community_media_purge_scheduler.sql")).not.toMatch(
      /media_abandoned_sweep/,
    );
  });

  it("solo service_role puede ejecutarla", async () => {
    await rejects(() =>
      db.exec("set role authenticated; select media_abandoned_sweep()"),
    );
    await db.exec("reset role");
  });
});

describe("integración con el GC existente (R2 simulado)", () => {
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
  function fakeR2(failPublic = false) {
    const deleted: string[] = [];
    const io: PhysicalDeleteIo = {
      async deletePublic(keys) {
        if (failPublic)
          throw Object.assign(new Error("partial"), { name: "R2PartialDeleteError" });
        deleted.push(...keys);
      },
      async deletePrivate(key) {
        deleted.push(key);
      },
    };
    return { io, deleted };
  }
  const exists = async (n: number) =>
    (await db.query("select 1 from media_assets where id=$1", [A(n)])).rows.length === 1;

  it("un reserved abandonado: el barrido lo marca y el GC borra su staging + toda clave canónica posible", async () => {
    await asset(1, "reserved", 30);
    await sweep();
    const { io, deleted } = fakeR2();
    const summary = await runMediaGcBatch({ db: adapter, io, log: () => undefined });
    expect(summary).toMatchObject({ claimed: 1, finalized: 1, failed: 0 });
    expect(deleted.sort()).toEqual(
      [
        `staging/community/${A(1)}/original.jpg`,
        ...["mov", "mp4", "webm"].map((e) => `community/${A(1)}/original.${e}`),
        ...["1600", "2560", "480", "960"].map((w) => `community/${A(1)}/w${w}.webp`),
      ].sort(),
    );
    expect(await exists(1)).toBe(false);
  });

  it("si R2 falla la fila NO desaparece: queda con backoff y un reintento posterior la completa", async () => {
    await asset(1, "failed", 100);
    await sweep();
    const first = await runMediaGcBatch({
      db: adapter,
      io: fakeR2(true).io,
      log: () => undefined,
    });
    expect(first).toMatchObject({ claimed: 1, finalized: 0, failed: 1 });
    expect(await exists(1)).toBe(true);
    // Mientras dura el backoff no se reclama de nuevo.
    expect(
      (await runMediaGcBatch({ db: adapter, io: fakeR2().io, log: () => undefined }))
        .claimed,
    ).toBe(0);
    await db.query(
      "update media_assets set purge_next_attempt_at = now() - interval '1 second' where id = $1",
      [A(1)],
    );
    const retry = await runMediaGcBatch({
      db: adapter,
      io: fakeR2().io,
      log: () => undefined,
    });
    expect(retry).toMatchObject({ claimed: 1, finalized: 1 });
    expect(await exists(1)).toBe(false);
  });

  it("nunca se borran claves de otro asset: todo lo devuelto lleva el id del asset reclamado", async () => {
    await asset(1, "reserved", 30);
    await asset(2, "ready", 73);
    await sweep();
    const { io, deleted } = fakeR2();
    await runMediaGcBatch({ db: adapter, io, log: () => undefined });
    expect(deleted.length).toBeGreaterThan(0);
    for (const key of deleted)
      expect([A(1), A(2)].some((id) => key.includes(id))).toBe(true);
  });
});

describe("separación: borrado voluntario ≠ retención de moderación ≠ barrido de abandonados", () => {
  const fn = (sql: string, name: string) =>
    sql
      .slice(
        sql.search(
          new RegExp(`create (?:or replace )?function public\\.${name}\\(`, "i"),
        ),
      )
      .split("\n$$;")[0];

  it("el borrado del autor marca 'deleting' en el acto y no usa ningún plazo de retención", () => {
    const body = fn(
      migration("20261004120000_community_posts_media.sql"),
      "community_post_delete",
    );
    expect(body).toMatch(/status = 'deleting'/);
    expect(body).not.toMatch(/purge_after|removed_pending_purge|interval/i);
  });

  it("la purga por moderación conserva su plazo y no se modifica en esta migración", () => {
    const proposal = migration("20261026120000_media_abandoned_cleanup.sql");
    expect(proposal).not.toMatch(
      /community_purge_due_posts|purge_after|removed_pending_purge/,
    );
  });

  it("el barrido jamás lee posts: la protección es por referencia directa a community_post_media / cosplay_post_images", () => {
    const body = fn(
      migration("20261026120000_media_abandoned_cleanup.sql"),
      "media_abandoned_sweep",
    );
    expect(body).toMatch(/community_post_media/);
    expect(body).toMatch(/cosplay_post_images/);
    expect(body).not.toMatch(/delete from/i);
  });
});

describe("simulación SELECT (docs/9K-R5-S1-sweep-simulation.sql)", () => {
  const sim = readFileSync("docs/9K-R5-S1-sweep-simulation.sql", "utf8");
  const run = async () =>
    (
      await db.query<{
        asset_id: string;
        verdict: string;
        est_public_object_keys: number;
      }>(sim)
    ).rows;

  it("es de solo lectura: ninguna sentencia que escriba ni función con efectos", () => {
    const code = sim.replace(/--.*$/gm, "");
    expect(code).not.toMatch(
      /\b(insert|update|delete|alter|drop|create|truncate|grant)\b/i,
    );
    expect(code).not.toMatch(
      /media_abandoned_sweep|community_media_asset_discard|for update/i,
    );
  });

  it("sus ELIGIBLE coinciden EXACTAMENTE con lo que el barrido marca, y no modifica nada", async () => {
    await asset(1, "ready", 73);
    await asset(2, "ready", 10);
    await asset(3, "ready", 73);
    await db.query(
      "insert into community_post_media(post_id,asset_id,position) values($1,$2,8)",
      [POST, A(3)],
    );
    await asset(4, "reserved", 25);
    await asset(5, "reserved", 1);
    await asset(6, "failed", 80);
    await asset(7, "failed", 10);
    await asset(8, "ready", 100, { domain: "cosplay" });
    await asset(9, "processing", 30);
    const before = (
      await db.query("select id,status,updated_at from media_assets order by id")
    ).rows;

    const rows = await run();
    const eligible = rows
      .filter((r) => r.verdict === "ELIGIBLE")
      .map((r) => r.asset_id)
      .sort();
    expect(rows.find((r) => r.asset_id === A(3))?.verdict).toBe("SKIPPED_REFERENCED");
    expect(rows.find((r) => r.asset_id === A(8))?.verdict).toBe("EXCLUDED_COSPLAY_READY");
    expect(rows.some((r) => [A(2), A(5), A(7)].includes(r.asset_id))).toBe(false);
    expect(
      (await db.query("select id,status,updated_at from media_assets order by id")).rows,
    ).toEqual(before);

    await sweep();
    const marked = (
      await db.query<{ id: string }>(
        "select id from media_assets where status='deleting' and id::text like '0f000000-%' order by id",
      )
    ).rows.map((r) => r.id);
    expect(marked).toEqual(eligible);
  });

  it("estima 7 claves públicas para community (4 webp + 3 originales) y 4 para cosplay", async () => {
    await asset(1, "reserved", 30);
    await asset(2, "reserved", 30, { domain: "cosplay" });
    const rows = await run();
    expect(rows.find((r) => r.asset_id === A(1))?.est_public_object_keys).toBe(7);
    expect(rows.find((r) => r.asset_id === A(2))?.est_public_object_keys).toBe(4);
  });
});

// ── R6: protección de sesiones multipart (migración 20261027, SQL REAL) ───────────────────────

describe("R6 · protección de sesiones multipart abandonadas", () => {
  const UP = "synthetic-upload-id-0001";
  const TOKEN = "0c000000-0000-4000-8000-0000000000aa";
  const STAGING = (n: number) => `staging/community/${A(n)}/original.mp4`;

  /** Reserva multipart abandonada ya marcada 'deleting' y reclamada con un lease vivo. */
  async function claimedMultipart(
    n: number,
    opts: { upload?: string | null; key?: string | null; leaseSeconds?: number } = {},
  ) {
    await asset(n, "reserved", 30, {
      priv: opts.key === undefined ? STAGING(n) : opts.key,
    });
    await db.query("update media_assets set multipart_upload_id=$2 where id=$1", [
      A(n),
      opts.upload === undefined ? UP : opts.upload,
    ]);
    await db.query(
      `update media_assets set status='deleting', purge_claim_token=$2,
         purge_lease_until = now() + make_interval(secs => $3) where id=$1`,
      [A(n), TOKEN, opts.leaseSeconds ?? 300],
    );
  }
  const objectsOf = async (n: number) =>
    (
      await db.query<{ r: Record<string, unknown> }>(
        "select community_asset_gc_objects($1,$2) r",
        [A(n), TOKEN],
      )
    ).rows[0].r;
  const cleared = async (n: number, token = TOKEN, upload = UP) =>
    (
      await db.query<{ r: { result: string } }>(
        "select community_asset_gc_multipart_cleared($1,$2,$3) r",
        [A(n), token, upload],
      )
    ).rows[0].r.result;
  const finalize = async (n: number) =>
    (
      await db.query<{ r: { result: string } }>(
        "select community_asset_gc_finalize($1,$2) r",
        [A(n), TOKEN],
      )
    ).rows[0].r.result;
  const mpId = async (n: number) =>
    (
      await db.query<{ m: string | null }>(
        "select multipart_upload_id m from media_assets where id=$1",
        [A(n)],
      )
    ).rows[0]?.m;
  const exists = async (n: number) =>
    (await db.query("select 1 from media_assets where id=$1", [A(n)])).rows.length === 1;

  describe("community_asset_gc_objects", () => {
    it("devuelve el identificador y la clave de la sesión, conservando el resto del contrato", async () => {
      await claimedMultipart(1);
      const r = await objectsOf(1);
      expect(r).toMatchObject({
        valid: true,
        assetId: A(1),
        rejectedKeys: 0,
        multipartUploadId: UP,
        multipartKey: STAGING(1),
        privateKeys: [STAGING(1)],
      });
      // Claves canónicas de 20261026 intactas.
      expect(r.publicKeys).toHaveLength(7);
    });

    it("sin sesión: campos null (y contrato antiguo intacto)", async () => {
      await claimedMultipart(1, { upload: null });
      expect(await objectsOf(1)).toMatchObject({
        valid: true,
        multipartUploadId: null,
        multipartKey: null,
        rejectedKeys: 0,
      });
    });

    it("identificador sin clave válida de staging: no se expone y cuenta como clave rechazada", async () => {
      await claimedMultipart(1, { key: null });
      expect(await objectsOf(1)).toMatchObject({
        multipartUploadId: null,
        multipartKey: null,
        rejectedKeys: 1,
      });
      await claimedMultipart(2, { key: `staging/community/${A(3)}/original.mp4` });
      const other = await objectsOf(2);
      expect(other.multipartKey).toBeNull();
      expect(Number(other.rejectedKeys)).toBeGreaterThan(0);
    });

    it("sin claim vigente sigue devolviendo valid:false", async () => {
      await claimedMultipart(1, { leaseSeconds: -5 });
      expect(await objectsOf(1)).toEqual({ valid: false });
    });
  });

  describe("community_asset_gc_multipart_cleared", () => {
    it("limpia solo con asset deleting + token + lease vivos + identificador EXACTO", async () => {
      await claimedMultipart(1);
      expect(await cleared(1)).toBe("cleared");
      expect(await mpId(1)).toBeNull();
      expect(await exists(1)).toBe(true); // limpiar no borra la fila
    });

    it("es idempotente: repetir tras un fallo posterior da already_cleared", async () => {
      await claimedMultipart(1);
      await cleared(1);
      expect(await cleared(1)).toBe("already_cleared");
    });

    it("identificador distinto: upload_id_changed y NO se toca el guardado", async () => {
      await claimedMultipart(1);
      expect(await cleared(1, TOKEN, "otro-identificador")).toBe("upload_id_changed");
      expect(await mpId(1)).toBe(UP);
    });

    it("token ajeno, lease vencido o estado no deleting: invalid_claim y sin cambios", async () => {
      await claimedMultipart(1);
      expect(await cleared(1, "0c000000-0000-4000-8000-0000000000bb")).toBe(
        "invalid_claim",
      );
      await claimedMultipart(2, { leaseSeconds: -5 });
      expect(await cleared(2)).toBe("invalid_claim");
      await asset(3, "reserved", 30);
      await db.query("update media_assets set multipart_upload_id=$2 where id=$1", [
        A(3),
        UP,
      ]);
      expect(await cleared(3)).toBe("invalid_claim");
      for (const n of [1, 2, 3]) expect(await mpId(n)).toBe(UP);
    });

    it("asset inexistente: already_gone; argumentos nulos o vacíos: invalid_argument", async () => {
      expect(await cleared(99)).toBe("already_gone");
      await rejects(() => cleared(1, TOKEN, ""), /invalid_argument/);
      await rejects(
        () =>
          db.query("select community_asset_gc_multipart_cleared(null,$1,$2)", [
            TOKEN,
            UP,
          ]),
        /invalid_argument/,
      );
    });

    it("solo service_role puede ejecutarla", async () => {
      await claimedMultipart(1);
      await rejects(() =>
        db.exec(
          `set role authenticated; select community_asset_gc_multipart_cleared('${A(1)}','${TOKEN}','${UP}')`,
        ),
      );
      await db.exec("reset role");
      expect(await mpId(1)).toBe(UP);
    });
  });

  describe("community_asset_gc_finalize y barrera BEFORE DELETE", () => {
    it("finalize NO borra con sesión pendiente: multipart_pending, fila e identificador intactos, reintento programado", async () => {
      await claimedMultipart(1);
      expect(await finalize(1)).toBe("multipart_pending");
      expect(await exists(1)).toBe(true);
      expect(await mpId(1)).toBe(UP);
      const row = (
        await db.query<{ a: number; c: string; t: string | null }>(
          "select purge_attempts a, purge_last_error_class c, purge_claim_token::text t from media_assets where id=$1",
          [A(1)],
        )
      ).rows[0];
      expect(row).toMatchObject({ a: 1, c: "multipart_pending", t: null });
    });

    it("tras limpiar el identificador, finalize borra la fila (comportamiento previo)", async () => {
      await claimedMultipart(1);
      await cleared(1);
      expect(await finalize(1)).toBe("deleted");
      expect(await exists(1)).toBe(false);
    });

    it("sin sesión finalize se comporta como antes: deleted / invalid_claim / already_gone / blocked", async () => {
      await claimedMultipart(1, { upload: null });
      expect(await finalize(1)).toBe("deleted");
      expect(await finalize(1)).toBe("already_gone");
      await claimedMultipart(2, { upload: null });
      await db.query(
        "update media_assets set purge_claim_token=null, purge_lease_until=null where id=$1",
        [A(2)],
      );
      expect(await finalize(2)).toBe("invalid_claim");
      await claimedMultipart(3, { upload: null });
      await db.query(
        "insert into community_post_media(post_id,asset_id,position) values($1,$2,7)",
        [POST, A(3)],
      );
      expect(await finalize(3)).toBe("blocked");
    });

    it("un DELETE directo (cleanup inline, rollback de reserve, SQL manual) con sesión abierta es rechazado", async () => {
      await asset(1, "reserved", 1);
      await db.query("update media_assets set multipart_upload_id=$2 where id=$1", [
        A(1),
        UP,
      ]);
      await rejects(
        () => db.query("delete from media_assets where id=$1", [A(1)]),
        /media_asset_multipart_open/,
      );
      expect(await exists(1)).toBe(true);
      expect(await mpId(1)).toBe(UP);
    });

    it("el DELETE directo sin sesión sigue funcionando y arrastra sus variantes en cascada", async () => {
      await asset(1, "ready", 1);
      await db.query(
        "insert into media_asset_variants(asset_id,variant,storage_key) values($1,480,'k')",
        [A(1)],
      );
      await db.query("delete from media_assets where id=$1", [A(1)]);
      expect(await exists(1)).toBe(false);
      expect(
        (await db.query("select 1 from media_asset_variants where asset_id=$1", [A(1)]))
          .rows,
      ).toHaveLength(0);
    });

    it("con sesión abierta y variantes: el DELETE rechazado no deja variantes huérfanas (todo o nada)", async () => {
      await asset(1, "reserved", 1);
      await db.query("update media_assets set multipart_upload_id=$2 where id=$1", [
        A(1),
        UP,
      ]);
      await db.query(
        "insert into media_asset_variants(asset_id,variant,storage_key) values($1,480,'k')",
        [A(1)],
      );
      await rejects(() => db.query("delete from media_assets where id=$1", [A(1)]));
      expect(
        (await db.query("select 1 from media_asset_variants where asset_id=$1", [A(1)]))
          .rows,
      ).toHaveLength(1);
    });

    it("ninguna FK con ON DELETE CASCADE apunta hacia media_assets desde otra tabla padre (no hay cascadas que el trigger pueda romper)", async () => {
      const parents = await db.query<{ t: string; action: string }>(
        `select confrelid::regclass::text t, confdeltype::text action
           from pg_constraint
          where conrelid = 'media_assets'::regclass and contype = 'f'`,
      );
      // created_by → auth.users (SET NULL = UPDATE) y similares: ninguna borra filas de media_assets.
      for (const p of parents.rows) expect(p.action).not.toBe("c");
    });
  });

  describe("integración con el GC (R2 simulado) y el barrido", () => {
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
    function r2(opts: { abortFails?: boolean } = {}) {
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
          if (opts.abortFails) throw new Error("R2 503");
        },
      };
      return { io, calls };
    }
    const reservedMultipart = async (n: number, ageHours: number) => {
      await asset(n, "reserved", ageHours, { priv: STAGING(n) });
      await db.query("update media_assets set multipart_upload_id=$2 where id=$1", [
        A(n),
        UP,
      ]);
    };

    it("el barrido marca la reserva multipart sin perder el identificador; el GC aborta, limpia y solo entonces finaliza", async () => {
      await reservedMultipart(1, 30);
      await sweep();
      expect(await statusOf(1)).toBe("deleting");
      expect(await mpId(1)).toBe(UP); // el barrido no toca el identificador
      const { io, calls } = r2();
      const summary = await runMediaGcBatch({ db: adapter, io, log: () => undefined });
      expect(summary).toMatchObject({ claimed: 1, finalized: 1, failed: 0 });
      expect(calls[0]).toBe(`abort:${STAGING(1)}:${UP}`);
      expect(calls.slice(1).every((c) => c.startsWith("delete-"))).toBe(true);
      expect(await exists(1)).toBe(false);
    });

    it("si el aborto falla: la fila y el identificador sobreviven, con backoff; un reintento posterior lo completa", async () => {
      await reservedMultipart(1, 30);
      await sweep();
      const first = r2({ abortFails: true });
      const s1 = await runMediaGcBatch({
        db: adapter,
        io: first.io,
        log: () => undefined,
      });
      expect(s1).toMatchObject({ claimed: 1, finalized: 0, failed: 1 });
      expect(first.calls).toEqual([`abort:${STAGING(1)}:${UP}`]); // ningún borrado
      expect(await exists(1)).toBe(true);
      expect(await mpId(1)).toBe(UP);
      const row = (
        await db.query<{ a: number; c: string }>(
          "select purge_attempts a, purge_last_error_class c from media_assets where id=$1",
          [A(1)],
        )
      ).rows[0];
      expect(row).toMatchObject({ a: 1, c: "r2_multipart_abort_failed" });
      // Durante el backoff no se reclama de nuevo.
      expect(
        (await runMediaGcBatch({ db: adapter, io: r2().io, log: () => undefined }))
          .claimed,
      ).toBe(0);
      await db.query(
        "update media_assets set purge_next_attempt_at = now() - interval '1 second' where id=$1",
        [A(1)],
      );
      const second = r2();
      const s2 = await runMediaGcBatch({
        db: adapter,
        io: second.io,
        log: () => undefined,
      });
      expect(s2).toMatchObject({ claimed: 1, finalized: 1 });
      expect(second.calls[0]).toBe(`abort:${STAGING(1)}:${UP}`);
      expect(await exists(1)).toBe(false);
    });

    it("aborto OK pero cleared falla: la fila sigue con el identificador y el reintento (NoSuchUpload) la completa", async () => {
      await reservedMultipart(1, 30);
      await sweep();
      const flaky: GcDb = {
        async rpc(name, args) {
          if (name === "community_asset_gc_multipart_cleared")
            return { data: null, error: { message: "boom" } };
          return adapter.rpc(name, args);
        },
      };
      const first = r2();
      const s1 = await runMediaGcBatch({ db: flaky, io: first.io, log: () => undefined });
      expect(s1).toMatchObject({ finalized: 0, failed: 1 });
      expect(first.calls).toEqual([`abort:${STAGING(1)}:${UP}`]);
      expect(await mpId(1)).toBe(UP);
      await db.query(
        "update media_assets set purge_next_attempt_at = now() - interval '1 second' where id=$1",
        [A(1)],
      );
      const noSuch: PhysicalDeleteIo = {
        ...r2().io,
        async abortMultipart() {
          throw Object.assign(new Error("gone"), { name: "NoSuchUpload" });
        },
      };
      const s2 = await runMediaGcBatch({ db: adapter, io: noSuch, log: () => undefined });
      expect(s2).toMatchObject({ claimed: 1, finalized: 1, failed: 0 });
      expect(await exists(1)).toBe(false);
    });

    it("el GC antiguo (sin aborto) nunca puede borrar la fila: finalize devuelve multipart_pending", async () => {
      await reservedMultipart(1, 30);
      await sweep();
      const legacyIo: PhysicalDeleteIo = {
        async deletePublic() {},
        async deletePrivate() {},
      };
      const legacyDb: GcDb = {
        async rpc(name, args) {
          const res = await adapter.rpc(name, args);
          if (name === "community_asset_gc_objects") {
            const d = res.data as Record<string, unknown>;
            delete d.multipartUploadId;
            delete d.multipartKey;
          }
          return res;
        },
      };
      const s = await runMediaGcBatch({
        db: legacyDb,
        io: legacyIo,
        log: () => undefined,
      });
      expect(s).toMatchObject({ finalized: 0, failed: 1 });
      expect(await exists(1)).toBe(true);
      expect(await mpId(1)).toBe(UP);
    });

    it("el barrido no cambia: una reserva multipart reciente (<2 h) no se toca", async () => {
      await reservedMultipart(1, 1);
      await sweep();
      expect(await statusOf(1)).toBe("reserved");
      expect(await mpId(1)).toBe(UP);
    });

    it("solo el asset marcado se procesa: otro asset multipart sin marcar queda intacto", async () => {
      await reservedMultipart(1, 30);
      await reservedMultipart(2, 30);
      await db.query("update media_assets set status='deleting' where id=$1", [A(1)]);
      const { io, calls } = r2();
      const s = await runMediaGcBatch({ db: adapter, io, log: () => undefined });
      expect(s).toMatchObject({ claimed: 1, finalized: 1 });
      expect(calls.some((c) => c.includes(A(2)))).toBe(false);
      expect(await statusOf(2)).toBe("reserved");
      expect(await mpId(2)).toBe(UP);
    });
  });
});
