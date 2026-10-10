// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// R5-J: rollback de la cadena 20261029→31 sobre las migraciones previas. (R5-F: SQL REAL (PGlite) de la migración PROPUESTA 20261029120000: los eventos strike_applied /
// strike_revoked aparecen en la auditoría del detalle del caso, solo los del MISMO caso y ciclo, con
// el nivel como único dato extra y sin ampliar permisos ni el límite de 20 eventos.

const migration = (n: string) =>
  readFileSync(`supabase/migrations/${n}`, "utf8").replace(/\r\n/g, "\n");
const uid = (n: number) => `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MOD = uid(1);
const DEV = uid(3);
const reporters = [11, 12, 13].map(uid);
const AUTHOR = ACTOR;
let db: TestDatabase;
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
    "20261023120000_community_strikes_foundation.sql",
    "20261024120000_community_strike_write_enforcement.sql",
    "20261029120000_moderation_audit_strike_events.sql",
    "20261030120000_moderation_queue_filters.sql",
    "20261031120000_moderation_pending_count.sql",
  ])
    await db.exec(migration(n));
  await db.query("insert into admin_roles values($1,'moderator'),($2,'developer')", [
    MOD,
    DEV,
  ]);
  for (const id of [MOD, DEV, ...reporters])
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
    /* transacción abortada: el rollback la limpia */
  }
  await db.exec("rollback");
});

const rollback = () =>
  readFileSync("docs/9K-R5J-rollback.sql", "utf8")
    .split(String.fromCharCode(13, 10))
    .join("\n");
const md5 = async (fn: string) =>
  (
    await db.query<{ m: string }>(
      "select md5(prosrc) m from pg_proc where proname=$1 order by pronargs desc limit 1",
      [fn],
    )
  ).rows[0].m;

describe("rollback R5-J (SQL real)", () => {
  it("restaura exactamente las definiciones de DEV previas a 29–31 (md5 de prosrc)", async () => {
    const before29 = await md5("community_moderation_cycle_read");
    expect(before29).not.toBe("d9e18810bfdba74530bac73266c3cb1e");
    await db.exec(rollback());
    expect(await md5("community_moderation_cycle_read")).toBe(
      "d9e18810bfdba74530bac73266c3cb1e",
    );
    expect(await md5("community_moderation_cases_read")).toBe(
      "7305cbd15cb95e901193646a05477806",
    );
    const n = await db.query<{ c: number }>(
      "select count(*)::int c from pg_proc where proname in ('community_moderation_pending_count') or (proname='community_moderation_cases_read' and pronargs <> 5)",
    );
    expect(n.rows[0].c).toBe(0);
  });
  it("tras el rollback la cola antigua funciona y los permisos son los de antes", async () => {
    await db.exec(rollback());
    const post = uid(5000);
    await db.query(
      "insert into community_posts(id,author_user_id,text,version) values($1,$2,'t',2)",
      [post, AUTHOR],
    );
    for (const r of reporters)
      await one("select community_post_report_submit($1,$2,'spam',null) r", [r, post]);
    const page = await one<{ cases: unknown[] }>(
      "select community_moderation_cases_read($1,'active',null,null,null) r",
      [MOD],
    );
    expect(page.cases).toHaveLength(1);
    const acl = await db.query<Record<string, boolean>>(
      `select has_function_privilege('anon', p.oid,'EXECUTE') anon,
              has_function_privilege('authenticated', p.oid,'EXECUTE') authenticated,
              has_function_privilege('service_role', p.oid,'EXECUTE') service_role
         from pg_proc p where proname='community_moderation_cases_read'`,
    );
    expect(acl.rows[0]).toEqual({
      anon: false,
      authenticated: false,
      service_role: true,
    });
    // Los filtros ya no existen (backend viejo ⇒ no los envía).
    await expect(
      one("select community_moderation_cases_read($1,'active',null,null,null,'spam') r", [
        MOD,
      ]),
    ).rejects.toThrow();
  });
  it("es idempotente y transaccional: puede ejecutarse dos veces", async () => {
    await db.exec(rollback());
    await db.exec(rollback());
    expect(await md5("community_moderation_cases_read")).toBe(
      "7305cbd15cb95e901193646a05477806",
    );
  });
});
