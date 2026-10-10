// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// R5-I: cadena acumulada 20261029→31 sobre las migraciones previas. (R5-F: SQL REAL (PGlite) de la migración PROPUESTA 20261029120000: los eventos strike_applied /
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

async function decision() {
  const post = uid(1000 + ++seq);
  await db.query(
    "insert into community_posts(id,author_user_id,text,version) values($1,$2,'t',2)",
    [post, AUTHOR],
  );
  let ctx!: Obj;
  for (const r of reporters)
    ctx = await one<Obj>("select community_post_report_submit($1,$2,'spam',null) r", [
      r,
      post,
    ]);
  return { post, ctx };
}
const decide = (ctx: Obj) =>
  one<{ decisionId: string }>(
    "select community_moderation_case_decide($1,$2,$3,$4,$5,'content_actioned','mensaje') r",
    [MOD, ctx.caseId, ctx.cycleId, ctx.caseVersion, ctx.postVersion],
  );

describe("cadena de migraciones 20261029 → 20261031 (SQL real)", () => {
  it("las tres funciones coexisten: una sola firma de cada una y ACL solo service_role/postgres", async () => {
    const names = [
      "community_moderation_cycle_read",
      "community_moderation_cases_read",
      "community_moderation_pending_count",
    ];
    for (const n of names) {
      const r = await db.query<{ c: number }>(
        "select count(*)::int c from pg_proc where proname=$1",
        [n],
      );
      expect(r.rows[0].c, n).toBe(1);
      const acl = await db.query<Record<string, boolean>>(
        `select has_function_privilege('anon', p.oid,'EXECUTE') anon,
                has_function_privilege('authenticated', p.oid,'EXECUTE') authenticated,
                has_function_privilege('service_role', p.oid,'EXECUTE') service_role
           from pg_proc p where proname=$1`,
        [n],
      );
      expect(acl.rows[0].anon, n).toBe(false);
      expect(acl.rows[0].authenticated, n).toBe(false);
      // cycle_read es interna (ni service_role); las otras dos son la frontera del servidor.
      expect(acl.rows[0].service_role, n).toBe(n !== "community_moderation_cycle_read");
    }
  });

  it("flujo integrado: caso → contador → filtro → decisión → strike en la auditoría → contador", async () => {
    const a = await decision();
    const b = await decision();
    expect(
      await one<number>("select community_moderation_pending_count($1) r", [MOD]),
    ).toBe(2);
    const filtered = await one<{ cases: { cycleId: string }[] }>(
      "select community_moderation_cases_read($1,'active',null,null,null,'spam',true) r",
      [MOD],
    );
    expect(filtered.cases).toHaveLength(2); // 3 reportes ⇒ oculta preventivamente
    const d = await decide(a.ctx);
    expect(
      await one<number>("select community_moderation_pending_count($1) r", [MOD]),
    ).toBe(1);
    const closed = await one<{ cases: { cycleId: string }[] }>(
      "select community_moderation_cases_read($1,'closed',null,null,null,'spam') r",
      [MOD],
    );
    expect(closed.cases.map((c) => c.cycleId)).toEqual([a.ctx.cycleId]);
    await one("select community_strike_apply($1,$2,$3,null) r", [
      MOD,
      d.decisionId,
      "motivo",
    ]);
    const detail = await one<{
      item: { audit: { action: string; strikeLevel: number | null }[] };
    }>("select community_moderation_cases_read($1,'closed',null,null,$2) r", [
      MOD,
      a.ctx.cycleId,
    ]);
    expect(
      detail.item.audit.find((x) => x.action === "strike_applied")?.strikeLevel,
    ).toBe(1);
    // El otro caso (B) sigue pendiente y no recibe el evento de strike.
    const other = await one<{ item: { audit: { action: string }[] } }>(
      "select community_moderation_cases_read($1,'active',null,null,$2) r",
      [MOD, b.ctx.cycleId],
    );
    expect(other.item.audit.some((x) => x.action.startsWith("strike_"))).toBe(false);
  });

  it("la llamada antigua de 5 argumentos (backend viejo) sigue válida tras la cadena", async () => {
    await decision();
    const r = await one<{ cases: unknown[] }>(
      "select community_moderation_cases_read($1,'active',null,null,null) r",
      [MOD],
    );
    expect(r.cases).toHaveLength(1);
  });

  it("reaplicar 20261029 (create or replace) es idempotente y no rompe 30/31", async () => {
    await db.exec(migration("20261029120000_moderation_audit_strike_events.sql"));
    await decision();
    expect(
      await one<number>("select community_moderation_pending_count($1) r", [MOD]),
    ).toBe(1);
    const r = await one<{ cases: unknown[] }>(
      "select community_moderation_cases_read($1,'active') r",
      [MOD],
    );
    expect(r.cases).toHaveLength(1);
  });

  it("orden de archivos: 29 < 30 < 31 y todas posteriores a la última definición de cycle_read", () => {
    const files = ["20261022", "20261029", "20261030", "20261031"];
    expect([...files].sort()).toEqual(files);
  });
});
