// @vitest-environment node
// Real embedded SQL behavior; independent-connection races require authorized Testing.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import {
  ACTOR,
  POST,
  ASSETS,
  ATTACHMENTS,
  atomicSave,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

const migration = (name: string) =>
  readFileSync(resolve("supabase/migrations", name), "utf8");
const sql = migration("20261011120000_community_report_submission.sql");
const accountFixSql = migration(
  "20261012120000_community_report_submission_account_race_fix.sql",
);
const reporters = [1, 2, 3, 4].map(
  (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`,
);
let db: TestDatabase;
const submit = async (
  actor = reporters[0],
  reason = "spam",
  detail: string | null = null,
) =>
  (
    await db.query<{ result: Record<string, unknown> }>(
      "select community_post_report_submit($1,$2,$3,$4) result",
      [actor, POST, reason, detail],
    )
  ).rows[0]!.result;
const snapshot = async () =>
  (
    await db.query(
      "select to_jsonb(p) post, (select jsonb_agg(m order by id) from community_post_media m) media from community_posts p where id=$1",
      [POST],
    )
  ).rows;
async function rejectWithoutChange(operation: () => Promise<unknown>, message: string) {
  const before = await snapshot();
  await db.exec("savepoint rejected_operation");
  await expect(operation()).rejects.toThrow(message);
  await db.exec("rollback to savepoint rejected_operation");
  expect(await snapshot()).toEqual(before);
}
beforeAll(async () => {
  db = await createAtomicTestDatabase();
  await db.exec("create table admin_roles(user_id uuid primary key,role text not null)");
  const base = migration("20261004120000_community_posts_media.sql");
  for (const name of [
    "community_post_reorder_media",
    "community_post_detach_media",
    "community_post_delete",
  ])
    await db.exec(
      base.match(
        new RegExp(`create or replace function public.${name}\\([\\s\\S]*?\\n\\$\\$;`),
      )![0],
    );
  await db.exec(migration("20261007120000_moderation_foundation.sql"));
  await db.exec(migration("20261009120000_moderation_workflow_core.sql"));
  await db.exec(migration("20261010120000_moderation_case_foundation.sql"));
  await db.exec(sql);
  await db.exec(accountFixSql);
  for (const reporter of reporters)
    await db.query("insert into auth.users values($1)", [reporter]);
  await db.query("insert into admin_roles values($1,'moderator')", [ACTOR]);
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

it("1/2/3/4 distinct reporters: one preventive transition, one system audit, coherent versions", async () => {
  for (let i = 0; i < 4; i++) {
    const result = await submit(reporters[i]);
    expect(result).toMatchObject({
      distinctReporterCount: i + 1,
      caseVersion: i + 2,
      alreadyReported: false,
      visibilityChanged: i === 2,
      postStatus: i < 2 ? "published" : "hidden_pending_review",
      postVersion: i < 2 ? 2 : 3,
    });
    expect(JSON.stringify(result)).not.toContain(reporters[i]);
  }
  await db.exec("set constraints all immediate");
  const audits = (await db.query("select * from moderation_audit_log")).rows;
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    actor_kind: "system",
    actor_user_id: null,
    action: "post_quarantined",
  });
  expect(JSON.stringify(audits[0]!.metadata)).not.toContain(reporters[0]);
  expect(
    (await db.query("select * from community_moderation_decisions")).rows,
  ).toHaveLength(0);
});
it.each([1, 3, 4])(
  "duplicate at %i accepted reports returns existing context without mutation",
  async (count) => {
    for (let i = 0; i < count; i++) await submit(reporters[i]);
    const before = await snapshot();
    const duplicate = await submit();
    expect(duplicate).toMatchObject({
      alreadyReported: true,
      visibilityChanged: false,
      caseVersion: count + 1,
      distinctReporterCount: count,
    });
    expect(await snapshot()).toEqual(before);
    expect((await db.query("select * from community_post_reports")).rows).toHaveLength(
      count,
    );
  },
);
it.each([
  [ACTOR, "spam", null, "self_report"],
  ["ffffffff-ffff-4fff-8fff-ffffffffffff", "spam", null, "unauthenticated"],
  [reporters[0], "invalid", null, "invalid_reason"],
  [reporters[0], "spam", "x".repeat(1001), "detail_too_long"],
])(
  "rejects invalid submission before case creation (%s)",
  async (actor, reason, detail, error) => {
    await rejectWithoutChange(() => submit(actor!, reason!, detail), error!);
    expect(
      (await db.query("select * from community_moderation_cases")).rows,
    ).toHaveLength(0);
  },
);
it("hidden target cannot open a case", async () => {
  await db.query("update community_posts set status='hidden' where id=$1", [POST]);
  await rejectWithoutChange(() => submit(), "post_not_reportable");
  expect((await db.query("select * from community_moderation_cases")).rows).toHaveLength(
    0,
  );
});
it("missing/deleted target rejects without creating history", async () => {
  await db.query("select community_post_delete($1,$2,2)", [ACTOR, POST]);
  await expect(submit()).rejects.toThrow("post_not_found");
});
it("audit failure rolls back third report, versions and quarantine", async () => {
  await submit(reporters[0]);
  await submit(reporters[1]);
  await db.exec(
    "create function pg_temp.fail_audit() returns trigger language plpgsql as $$ begin raise exception 'synthetic_audit_failure'; end $$; create trigger synthetic_failure before insert on moderation_audit_log for each row execute function pg_temp.fail_audit()",
  );
  await rejectWithoutChange(() => submit(reporters[2]), "synthetic_audit_failure");
  expect((await db.query("select version from community_moderation_cases")).rows).toEqual(
    [{ version: 3 }],
  );
  expect((await db.query("select * from community_post_reports")).rows).toHaveLength(2);
});
it("invalid deferred quarantine context rolls back submission", async () => {
  await submit(reporters[0]);
  await submit(reporters[1]);
  const before = await snapshot();
  await db.exec("savepoint invalid_context");
  await submit(reporters[2]);
  await db.exec("update community_moderation_cases set current_cycle=99");
  await expect(db.exec("set constraints all immediate")).rejects.toThrow();
  await db.exec("rollback to savepoint invalid_context");
  expect(await snapshot()).toEqual(before);
  expect((await db.query("select * from moderation_audit_log")).rows).toHaveLength(0);
});
it.each(["ordinary", "atomic", "reorder", "detach"])(
  "HPR blocks %s edit before media mutation",
  async (operation) => {
    for (let i = 0; i < 3; i++) await submit(reporters[i]);
    await rejectWithoutChange(() => {
      if (operation === "atomic") return atomicSave(db, [0, 1], [ATTACHMENTS[2]], 3);
      if (operation === "ordinary")
        return db.query("select community_post_save($1,$2,3,'Changed',$3::jsonb)", [
          ACTOR,
          POST,
          JSON.stringify(
            ASSETS.slice(0, 3).map((asset_id, position) => ({ asset_id, position })),
          ),
        ]);
      if (operation === "reorder")
        return db.query("select community_post_reorder_media($1,$2,3,$3::jsonb)", [
          ACTOR,
          POST,
          JSON.stringify(
            ATTACHMENTS.map((media_id, position) => ({ media_id, position })),
          ),
        ]);
      return db.query("select community_post_detach_media($1,$2,3,$3)", [
        ACTOR,
        POST,
        ATTACHMENTS[0],
      ]);
    }, "post_not_editable");
  },
);
it("own HPR delete preserves case/cycle/reports/audit", async () => {
  for (let i = 0; i < 3; i++) await submit(reporters[i]);
  await db.query("select community_post_delete($1,$2,3)", [ACTOR, POST]);
  await db.exec("set constraints all immediate");
  expect((await db.query("select * from community_posts")).rows).toHaveLength(0);
  for (const [table, count] of [
    ["community_moderation_cases", 1],
    ["community_moderation_cycles", 1],
    ["community_post_reports", 3],
    ["moderation_audit_log", 1],
  ] as const)
    expect((await db.query(`select * from ${table}`)).rows).toHaveLength(count);
});
it("old moderator hide wins before third report: submission rejects, no quarantine", async () => {
  const first = await submit(reporters[0]);
  await submit(reporters[1]);
  await db.query("select community_moderation_action($1,$2,'hide',1,2,null)", [
    ACTOR,
    first.reportId,
  ]);
  await rejectWithoutChange(() => submit(reporters[2]), "post_not_reportable");
  expect((await db.query("select action from moderation_audit_log")).rows).toEqual([
    { action: "post_hidden" },
  ]);
});
it("quarantine wins before stale hide: old action cannot overwrite HPR", async () => {
  const first = await submit(reporters[0]);
  await submit(reporters[1]);
  await submit(reporters[2]);
  await rejectWithoutChange(
    () =>
      db.query("select community_moderation_action($1,$2,'hide',1,2,null)", [
        ACTOR,
        first.reportId,
      ]),
    "version_conflict",
  );
});
it("retired direct writers and browser roles have no execution/insert privilege", async () => {
  for (const role of ["anon", "authenticated", "service_role"]) {
    expect(
      (
        await db.query(
          "select has_function_privilege($1,'community_post_report_create(uuid,uuid,text,text)','EXECUTE') allowed",
          [role],
        )
      ).rows,
    ).toEqual([{ allowed: false }]);
    expect(
      (
        await db.query(
          "select has_table_privilege($1,'community_post_reports','INSERT') allowed",
          [role],
        )
      ).rows,
    ).toEqual([{ allowed: false }]);
    expect(
      (
        await db.query(
          "select has_function_privilege($1,'community_post_report_submit(uuid,uuid,text,text)','EXECUTE') allowed",
          [role],
        )
      ).rows,
    ).toEqual([{ allowed: role === "service_role" }]);
  }
});
it("closed legacy cycle opens a new cycle only for published content, preserving old history", async () => {
  const first = await submit();
  await db.query(
    "update community_post_reports set status='dismissed',resolved_by=$1 where id=$2",
    [ACTOR, first.reportId],
  );
  await db.exec(
    "update community_moderation_cycles set status='closed',closure_kind='legacy',closed_at=now(); update community_moderation_cases set status='closed',closed_at=now()",
  );
  await db.exec("set constraints all immediate; set constraints all deferred");
  const next = await submit();
  expect(next).toMatchObject({
    alreadyReported: false,
    distinctReporterCount: 1,
    caseVersion: 3,
    visibilityChanged: false,
  });
  expect(next.cycleId).not.toBe(first.cycleId);
  expect(
    (
      await db.query(
        "select cycle_number,status,closure_kind from community_moderation_cycles order by cycle_number",
      )
    ).rows,
  ).toEqual([
    { cycle_number: 1, status: "closed", closure_kind: "legacy" },
    { cycle_number: 2, status: "pending", closure_kind: null },
  ]);
  await db.exec("set constraints all immediate");
});
it("migration preserves historical duplicates/self-reports and does not retroactively quarantine", async () => {
  const historical = await createAtomicTestDatabase();
  try {
    await historical.exec(
      "create table admin_roles(user_id uuid primary key,role text not null)",
    );
    await historical.exec(migration("20261007120000_moderation_foundation.sql"));
    await historical.exec(migration("20261009120000_moderation_workflow_core.sql"));
    await historical.exec(migration("20261010120000_moderation_case_foundation.sql"));
    for (const reporter of reporters)
      await historical.query("insert into auth.users values($1)", [reporter]);
    for (const reporter of [
      ACTOR,
      reporters[0],
      reporters[0],
      reporters[1],
      reporters[2],
    ])
      await historical.query("select community_post_report_create($1,$2,'spam',null)", [
        reporter,
        POST,
      ]);
    const before = (
      await historical.query(
        "select to_jsonb(r) row from community_post_reports r order by id",
      )
    ).rows;
    await historical.exec(sql);
    await historical.exec(accountFixSql);
    expect(
      (
        await historical.query(
          "select to_jsonb(r) row from community_post_reports r order by id",
        )
      ).rows,
    ).toEqual(before);
    expect(
      (await historical.query("select status,version from community_posts")).rows,
    ).toEqual([{ status: "published", version: 2 }]);
    expect(
      (await historical.query("select * from moderation_audit_log")).rows,
    ).toHaveLength(0);
    // A duplicate request still does not activate a retrospective transition.
    const duplicate = (
      await historical.query<{ result: Record<string, unknown> }>(
        "select community_post_report_submit($1,$2,'spam',null) result",
        [reporters[0], POST],
      )
    ).rows[0]!.result;
    expect(duplicate).toMatchObject({
      alreadyReported: true,
      visibilityChanged: false,
      distinctReporterCount: 3,
    });
    expect(
      (await historical.query("select * from community_moderation_decisions")).rows,
    ).toHaveLength(0);
  } finally {
    await historical.close();
  }
});
it.each(["published", "hidden"])(
  "existing %s atomic edit semantics remain unchanged",
  async (status) => {
    await db.query("update community_posts set status=$1 where id=$2", [status, POST]);
    const result = await atomicSave(db, [0, 1, 2]);
    expect(result.post).toMatchObject({ version: 3, text: "Editado" });
    expect(
      (await db.query("select status from community_posts where id=$1", [POST])).rows,
    ).toEqual([{ status }]);
  },
);
it("delete wins after two reports: third rejects and history remains consistent", async () => {
  await submit(reporters[0]);
  await submit(reporters[1]);
  await db.query("select community_post_delete($1,$2,2)", [ACTOR, POST]);
  await db.exec("set constraints all immediate");
  await rejectWithoutChange(() => submit(reporters[2]), "post_not_found");
  expect((await db.query("select * from community_post_reports")).rows).toHaveLength(2);
  expect((await db.query("select * from moderation_audit_log")).rows).toHaveLength(0);
});
it("report RPC is definer with a fixed safe path and explicit controlled owner", async () => {
  const rows = (
    await db.query(
      "select p.prosecdef,p.proconfig,r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid='community_post_report_submit(uuid,uuid,text,text)'::regprocedure",
    )
  ).rows;
  expect(rows).toEqual([
    {
      prosecdef: true,
      proconfig: ["search_path=pg_catalog, public"],
      rolname: "postgres",
    },
  ]);
});
it("canonical writer locks post then case then ordered reports before deduplication/counting", () => {
  const writer = sql.slice(
    0,
    sql.indexOf("alter function public.community_post_report_submit"),
  );
  const post = writer.indexOf("where id = p_post_id for update");
  const caseLock = writer.indexOf("where post_id = p_post_id for update");
  const reports = writer.indexOf("order by id for update");
  const duplicate = writer.indexOf("v_duplicate := found");
  const count = writer.indexOf("select count(distinct r.reporter_user_id)");
  expect(post).toBeGreaterThan(0);
  expect(caseLock).toBeGreaterThan(post);
  expect(reports).toBeGreaterThan(caseLock);
  expect(duplicate).toBeGreaterThan(reports);
  expect(count).toBeGreaterThan(duplicate);
  expect(writer).not.toMatch(
    /insert into public.community_moderation_decisions|create table.*strike/i,
  );
});
it("resolved evidence is preserved but excluded from the current pending threshold", async () => {
  const first = await submit(reporters[0]);
  await submit(reporters[1]);
  await db.query("select community_moderation_action($1,$2,'resolve',1,2,null)", [
    ACTOR,
    first.reportId,
  ]);
  expect(await submit(reporters[2])).toMatchObject({
    distinctReporterCount: 2,
    visibilityChanged: false,
    postStatus: "published",
    postVersion: 2,
  });
  expect(await submit(reporters[3])).toMatchObject({
    distinctReporterCount: 3,
    visibilityChanged: true,
    postStatus: "hidden_pending_review",
    postVersion: 3,
  });
  expect(
    (
      await db.query("select status from community_post_reports where id=$1", [
        first.reportId,
      ])
    ).rows,
  ).toEqual([{ status: "resolved" }]);
});
it("reviewing is still pending: retry returns the same report without advancing the case", async () => {
  const first = await submit();
  await db.query("select community_moderation_action($1,$2,'reviewing',1,2,null)", [
    ACTOR,
    first.reportId,
  ]);
  expect(await submit()).toMatchObject({
    reportId: first.reportId,
    reportStatus: "reviewing",
    alreadyReported: true,
    caseVersion: 2,
    distinctReporterCount: 1,
    visibilityChanged: false,
  });
});

it.each([
  [null, null],
  ["", null],
  ["   ", null],
  ["  Contexto  ", "Contexto"],
  ["\tContexto\t", "\tContexto\t"],
  ["x".repeat(1000), "x".repeat(1000)],
])(
  "normalizes optional detail like historical btrim/nullif (%j)",
  async (input, stored) => {
    const result = await submit(reporters[0], "spam", input);
    expect(
      (
        await db.query("select detail from community_post_reports where id=$1", [
          result.reportId,
        ])
      ).rows,
    ).toEqual([{ detail: stored }]);
  },
);

it("does not broaden the raw R2 length limit when trimming context", async () => {
  await rejectWithoutChange(
    () => submit(reporters[0], "spam", " ".repeat(1001)),
    "detail_too_long",
  );
  expect((await db.query("select * from community_post_reports")).rows).toHaveLength(0);
  expect((await db.query("select * from community_moderation_cases")).rows).toHaveLength(
    0,
  );
});

it("missing current reporter leaves report/case/cycle/audit state unchanged", async () => {
  await db.query("delete from auth.users where id=$1", [reporters[0]]);
  await rejectWithoutChange(() => submit(), "unauthenticated");
  for (const table of [
    "community_post_reports",
    "community_moderation_cases",
    "community_moderation_cycles",
    "moderation_audit_log",
  ])
    expect((await db.query(`select * from ${table}`)).rows).toHaveLength(0);
});

it("later deletion removes an old vote from future counts without erasing its report", async () => {
  await submit(reporters[0]);
  await submit(reporters[1]);
  await db.query("delete from auth.users where id=$1", [reporters[1]]);
  expect(await submit(reporters[2])).toMatchObject({
    distinctReporterCount: 2,
    postStatus: "published",
    visibilityChanged: false,
    caseVersion: 4,
  });
  expect(await submit(reporters[3])).toMatchObject({
    distinctReporterCount: 3,
    postStatus: "hidden_pending_review",
    visibilityChanged: true,
    caseVersion: 5,
  });
  expect((await db.query("select * from community_post_reports")).rows).toHaveLength(4);
});

it("account deletion after committed quarantine does not restore the post or permit a retry", async () => {
  for (let i = 0; i < 3; i++) await submit(reporters[i]);
  await db.query("delete from auth.users where id=$1", [reporters[2]]);
  await rejectWithoutChange(() => submit(reporters[2]), "unauthenticated");
  expect(await submit(reporters[3])).toMatchObject({
    distinctReporterCount: 3,
    visibilityChanged: false,
    postStatus: "hidden_pending_review",
    postVersion: 3,
    caseVersion: 5,
  });
  expect((await db.query("select * from moderation_audit_log")).rows).toHaveLength(1);
});
