// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import {
  createAtomicTestDatabase,
  ACTOR,
  POST,
  type TestDatabase,
} from "./community-atomic-save-test-db";

const migration = (name: string) =>
  readFileSync(resolve("supabase/migrations", name), "utf8");
const FIX = "20261016120000_community_controlled_write_boundary.sql";
const reporters = [1, 2, 3].map(
  (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`,
);
let db: TestDatabase;
beforeAll(async () => {
  db = await createAtomicTestDatabase();
  await db.exec(`create table admin_roles(user_id uuid primary key,role text);
    alter table profiles add column username text;
    alter table media_assets add column storage_key text,add column width int,add column height int,add column duration_seconds numeric;
    alter role service_role bypassrls;`);
  // The reduced 9J bootstrap extracts table definitions, not the historical ACL/RLS.
  // Execute the actual scoped historical statements, rather than approximating their grants.
  const foundation = migration("20261004120000_community_posts_media.sql");
  const acl = foundation.match(
    /(?:alter table public\.community_(?:posts|post_media) (?:enable|force) row level security|revoke[^;]*on table public\.community_(?:posts|post_media)[^;]*|grant[^;]*on table public\.community_(?:posts|post_media)[^;]*);/g,
  )!;
  await db.exec(acl.join("\n"));
  for (const name of [
    "20261007120000_moderation_foundation.sql",
    "20261009120000_moderation_workflow_core.sql",
    "20261010120000_moderation_case_foundation.sql",
    "20261011120000_community_report_submission.sql",
    "20261012120000_community_report_submission_account_race_fix.sql",
    "20261013120000_moderation_case_read_model.sql",
    "20261014120000_moderation_case_media_references.sql",
    "20261015120000_moderation_grouped_decision_core.sql",
  ])
    await db.exec(migration(name));
  const deletion = foundation.match(
    /create or replace function public\.community_post_delete\([\s\S]*?\n\$\$;/,
  )![0];
  await db.exec(deletion);
  await db.exec(
    "alter function community_post_delete(uuid,uuid,integer) owner to postgres; revoke all on function community_post_delete(uuid,uuid,integer) from public,anon,authenticated; grant execute on function community_post_delete(uuid,uuid,integer) to service_role;",
  );
  await db.query("insert into admin_roles values($1,'moderator')", [ACTOR]);
  for (const id of reporters) await db.query("insert into auth.users values($1)", [id]);
  expect(
    (await db.query("select rolbypassrls from pg_roles where rolname='service_role'"))
      .rows[0],
  ).toEqual({ rolbypassrls: true });
  expect(
    (
      await db.query(
        "select has_table_privilege('service_role','community_posts','UPDATE') post,has_table_privilege('service_role','community_post_media','DELETE') media",
      )
    ).rows[0],
  ).toEqual({ post: true, media: true });
  // Reproduce the exact defect before applying the forward correction, then discard it.
  await db.exec("begin");
  const removed = await decide();
  await db.query("update community_posts set text='Direct bypass' where id=$1", [POST]);
  await db.query("delete from community_post_media where post_id=$1", [POST]);
  expect(
    (
      await db.query("select text,status,version from community_posts where id=$1", [
        POST,
      ])
    ).rows[0],
  ).toEqual({
    text: "Direct bypass",
    status: "removed_pending_purge",
    version: removed.postVersion,
  });
  expect(
    (await db.query("select count(*)::int n from community_post_media")).rows[0],
  ).toEqual({ n: 0 });
  await db.exec("reset role; rollback");
  // Independent column grants must be closed even when the table-level grant is revoked.
  await db.exec(
    "grant update(text) on community_posts to public; grant insert(post_id),update(position),references(asset_id) on community_post_media to anon,authenticated,service_role;",
  );
  const baseline = await snapshot();
  await db.exec(migration(FIX));
  expect(await snapshot()).toEqual(baseline);
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("begin");
});
afterEach(async () => {
  await db.exec("reset role; rollback");
});
async function snapshot() {
  return (
    await db.query(`select jsonb_build_object(
  'p',(select jsonb_agg(p order by id) from community_posts p),
  'm',(select jsonb_agg(m order by id) from community_post_media m),
  'a',(select jsonb_agg(a order by id) from media_assets a),
  'r',(select jsonb_agg(r order by id) from community_post_reports r),
  'd',(select jsonb_agg(d order by id) from community_moderation_decisions d),
  'c',(select jsonb_agg(c order by id) from community_moderation_cases c),
  'y',(select jsonb_agg(y order by id) from community_moderation_cycles y),
  'audit',(select jsonb_agg(a order by id) from moderation_audit_log a)) s`)
  ).rows;
}
async function reject(sql: string, params: unknown[] = [], error = "permission denied") {
  await db.exec("reset role");
  const before = await snapshot();
  await db.exec("savepoint denied; set role service_role");
  await expect(db.query(sql, params)).rejects.toThrow(error);
  await db.exec("rollback to savepoint denied; reset role");
  expect(await snapshot()).toEqual(before);
}
async function fixture(n = 1) {
  await db.exec("set role service_role");
  let c!: { caseId: string; cycleId: string; caseVersion: number; postVersion: number };
  for (let i = 0; i < n; i++)
    c = (
      await db.query<{ r: typeof c }>(
        "select community_post_report_submit($1,$2,'spam',null) r",
        [reporters[i], POST],
      )
    ).rows[0]!.r;
  return c;
}
async function decide(n = 1, decision = "content_actioned") {
  const c = await fixture(n);
  return (
    await db.query<{ r: { postVersion: number; postStatus: string } }>(
      "select community_moderation_case_decide($1,$2,$3,$4,$5,$6,$7) r",
      [
        ACTOR,
        c.caseId,
        c.cycleId,
        c.caseVersion,
        c.postVersion,
        decision,
        decision === "content_actioned" ? "Reason" : null,
      ],
    )
  ).rows[0]!.r;
}
it.each([
  "update community_posts set text='bypass'",
  "update community_posts set status='hidden',removal_decision_id=null,removed_at=null,purge_after=null",
  "update community_posts set version=99",
  "delete from community_posts",
  "insert into community_posts(author_user_id,text) values('33333333-3333-4333-8333-333333333333','bypass')",
  "delete from community_post_media",
  "update community_post_media set position=99",
  "insert into community_post_media(post_id,asset_id,position) values('24655b41-1bc7-487c-834e-d1715a596e9e','00000000-0000-4000-8000-000000000004',3)",
  "truncate community_post_media",
  "truncate community_posts cascade",
])("service_role BYPASSRLS cannot directly mutate protected state: %s", async (sql) => {
  await decide();
  await reject(sql);
});
it("all API roles lack table and column mutation privileges but service reads remain", async () => {
  for (const role of ["anon", "authenticated", "service_role"])
    for (const table of ["community_posts", "community_post_media"]) {
      for (const privilege of [
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "TRIGGER",
        "REFERENCES",
      ])
        expect(
          (
            await db.query("select has_table_privilege($1,$2,$3) allowed", [
              role,
              table,
              privilege,
            ])
          ).rows[0],
        ).toEqual({ allowed: false });
      for (const privilege of ["INSERT", "UPDATE", "REFERENCES"])
        expect(
          (
            await db.query("select has_any_column_privilege($1,$2,$3) allowed", [
              role,
              table,
              privilege,
            ])
          ).rows[0],
        ).toEqual({ allowed: false });
    }
  for (const table of ["community_posts", "community_post_media"])
    expect(
      (
        await db.query("select has_table_privilege('service_role',$1,'SELECT') allowed", [
          table,
        ])
      ).rows[0],
    ).toEqual({ allowed: true });
});
it("published create/edit/atomic/reorder/detach/delete work as service_role exclusively via definers", async () => {
  const media = (
    await db.query<{ id: string; asset_id: string }>(
      "select id,asset_id from community_post_media order by position",
    )
  ).rows;
  const gallery = JSON.stringify(
    media.map((m, position) => ({ asset_id: m.asset_id, position })),
  );
  await db.exec("set role service_role");
  await db.query("select community_post_save($1,$2,2,'Edited',$3::jsonb)", [
    ACTOR,
    POST,
    gallery,
  ]);
  await db.query(
    "select community_post_save_atomic($1,$2,3,'Atomic',$3::jsonb,'{}'::uuid[])",
    [ACTOR, POST, gallery],
  );
  await db.query("select community_post_reorder_media($1,$2,4,$3::jsonb)", [
    ACTOR,
    POST,
    JSON.stringify(
      media.map((m, position) => ({ media_id: m.id, position: 2 - position })),
    ),
  ]);
  await db.query("select community_post_detach_media($1,$2,5,$3)", [
    ACTOR,
    POST,
    media[0]!.id,
  ]);
  await db.query("select community_post_delete($1,$2,6)", [ACTOR, POST]);
  await db.query("select community_post_save($1,null,null,'Created','[]'::jsonb)", [
    ACTOR,
  ]);
  await db.exec("set constraints all immediate");
  expect(
    (await db.query("select text,status,version from community_posts")).rows,
  ).toEqual([{ text: "Created", status: "published", version: 1 }]);
});
it.each([1, 3])(
  "No procede with %i reports/quarantine works as service_role",
  async (n) => {
    expect(await decide(n, "reports_not_valid")).toMatchObject({
      postStatus: "published",
      postVersion: n === 3 ? 4 : 2,
    });
    await db.exec("set constraints all immediate; reset role");
    expect(
      (await db.query("select count(*)::int n from community_moderation_author_notices"))
        .rows[0],
    ).toEqual({ n: 1 });
  },
);
it.each(["hidden", "hidden_pending_review", "removed_pending_purge"])(
  "all controlled guards reject %s; own delete still works",
  async (state) => {
    let version = 2;
    if (state === "hidden") await db.exec("update community_posts set status='hidden'");
    if (state === "hidden_pending_review") version = (await fixture(3)).postVersion;
    if (state === "removed_pending_purge") version = (await decide()).postVersion;
    for (const sql of [
      "select community_post_save($1,$2,99,'Edited','[]'::jsonb)",
      "select community_post_save_atomic($1,$2,99,'Edited','[]'::jsonb,'{}'::uuid[])",
      "select community_post_reorder_media($1,$2,99,'[]'::jsonb)",
      "select community_post_detach_media($1,$2,99,'11111111-1111-4111-8111-000000000001')",
    ])
      await reject(sql, [ACTOR, POST], "post_not_editable");
    await db.exec("set role service_role");
    await db.query("select community_post_delete($1,$2,$3)", [ACTOR, POST, version]);
    await db.exec("set constraints all immediate");
    expect(
      (await db.query("select count(*)::int n from community_posts")).rows[0],
    ).toEqual({ n: 0 });
  },
);
it("old individual RPC/report DML remain closed; controlled functions remain postgres definers", async () => {
  for (const sql of [
    "select community_moderation_action($1,$2,'hide',1,2,null)",
    "select community_post_report_set_status($1,$2,'dismissed',null)",
  ])
    await reject(sql, [ACTOR, POST]);
  await reject("update community_post_reports set status='reviewing'");
  await reject(
    "insert into community_post_reports(reporter_user_id,post_id,reason) values($1,$2,'spam')",
    [ACTOR, POST],
  );
  const rows = (
    await db.query<{
      name: string;
      owner: string;
      prosecdef: boolean;
      proconfig: string[];
    }>(
      "select proname name,pg_get_userbyid(proowner) owner,prosecdef,proconfig from pg_proc where proname in ('community_post_save','community_post_save_atomic','community_post_reorder_media','community_post_detach_media','community_post_delete','community_post_report_submit','community_moderation_case_decide')",
    )
  ).rows;
  expect(rows).toHaveLength(7);
  for (const row of rows) {
    expect(row.owner).toBe("postgres");
    expect(row.prosecdef).toBe(true);
    expect(row.proconfig).toContain("search_path=pg_catalog, public");
  }
});
