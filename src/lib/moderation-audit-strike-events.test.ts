// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// R5-F: SQL REAL (PGlite) de la migración PROPUESTA 20261029120000: los eventos strike_applied /
// strike_revoked aparecen en la auditoría del detalle del caso, solo los del MISMO caso y ciclo, con
// el nivel como único dato extra y sin ampliar permisos ni el límite de 20 eventos.

const migration = (n: string) =>
  readFileSync(`supabase/migrations/${n}`, "utf8").replace(/\r\n/g, "\n");
const uid = (n: number) => `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MOD = uid(1);
const DEV = uid(3);
const reporters = [11, 12, 13].map(uid);
const AUTHOR = ACTOR;
const REASON = "Motivo humano del strike con datos privados.";
let db: TestDatabase;
let seq = 0;
interface Obj {
  [key: string]: unknown;
}
interface AuditItem {
  id: string;
  action: string;
  actorKind: string;
  createdAt: string;
  states: Obj;
  strikeLevel: number | null;
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
  const d = await one<{ decisionId: string }>(
    "select community_moderation_case_decide($1,$2,$3,$4,$5,'content_actioned','mensaje') r",
    [MOD, ctx.caseId, ctx.cycleId, ctx.caseVersion, ctx.postVersion],
  );
  return {
    post,
    caseId: ctx.caseId as string,
    cycleId: ctx.cycleId as string,
    decisionId: d.decisionId,
  };
}
const applyStrike = (decisionId: string) =>
  one<{ strikeId: string }>("select community_strike_apply($1,$2,$3,null) r", [
    MOD,
    decisionId,
    REASON,
  ]);
const revokeStrike = (strikeId: string) =>
  one("select community_strike_revoke($1,$2,'error mío') r", [DEV, strikeId]);
const readAudit = async (cycleId: string, detail = true) =>
  (
    await one<{ audit: AuditItem[] }>("select community_moderation_cycle_read($1,$2) r", [
      cycleId,
      detail,
    ])
  ).audit;

describe("auditoría del caso con eventos de strike (SQL real)", () => {
  it("strike_applied aparece con su nivel, como acción humana del mismo ciclo", async () => {
    const d = await decision();
    await applyStrike(d.decisionId);
    const audit = await readAudit(d.cycleId);
    const applied = audit.filter((a) => a.action === "strike_applied");
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ actorKind: "human", strikeLevel: 1 });
    // Los eventos previos del caso siguen presentes y sin nivel.
    expect(audit.some((a) => a.action === "content_actioned")).toBe(true);
    for (const a of audit.filter((x) => !x.action.startsWith("strike_")))
      expect(a.strikeLevel).toBeNull();
  });

  it("aplicar y revocar dejan los dos eventos, el más reciente primero, ambos con el nivel", async () => {
    const d = await decision();
    const s = await applyStrike(d.decisionId);
    await revokeStrike(s.strikeId);
    const audit = await readAudit(d.cycleId);
    const strikes = audit.filter((a) => a.action.startsWith("strike_"));
    expect(strikes.map((a) => a.action)).toEqual(["strike_revoked", "strike_applied"]);
    expect(strikes.map((a) => a.strikeLevel)).toEqual([1, 1]);
    const times = audit.map((a) => Date.parse(a.createdAt));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });

  it("un strike de OTRO caso (mismo autor, otro ciclo) no aparece en este caso", async () => {
    const a = await decision();
    const b = await decision();
    await applyStrike(a.decisionId);
    await applyStrike(b.decisionId); // segundo strike del mismo autor: nivel 2
    const auditA = await readAudit(a.cycleId);
    const auditB = await readAudit(b.cycleId);
    expect(auditA.filter((x) => x.action === "strike_applied")).toMatchObject([
      { strikeLevel: 1 },
    ]);
    expect(auditB.filter((x) => x.action === "strike_applied")).toMatchObject([
      { strikeLevel: 2 },
    ]);
  });

  it("la proyección solo añade el nivel: ni motivo, ni ids de usuario, ni metadatos del evento", async () => {
    const d = await decision();
    const s = await applyStrike(d.decisionId);
    await revokeStrike(s.strikeId);
    const dump = JSON.stringify(await readAudit(d.cycleId));
    for (const leak of [
      REASON,
      "error mío",
      MOD,
      DEV,
      AUTHOR,
      ...reporters,
      "applied_by",
    ])
      expect(dump).not.toContain(leak);
    for (const item of await readAudit(d.cycleId))
      expect(Object.keys(item).sort()).toEqual(
        ["action", "actorKind", "createdAt", "id", "states", "strikeLevel"].sort(),
      );
  });

  it("conserva el límite de 20 eventos y la lectura sin detalle sigue sin auditoría", async () => {
    const d = await decision();
    for (let i = 0; i < 25; i++)
      await db.query(
        `insert into moderation_audit_log(actor_kind,actor_user_id,target_type,target_id,action,created_at)
         values('human',$1,'community_post',$2,'post_hidden', now() - make_interval(secs => $3))`,
        [MOD, d.post, 100 + i],
      );
    await applyStrike(d.decisionId);
    const audit = await readAudit(d.cycleId);
    expect(audit).toHaveLength(20);
    expect(audit[0].action).toBe("strike_applied"); // lo más reciente entra aunque haya 25 antiguos
    expect(await readAudit(d.cycleId, false)).toEqual([]);
  });

  it("no cambia permisos: sigue sin ser ejecutable por anon, authenticated ni service_role", async () => {
    const d = await decision();
    for (const role of ["anon", "authenticated", "service_role"]) {
      await db.exec("savepoint s1");
      let failed = false;
      try {
        await db.exec(
          `set role ${role}; select community_moderation_cycle_read('${d.cycleId}', true)`,
        );
      } catch {
        failed = true;
      }
      await db.exec("rollback to savepoint s1");
      await db.exec("reset role");
      expect(failed, `rol ${role}`).toBe(true);
    }
  });

  it("la migración solo redefine la lectura (sin tablas, sin nuevos permisos)", () => {
    const sql = migration("20261029120000_moderation_audit_strike_events.sql");
    expect(sql).not.toMatch(/create table|alter table|grant /i);
    expect(sql.match(/create or replace function/g)).toHaveLength(1);
    expect(sql).toMatch(
      /revoke all on function public\.community_moderation_cycle_read\(uuid, boolean\) from public, anon, authenticated, service_role/,
    );
  });
});
