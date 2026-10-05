// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, afterEach, expect, it } from "vitest";
import {
  atomicSave,
  createAtomicTestDatabase,
  ATTACHMENTS,
  POST,
  type TestDatabase,
} from "./community-atomic-save-test-db";

const migration = (name: string) =>
  readFileSync(resolve("supabase/migrations", name), "utf8");
const sql = migration("20261010120000_moderation_case_foundation.sql");
const actor = "11111111-1111-4111-8111-111111111111";
const post = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const hidden = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const orphan = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let db: TestDatabase;
let beforeReports: unknown[];
let beforeAudit: unknown[];

beforeAll(async () => {
  const modulePath = process.env.UPMINA_TEST_PGLITE_MODULE;
  if (!modulePath)
    throw new Error("Set UPMINA_TEST_PGLITE_MODULE to local PGlite dist/index.js");
  const { PGlite } = await import(/* @vite-ignore */ modulePath);
  db = new PGlite();
  const posts = migration("20261004120000_community_posts_media.sql").match(
    /create table public.community_posts \([\s\S]*?\n\);/,
  )![0];
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create table admin_roles(user_id uuid primary key, role text not null);
    ${posts}
    ${migration("20261007120000_moderation_foundation.sql")}
    ${migration("20261009120000_moderation_workflow_core.sql")}`);
  await db.query("insert into auth.users values ($1);", [actor]);
  await db.query("insert into admin_roles values ($1,'moderator')", [actor]);
  await db.query(
    "insert into community_posts(id,author_user_id,status) values($1,$3,'published'),($2,$3,'hidden')",
    [post, hidden, actor],
  );
  for (const [target, status] of [
    [post, "open"],
    [post, "reviewing"],
    [post, "resolved"],
    [post, "dismissed"],
    [hidden, "resolved"],
    [orphan, "open"],
  ]) {
    await db.query(
      "insert into community_post_reports(reporter_user_id,post_id,reason,status,resolved_by) values($1,$2,'spam',$3,$4)",
      [actor, target, status, ["resolved", "dismissed"].includes(status!) ? actor : null],
    );
  }
  await db.query(
    "insert into moderation_audit_log(actor_user_id,target_type,target_id,action) values($1,'community_post',$2,'post_hidden')",
    [actor, hidden],
  );
  beforeReports = (
    await db.query("select to_jsonb(r) row from community_post_reports r order by id")
  ).rows.map((r) => r.row);
  beforeAudit = (
    await db.query("select to_jsonb(a) row from moderation_audit_log a order by id")
  ).rows.map((r) => r.row);
  await db.exec(sql);
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("begin");
});
afterEach(async () => {
  await db.exec("rollback");
});

it("preserves every historical report field, duplicate and actor audit without invented decisions", async () => {
  const reports = (
    await db.query(
      "select to_jsonb(r) - 'case_id' - 'cycle_id' row from community_post_reports r order by id",
    )
  ).rows.map((r) => r.row);
  expect(reports).toEqual(beforeReports);
  const audit = (
    await db.query(
      "select to_jsonb(a) - 'actor_kind' row from moderation_audit_log a order by id",
    )
  ).rows.map((r) => r.row);
  expect(audit).toEqual(beforeAudit);
  expect((await db.query("select * from community_moderation_decisions")).rows).toEqual(
    [],
  );
  expect(
    (await db.query("select distinct actor_kind from moderation_audit_log")).rows,
  ).toEqual([{ actor_kind: "human" }]);
});
it("backfills one deterministic case/cycle per post including honestly unknown orphan author", async () => {
  const rows = (
    await db.query(
      "select c.*, y.cycle_number, y.closure_kind from community_moderation_cases c join community_moderation_cycles y on y.case_id=c.id order by c.post_id",
    )
  ).rows;
  expect(rows).toHaveLength(3);
  expect(rows.every((r) => r.version === 1 && r.cycle_number === 1)).toBe(true);
  expect(rows[0]).toMatchObject({ status: "pending", target_author_user_id: actor });
  expect(rows[1]).toMatchObject({ status: "closed", closure_kind: "legacy" });
  expect(rows[2]).toMatchObject({
    author_identity: "unavailable",
    target_author_user_id: null,
    status: "pending",
  });
  expect(
    (
      await db.query(
        "select count(*)::int n from community_post_reports r join community_moderation_cycles y on (r.case_id,r.post_id,r.cycle_id)=(y.case_id,y.post_id,y.id)",
      )
    ).rows,
  ).toEqual([{ n: 6 }]);
  expect(rows[0]!.id).toBe(
    (await db.query("select md5('moderation-case:' || $1::text)::uuid id", [post]))
      .rows[0]!.id,
  );
});
it("does not quarantine existing content or three new reports; current moderation RPC still works", async () => {
  for (let i = 0; i < 3; i++)
    await db.query("select * from community_post_report_create($1,$2,'other',null)", [
      `00000000-0000-4000-8000-00000000000${i}`,
      post,
    ]);
  expect((await db.query("select status from community_posts order by id")).rows).toEqual(
    [{ status: "published" }, { status: "hidden" }],
  );
  const report = (
    await db.query(
      "select id from community_post_reports where post_id=$1 and status='open' limit 1",
      [post],
    )
  ).rows[0]!;
  await db.query("select community_moderation_action($1,$2,'hide',1,1,null)", [
    actor,
    report.id,
  ]);
  expect(
    (await db.query("select status from community_posts where id=$1", [post])).rows[0],
  ).toEqual({ status: "hidden" });
});
it("new reports use the existing current cycle or explicit next legacy cycle, preserving duplicates", async () => {
  await db.query("select * from community_post_report_create($1,$2,'spam',null)", [
    actor,
    hidden,
  ]);
  const c = (
    await db.query(
      "select status,current_cycle,version from community_moderation_cases where post_id=$1",
      [hidden],
    )
  ).rows[0];
  expect(c).toEqual({ status: "pending", current_cycle: 2, version: 2 });
  expect(
    (
      await db.query(
        "select cycle_number,status from community_moderation_cycles where post_id=$1 order by cycle_number",
        [hidden],
      )
    ).rows,
  ).toEqual([
    { cycle_number: 1, status: "closed" },
    { cycle_number: 2, status: "pending" },
  ]);
  await db.query("select * from community_post_report_create($1,$2,'spam',null)", [
    actor,
    post,
  ]);
  expect(
    (
      await db.query(
        "select count(*)::int n from community_post_reports where post_id=$1",
        [post],
      )
    ).rows[0],
  ).toEqual({ n: 5 });
});
it("post and account deletion preserve case author, reports and cycles", async () => {
  await db.query("delete from auth.users where id=$1", [actor]);
  expect(
    (await db.query("select count(*)::int n from community_post_reports")).rows[0],
  ).toEqual({ n: 6 });
  expect(
    (
      await db.query(
        "select target_author_user_id from community_moderation_cases where post_id=$1",
        [post],
      )
    ).rows[0],
  ).toEqual({ target_author_user_id: actor });
});
it.each([
  "update moderation_audit_log set metadata='{}'",
  "delete from moderation_audit_log",
  "truncate moderation_audit_log",
])("audit remains immutable: %s", async (statement) => {
  await expect(db.exec(statement)).rejects.toThrow("moderation_audit_log_immutable");
});
it.each([
  "update community_moderation_cases set version=0",
  "insert into community_moderation_cases select * from community_moderation_cases limit 1",
  "update community_moderation_cases set target_author_user_id=null where author_identity='known'",
  "update community_post_reports set post_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'",
  "update community_posts set status='hidden_pending_review'",
  "update moderation_audit_log set actor_kind='system'",
])("rejects invalid invariant: %s", async (statement) => {
  await expect(db.exec(statement)).rejects.toThrow();
});
it("quarantine accepts only attribution to a cycle of this exact post", async () => {
  const cycle = (
    await db.query("select id from community_moderation_cycles where post_id=$1", [post])
  ).rows[0]!.id;
  await db.query(
    "update community_posts set status='hidden_pending_review',quarantine_cycle_id=$2 where id=$1",
    [post, cycle],
  );
  expect(
    (await db.query("select status from community_posts where id=$1", [post])).rows[0],
  ).toEqual({ status: "hidden_pending_review" });
  await expect(
    db.query(
      "update community_posts set status='hidden_pending_review',quarantine_cycle_id=$2 where id=$1",
      [hidden, cycle],
    ),
  ).rejects.toThrow();
});
it.each([
  ["system", null, "post_quarantined", true],
  ["human", actor, "post_hidden", true],
  ["system", actor, "post_quarantined", false],
  ["human", null, "post_hidden", false],
  ["invalid", actor, "post_hidden", false],
  ["system", null, "strike_applied", false],
])("audit actor shape %s/%s/%s", async (kind, id, action, valid) => {
  const promise = db.query(
    "insert into moderation_audit_log(actor_kind,actor_user_id,target_type,target_id,action) values($1,$2,'community_post',$3,$4)",
    [kind, id, post, action],
  );
  if (valid) await promise;
  else await expect(promise).rejects.toThrow();
});
it.each(["update", "delete", "truncate"])("closed cycle cannot %s", async (op) => {
  const statement =
    op === "update"
      ? "update community_moderation_cycles set opened_at=now() where status='closed'"
      : op === "delete"
        ? "delete from community_moderation_cycles where status='closed'"
        : "truncate community_moderation_cycles cascade";
  await expect(db.exec(statement)).rejects.toThrow(
    "community_moderation_history_immutable",
  );
});
it.each(["update", "delete", "truncate"])("decision cannot %s", async (op) => {
  await db.query(
    "update community_moderation_cycles set status='closed',closure_kind='decision',closed_at=now() where post_id=$1",
    [post],
  );
  await db.query(
    "update community_moderation_cases set status='closed',closed_at=now() where post_id=$1",
    [post],
  );
  await db.query(
    "insert into community_moderation_decisions(case_id,post_id,cycle_id,actor_user_id,decision,expected_case_version,resulting_post_status) select case_id,post_id,id,$1,'reports_not_valid',1,'published' from community_moderation_cycles where post_id=$2",
    [actor, post],
  );
  await db.exec("set constraints all immediate");
  const statement =
    op === "update"
      ? "update community_moderation_decisions set decision='content_actioned'"
      : op === "delete"
        ? "delete from community_moderation_decisions"
        : "truncate community_moderation_decisions";
  await expect(db.exec(statement)).rejects.toThrow(
    "community_moderation_history_immutable",
  );
});
it("rejects a decision on a pending cycle at the deferred transaction boundary", async () => {
  await db.query(
    "insert into community_moderation_decisions(case_id,post_id,cycle_id,actor_user_id,decision,expected_case_version) select case_id,post_id,id,$1,'reports_not_valid',1 from community_moderation_cycles where post_id=$2",
    [actor, post],
  );
  await expect(db.exec("set constraints all immediate")).rejects.toThrow(
    "cycle_decision_inconsistent",
  );
});
it("rejects current case/cycle contradictions at the transaction boundary", async () => {
  await db.query(
    "update community_moderation_cases set status='closed',closed_at=now() where post_id=$1",
    [post],
  );
  await expect(db.exec("set constraints all immediate")).rejects.toThrow(
    "case_cycle_state_inconsistent",
  );
});
it("rejects quarantine attribution to a closed legacy cycle", async () => {
  const cycle = (
    await db.query("select id from community_moderation_cycles where post_id=$1", [
      hidden,
    ])
  ).rows[0]!.id;
  await db.query(
    "update community_posts set status='hidden_pending_review',quarantine_cycle_id=$2 where id=$1",
    [hidden, cycle],
  );
  await expect(db.exec("set constraints all immediate")).rejects.toThrow(
    "quarantine_cycle_not_current",
  );
});
it("pins RLS, minimal grants, safe helpers and absence of feature activation", async () => {
  for (const table of [
    "community_moderation_cases",
    "community_moderation_cycles",
    "community_moderation_decisions",
  ]) {
    expect(
      (
        await db.query(
          "select relrowsecurity,relforcerowsecurity from pg_class where relname=$1",
          [table],
        )
      ).rows[0],
    ).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(
        (
          await db.query(
            "select has_table_privilege($1,$2,'SELECT') allowed,has_table_privilege($1,$2,'INSERT,UPDATE,DELETE,TRUNCATE') write",
            [role, table],
          )
        ).rows[0],
      ).toEqual({ allowed: role === "service_role", write: false });
    }
  }
  const helpers = (
    await db.query(
      "select proname,proconfig,pg_get_userbyid(proowner) owner from pg_proc where proname in ('community_report_case_attach','community_moderation_history_immutable')",
    )
  ).rows;
  expect(helpers).toHaveLength(2);
  for (const h of helpers)
    expect(h).toMatchObject({
      proconfig: ["search_path=pg_catalog, public"],
      owner: "postgres",
    });
  for (const role of ["anon", "authenticated", "service_role"])
    expect(
      (
        await db.query(
          "select has_function_privilege($1,'community_report_case_attach()','EXECUTE') allowed",
          [role],
        )
      ).rows[0],
    ).toEqual({ allowed: false });
  expect(
    (await db.query("select to_regclass('community_user_strikes') strikes")).rows[0],
  ).toEqual({ strikes: null });
  expect(sql).not.toMatch(
    /create (?:or replace )?function public\.community_moderation_action/,
  );
});

it("enforces post uniqueness independently of case primary key", async () => {
  await expect(
    db.query(
      "insert into community_moderation_cases(post_id,target_author_user_id,author_identity,status) values($1,$2,'known','pending')",
      [post, actor],
    ),
  ).rejects.toThrow(/post_id_key/);
});
it.each(["anon", "authenticated"])(
  "%s cannot read new moderation history directly",
  async (role) => {
    await db.exec(`set local role ${role}`);
    await expect(db.exec("select * from community_moderation_cases")).rejects.toThrow(
      /permission denied/,
    );
  },
);
it("service RPC still creates a linked report for a newly created post", async () => {
  const fresh = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await db.query("insert into community_posts(id,author_user_id) values($1,$2)", [
    fresh,
    actor,
  ]);
  await db.exec("set local role service_role");
  await db.query("select * from community_post_report_create($1,$2,'other',null)", [
    actor,
    fresh,
  ]);
  await db.exec("reset role; set constraints all immediate");
  expect(
    (
      await db.query(
        "select c.status,c.target_author_user_id,y.cycle_number from community_moderation_cases c join community_moderation_cycles y on y.case_id=c.id where c.post_id=$1",
        [fresh],
      )
    ).rows[0],
  ).toEqual({ status: "pending", target_author_user_id: actor, cycle_number: 1 });
});
it("R1 preserves legacy restore/dismiss and stale conflicts without grouped decisions", async () => {
  const report = (
    await db.query(
      "select id from community_post_reports where post_id=$1 and status='open' limit 1",
      [post],
    )
  ).rows[0]!.id;
  await db.query("select community_moderation_action($1,$2,'hide',1,1,null)", [
    actor,
    report,
  ]);
  await db.query("select community_moderation_action($1,$2,'restore',2,2,null)", [
    actor,
    report,
  ]);
  await db.exec("savepoint stale");
  await expect(
    db.query("select community_moderation_action($1,$2,'hide',1,1,null)", [
      actor,
      report,
    ]),
  ).rejects.toThrow("report_version_conflict");
  await db.exec("rollback to savepoint stale; release savepoint stale");
  const other = (
    await db.query(
      "select id from community_post_reports where post_id=$1 and status='reviewing'",
      [post],
    )
  ).rows[0]!.id;
  await db.query("select community_moderation_action($1,$2,'dismiss',1,3,null)", [
    actor,
    other,
  ]);
  await db.exec("set constraints all immediate");
  expect(
    (await db.query("select status,version from community_posts where id=$1", [post]))
      .rows[0],
  ).toEqual({ status: "published", version: 3 });
  expect((await db.query("select * from community_moderation_decisions")).rows).toEqual(
    [],
  );
});

it("applies transactionally on the real 9J atomic save contract without changing removal semantics", async () => {
  const atomicDb = await createAtomicTestDatabase();
  try {
    await atomicDb.exec(`create table admin_roles(user_id uuid primary key,role text not null);
      ${migration("20261007120000_moderation_foundation.sql")}
      ${migration("20261009120000_moderation_workflow_core.sql")}`);
    await atomicDb.exec(`begin; ${sql} commit;`);
    const result = await atomicSave(atomicDb, [0, 2], [ATTACHMENTS[1]]);
    expect(result.post).toMatchObject({ id: POST, version: 3 });
    expect(result.media).toHaveLength(2);
    expect(result.cleanup_asset_ids).toHaveLength(1);
    expect(
      (
        await atomicDb.query(
          "select status,quarantine_cycle_id from community_posts where id=$1",
          [POST],
        )
      ).rows[0],
    ).toEqual({ status: "published", quarantine_cycle_id: null });
  } finally {
    await atomicDb.close();
  }
});
