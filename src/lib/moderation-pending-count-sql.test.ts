// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// R5-H: SQL REAL (PGlite) de la migración PROPUESTA 20261031: contador agregado de casos pendientes.
// Definición: ciclo `pending` que es el ciclo vigente de su caso (= cola «Activos»); un caso cuenta
// una vez aunque tenga muchos reportes o ciclos anteriores cerrados.

const migration = (n: string) =>
  readFileSync(`supabase/migrations/${n}`, "utf8").replace(/\r\n/g, "\n");
const uid = (n: number) => `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MOD = uid(1);
const OUTSIDER = uid(2);
const reporters = [11, 12, 13].map(uid);
const AUTHOR = uid(21);
let db: TestDatabase;
let seq = 0;
interface Obj {
  [key: string]: unknown;
}
const one = async <T = Obj>(sql: string, params: unknown[] = []) =>
  (await db.query<{ r: T }>(sql, params)).rows[0].r;

beforeAll(async () => {
  db = await createAtomicTestDatabase();
  await db.exec(`create table admin_roles(user_id uuid primary key,role text);
 alter table profiles add column username text,add column display_name text;
 alter table media_assets add column storage_key text,add column width int,add column height int,
   add column duration_seconds numeric,add column private_original_key text;
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
    "20261022120000_moderation_purged_history_read.sql",
    "20261031120000_moderation_pending_count.sql",
  ])
    await db.exec(migration(n));
  await db.query("insert into admin_roles values($1,'moderator')", [MOD]);
  for (const id of [MOD, OUTSIDER, AUTHOR, ...reporters])
    await db.query("insert into auth.users values($1) on conflict do nothing", [id]);
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
    /* transacción abortada */
  }
  await db.exec("rollback");
});

async function report(post: string, count: number) {
  let ctx!: Obj;
  for (let i = 0; i < count; i++)
    ctx = await one<Obj>("select community_post_report_submit($1,$2,'spam',null) r", [
      reporters[i],
      post,
    ]);
  return ctx;
}
async function makeCase(reports = 1) {
  const post = uid(1000 + ++seq);
  await db.query(
    "insert into community_posts(id,author_user_id,text,version) values($1,$2,'t',2)",
    [post, AUTHOR],
  );
  return { post, ctx: await report(post, reports) };
}
const count = () => one<number>("select community_moderation_pending_count($1) r", [MOD]);

describe("contador de casos pendientes (SQL real)", () => {
  it("cero casos → 0 (un entero, no null)", async () => {
    expect(await count()).toBe(0);
  });
  it("un caso → 1; varios casos → N", async () => {
    await makeCase();
    expect(await count()).toBe(1);
    await makeCase();
    await makeCase(3);
    expect(await count()).toBe(3);
  });
  it("cuenta casos únicos, no reportes: 3 reportes sobre el mismo post siguen siendo 1", async () => {
    await makeCase(3);
    expect(await count()).toBe(1);
    const reports = await one<number>(
      "select count(*)::int r from community_post_reports",
    );
    expect(reports).toBe(3);
  });
  it("no depende de la primera página: 25 casos → 25 (la cola devuelve 20)", async () => {
    for (let i = 0; i < 25; i++) await makeCase();
    expect(await count()).toBe(25);
    const page = await one<{ cases: unknown[]; next: unknown }>(
      "select community_moderation_cases_read($1,'active') r",
      [MOD],
    );
    expect(page.cases).toHaveLength(20);
    expect(page.next).not.toBeNull();
  });
  it("una decisión saca el caso del contador (y un caso cerrado no cuenta)", async () => {
    const a = await makeCase(3);
    await makeCase();
    expect(await count()).toBe(2);
    await db.query(
      "select community_moderation_case_decide($1,$2,$3,$4,$5,'content_actioned','mensaje')",
      [MOD, a.ctx.caseId, a.ctx.cycleId, a.ctx.caseVersion, a.ctx.postVersion],
    );
    expect(await count()).toBe(1);
  });
  it("coincide exactamente con el tamaño de la cola «Activos»", async () => {
    for (let i = 0; i < 7; i++) await makeCase(i % 3 === 0 ? 3 : 1);
    const all = await one<{ cases: unknown[] }>(
      "select community_moderation_cases_read($1,'active') r",
      [MOD],
    );
    expect(await count()).toBe(all.cases.length);
  });
  it("un usuario sin ningún rol privilegiado no puede leerlo", async () => {
    await expect(
      one("select community_moderation_pending_count($1) r", [OUTSIDER]),
    ).rejects.toThrow(/actor_not_moderator/);
  });
  it("un usuario inexistente / sin fila en admin_roles tampoco", async () => {
    await expect(
      one("select community_moderation_pending_count($1) r", [ACTOR]),
    ).rejects.toThrow(/actor_not_moderator/);
  });
  it("solo service_role puede ejecutarla; anon y authenticated no", async () => {
    const priv = await db.query<Record<string, boolean>>(
      `select has_function_privilege('anon','public.community_moderation_pending_count(uuid)','EXECUTE') anon,
              has_function_privilege('authenticated','public.community_moderation_pending_count(uuid)','EXECUTE') authenticated,
              has_function_privilege('service_role','public.community_moderation_pending_count(uuid)','EXECUTE') service_role`,
    );
    expect(priv.rows[0]).toEqual({
      anon: false,
      authenticated: false,
      service_role: true,
    });
  });
  it("la migración solo añade la función (sin tablas ni permisos amplios)", () => {
    const sql = migration("20261031120000_moderation_pending_count.sql");
    expect(sql).not.toMatch(/create table|alter table|drop /i);
    expect(sql.match(/create function/g)).toHaveLength(1);
  });
});
