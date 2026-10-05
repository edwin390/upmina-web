// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import {
  createAtomicTestDatabase,
  ACTOR,
  POST,
  type TestDatabase,
} from "./community-atomic-save-test-db";
import { normalizeModerationCase } from "./moderation-case-handlers";
import { parseModerationCase } from "./moderation-case-parser";

const migration = (name: string) =>
  readFileSync(resolve("supabase/migrations", name), "utf8");
const FIX = "20261015120000_moderation_grouped_decision_core.sql";
const reporters = [1, 2, 3, 4].map(
  (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`,
);
let db: TestDatabase;
type Context = {
  caseId: string;
  cycleId: string;
  caseVersion: number;
  postVersion: number;
};
beforeAll(async () => {
  db = await createAtomicTestDatabase();
  await db.exec(`create table admin_roles(user_id uuid primary key,role text);
    alter table profiles add column username text;
    alter table media_assets add column storage_key text, add column width int, add column height int, add column duration_seconds numeric;`);
  for (const name of [
    "20261007120000_moderation_foundation.sql",
    "20261009120000_moderation_workflow_core.sql",
    "20261010120000_moderation_case_foundation.sql",
    "20261011120000_community_report_submission.sql",
    "20261012120000_community_report_submission_account_race_fix.sql",
    "20261013120000_moderation_case_read_model.sql",
    "20261014120000_moderation_case_media_references.sql",
    FIX,
  ])
    await db.exec(migration(name));
  const del = migration("20261004120000_community_posts_media.sql").match(
    /create or replace function public\.community_post_delete\([\s\S]*?\n\$\$;/,
  )![0];
  await db.exec(del);
  await db.query("insert into admin_roles values($1,'moderator')", [ACTOR]);
  for (const id of reporters) await db.query("insert into auth.users values($1)", [id]);
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
async function submit(id = reporters[0], post = POST) {
  return (
    await db.query<{ r: Context }>(
      "select community_post_report_submit($1,$2,'spam',null) r",
      [id, post],
    )
  ).rows[0]!.r;
}
async function fixture(n = 1) {
  let c!: Context;
  for (let i = 0; i < n; i++) c = await submit(reporters[i]);
  return c;
}
async function decide(
  c: Context,
  decision = "reports_not_valid",
  postVersion: number | null = c.postVersion,
  message: string | null = null,
) {
  return (
    await db.query<{ r: Record<string, unknown> }>(
      "select community_moderation_case_decide($1,$2,$3,$4,$5,$6,$7) r",
      [ACTOR, c.caseId, c.cycleId, c.caseVersion, postVersion, decision, message],
    )
  ).rows[0]!.r;
}
async function snap() {
  return (
    await db.query(`select jsonb_build_object('p',(select jsonb_agg(p order by id) from community_posts p),
    'r',(select jsonb_agg(r order by id) from community_post_reports r),
    'c',(select jsonb_agg(c order by id) from community_moderation_cases c),
    'y',(select jsonb_agg(y order by id) from community_moderation_cycles y),
    'd',(select jsonb_agg(d order by id) from community_moderation_decisions d),
    'n',(select jsonb_agg(n order by id) from community_moderation_author_notices n),
    'a',(select jsonb_agg(a order by id) from moderation_audit_log a),
    'm',(select jsonb_agg(m order by id) from community_post_media m),
    'assets',(select jsonb_agg(a order by id) from media_assets a)) s`)
  ).rows;
}
async function rejects(action: () => Promise<unknown>, error: string) {
  const before = await snap();
  await db.exec("savepoint failure");
  await expect(action()).rejects.toThrow(error);
  await db.exec("rollback to savepoint failure");
  expect(await snap()).toEqual(before);
}
it.each([1, 3])(
  "No procede closes %i reports and only attributable HPR changes post",
  async (n) => {
    const c = await fixture(n);
    const r = await decide(c);
    await db.exec("set constraints all immediate");
    expect(r).toMatchObject({
      decision: "reports_not_valid",
      caseVersion: c.caseVersion + 1,
      postStatus: "published",
      postVersion: c.postVersion + (n === 3 ? 1 : 0),
      visibilityChanged: n === 3,
    });
    const reports = (
      await db.query("select status,version,resolved_by from community_post_reports")
    ).rows;
    expect(reports).toHaveLength(n);
    reports.forEach((x) =>
      expect(x).toMatchObject({ status: "dismissed", version: 2, resolved_by: ACTOR }),
    );
    expect(
      (await db.query("select status,closure_kind from community_moderation_cycles"))
        .rows[0],
    ).toEqual({ status: "closed", closure_kind: "decision" });
    expect(
      (
        await db.query(
          "select notice_type,seen_at from community_moderation_author_notices",
        )
      ).rows,
    ).toEqual([{ notice_type: "reports_not_valid", seen_at: null }]);
    expect(
      (
        await db.query(
          "select action,actor_kind from moderation_audit_log where target_type='community_moderation_case'",
        )
      ).rows,
    ).toEqual([{ action: "case_rejected", actor_kind: "human" }]);
  },
);
it.each(["published", "hidden_pending_review", "hidden"])(
  "Procede from %s retains body/media, attributes exact 72 hours",
  async (state) => {
    const c = await fixture(state === "hidden_pending_review" ? 3 : 1);
    if (state === "hidden") await db.exec("update community_posts set status='hidden'");
    const mediaBefore = (await db.query("select * from community_post_media order by id"))
      .rows;
    const assetsBefore = (await db.query("select * from media_assets order by id")).rows;
    const r = await decide(c, "content_actioned", c.postVersion, " \nMotivo humano\t ");
    await db.exec("set constraints all immediate");
    expect(r).toMatchObject({
      postStatus: "removed_pending_purge",
      postVersion: c.postVersion + 1,
      caseVersion: c.caseVersion + 1,
      visibilityChanged: true,
    });
    const p = (
      await db.query(
        "select text,quarantine_cycle_id,removal_decision_id,extract(epoch from (purge_after-removed_at)) seconds, removed_at=(select created_at from community_moderation_decisions) coherent from community_posts",
      )
    ).rows[0]!;
    expect(p).toMatchObject({
      text: "Original",
      quarantine_cycle_id: null,
      removal_decision_id: r.decisionId,
      seconds: "259200.000000",
      coherent: true,
    });
    expect(
      (
        await db.query(
          "select resolution_message,resulting_post_status from community_moderation_decisions",
        )
      ).rows[0],
    ).toEqual({
      resolution_message: "Motivo humano",
      resulting_post_status: "removed_pending_purge",
    });
    expect(
      (await db.query("select * from community_post_media order by id")).rows,
    ).toEqual(mediaBefore);
    expect((await db.query("select * from media_assets order by id")).rows).toEqual(
      assetsBefore,
    );
    expect(
      (await db.query("select status,version from community_post_reports")).rows.every(
        (x) => x.status === "actioned" && x.version === 2,
      ),
    ).toBe(true);
    expect(
      (await db.query("select * from community_moderation_author_notices")).rows,
    ).toEqual([]);
    expect(
      (
        await db.query(
          "select count(*)::int n from moderation_audit_log where action='content_actioned' and actor_kind='human'",
        )
      ).rows[0],
    ).toEqual({ n: 1 });
  },
);
it("hidden No procede never restores, schedules purge or creates notice", async () => {
  const c = await fixture();
  await db.exec("update community_posts set status='hidden'");
  expect(await decide(c)).toMatchObject({
    postStatus: "hidden",
    postVersion: c.postVersion,
    visibilityChanged: false,
  });
  expect((await db.query("select purge_after from community_posts")).rows[0]).toEqual({
    purge_after: null,
  });
  expect(
    (await db.query("select * from community_moderation_author_notices")).rows,
  ).toEqual([]);
});
it("already closed historical reports preserve status/version/note", async () => {
  const c = await fixture(2);
  await db.query(
    "update community_post_reports set status='resolved',resolved_by=$1,resolution_note='historical' where reporter_user_id=$2",
    [ACTOR, reporters[0]],
  );
  await decide(c, "content_actioned", c.postVersion, "Razón");
  expect(
    (
      await db.query(
        "select status,version,resolution_note from community_post_reports where reporter_user_id=$1",
        [reporters[0]],
      )
    ).rows[0],
  ).toEqual({ status: "resolved", version: 1, resolution_note: "historical" });
});
it("deleted post supports no-consequence close without notice or fabricated state", async () => {
  const c = await fixture();
  await db.query("select community_post_delete($1,$2,$3)", [ACTOR, POST, c.postVersion]);
  await rejects(() => decide(c, "content_actioned", null, "Razón"), "post_not_found");
  expect(await decide(c, "reports_not_valid", null)).toMatchObject({
    postStatus: null,
    postVersion: null,
    visibilityChanged: false,
  });
  await db.exec("set constraints all immediate");
  expect(
    (await db.query("select * from community_moderation_author_notices")).rows,
  ).toEqual([]);
  expect(
    (
      await db.query(
        "select metadata->>'content_available' value from moderation_audit_log where action='case_rejected'",
      )
    ).rows[0],
  ).toEqual({ value: "false" });
});
it.each([null, "", " \n\t", "\u00a0\u2003"])(
  "Procede missing/whitespace message %j has zero mutation",
  async (message) => {
    const c = await fixture();
    await rejects(
      () => decide(c, "content_actioned", c.postVersion, message),
      "resolution_message_required",
    );
  },
);
it("Unicode normalization/1000-codepoint limit is consistent", async () => {
  const c = await fixture();
  await rejects(
    () => decide(c, "content_actioned", c.postVersion, "😀".repeat(1001)),
    "invalid_argument",
  );
  await decide(
    c,
    "content_actioned",
    c.postVersion,
    "\uFEFF" + "😀".repeat(1000) + "\u00a0",
  );
  expect(
    (
      await db.query(
        "select char_length(resolution_message) n from community_moderation_decisions",
      )
    ).rows[0],
  ).toEqual({ n: 1000 });
});
it.each(["reports_not_valid", "content_actioned"])(
  "report-first makes %s decision stale",
  async (decision) => {
    const c = await fixture();
    await submit(reporters[1]);
    await rejects(
      () =>
        decide(
          c,
          decision,
          c.postVersion,
          decision === "content_actioned" ? "Razón" : null,
        ),
      "case_version_conflict",
    );
  },
);
it("decision-first No procede opens a distinct next cycle; two notices remain independent", async () => {
  const c = await fixture();
  await decide(c);
  const next = await submit(reporters[0]);
  expect(next.caseId).toBe(c.caseId);
  expect(next.cycleId).not.toBe(c.cycleId);
  await decide(next);
  await db.exec("set constraints all immediate");
  expect(
    (await db.query("select count(*)::int n from community_moderation_author_notices"))
      .rows[0],
  ).toEqual({ n: 2 });
});
it("decision-first Procede rejects reports without changing lifetime/count/versions", async () => {
  const c = await fixture();
  await decide(c, "content_actioned", c.postVersion, "Razón");
  await rejects(() => submit(reporters[1]), "post_not_reportable");
});
it.each(["reports_not_valid", "content_actioned"])(
  "second moderator decision %s cannot duplicate history",
  async (second) => {
    const c = await fixture();
    await decide(c, "content_actioned", c.postVersion, "Razón");
    await rejects(
      () =>
        decide(c, second, c.postVersion, second === "content_actioned" ? "Razón" : null),
      "case_version_conflict",
    );
  },
);
it("decision/owner delete order respects versions and keeps history", async () => {
  const c = await fixture();
  const r = await decide(c, "content_actioned", c.postVersion, "Razón");
  await rejects(
    () =>
      db.query("select community_post_delete($1,$2,$3)", [ACTOR, POST, c.postVersion]),
    "version_conflict",
  );
  await db.query("select community_post_delete($1,$2,$3)", [ACTOR, POST, r.postVersion]);
  await db.exec("set constraints all immediate");
  expect(
    (await db.query("select count(*)::int n from community_moderation_decisions"))
      .rows[0],
  ).toEqual({ n: 1 });
});
it("owner delete first makes live expectation conflict", async () => {
  const c = await fixture();
  await db.query("select community_post_delete($1,$2,$3)", [ACTOR, POST, c.postVersion]);
  await rejects(
    () => decide(c, "content_actioned", c.postVersion, "Razón"),
    "post_version_conflict",
  );
});
it("role revocation before decision rejects without mutation", async () => {
  const c = await fixture();
  await db.exec("delete from admin_roles");
  await rejects(() => decide(c), "actor_not_moderator");
});
it("audit failure after report/case/post writes rolls everything back", async () => {
  const c = await fixture(2);
  await db.exec(`create function reject_grouped_audit() returns trigger language plpgsql as $$ begin
    if new.action = 'content_actioned' then
      if (select status from community_posts limit 1) <> 'removed_pending_purge'
        or (select status from community_moderation_cases limit 1) <> 'closed'
        or exists(select 1 from community_post_reports where status <> 'actioned') then raise exception 'wrong_failure_point'; end if;
      raise exception 'synthetic_audit_failure';
    end if; return new; end $$;
    create trigger reject_grouped before insert on moderation_audit_log for each row execute function reject_grouped_audit();`);
  await rejects(
    () => decide(c, "content_actioned", c.postVersion, "Razón"),
    "synthetic_audit_failure",
  );
});
it.each([
  "update community_moderation_decisions set note='changed'",
  "delete from community_moderation_decisions",
  "truncate community_moderation_decisions",
])("decision history rejects %s", async (sql) => {
  await decide(await fixture());
  await db.exec("set constraints all immediate");
  await rejects(
    () =>
      db.exec(
        sql.replace(
          "truncate community_moderation_decisions",
          "truncate community_moderation_decisions, community_moderation_author_notices, community_posts cascade",
        ),
      ),
    "community_moderation_history_immutable",
  );
});
it.each([
  "removal_decision_id=null",
  "removed_at=null",
  "purge_after=null",
  "purge_after=purge_after+interval '1 hour'",
  "quarantine_cycle_id=(select id from community_moderation_cycles limit 1)",
])("invalid removed fields rejected: %s", async (assignment) => {
  await decide(await fixture(), "content_actioned", 2, "Razón");
  await rejects(
    () =>
      db.exec(`update community_posts set ${assignment}; set constraints all immediate`),
    "check constraint",
  );
});
it.each(["published", "hidden", "hidden_pending_review"])(
  "removal metadata cannot remain on %s",
  async (state) => {
    const c = await fixture();
    await decide(c, "content_actioned", c.postVersion, "Razón");
    await rejects(
      () =>
        db.exec(
          `update community_posts set status='${state}'; set constraints all immediate`,
        ),
      "check constraint",
    );
  },
);
it("deferred attribution rejects compatible ID with wrong decision type", async () => {
  const c = await fixture();
  const r = await decide(c);
  await rejects(
    () =>
      db
        .query(
          `update community_posts set status='removed_pending_purge',removal_decision_id=$1,
    removed_at=$2,purge_after=$2::timestamptz+interval '72 hours';`,
          [r.decisionId, r.createdAt],
        )
        .then(() => db.exec("set constraints all immediate")),
    "removal_context_inconsistent",
  );
});
it("deferred attribution rejects decision timestamp mismatch", async () => {
  const c = await fixture();
  await decide(c, "content_actioned", c.postVersion, "Razón");
  await rejects(
    () =>
      db.exec(
        "update community_posts set removed_at=removed_at+interval '1 second',purge_after=purge_after+interval '1 second'; set constraints all immediate",
      ),
    "removal_context_inconsistent",
  );
});
it.each(["hidden", "removed_pending_purge", "hidden_pending_review"])(
  "all author mutation RPCs reject %s, preserving media",
  async (state) => {
    const c = await fixture(state === "hidden_pending_review" ? 3 : 1);
    if (state === "hidden") await db.exec("update community_posts set status='hidden'");
    if (state === "removed_pending_purge")
      await decide(c, "content_actioned", c.postVersion, "Razón");
    for (const sql of [
      "select community_post_save($1,$2,99,'Edited','[]'::jsonb)",
      "select community_post_save_atomic($1,$2,99,'Edited','[]'::jsonb,'{}'::uuid[])",
      "select community_post_reorder_media($1,$2,99,'[]'::jsonb)",
      `select community_post_detach_media($1,$2,99,'11111111-1111-4111-8111-000000000001'::uuid)`,
    ])
      await rejects(() => db.query(sql, [ACTOR, POST]), "post_not_editable");
  },
);
it("R3 History has safe decision/removal projection and unchanged opaque media references", async () => {
  const c = await fixture();
  await decide(c, "content_actioned", c.postVersion, "Razón");
  const read = async (scope: string) =>
    (
      await db.query<{ r: { cases: unknown[] } }>(
        "select community_moderation_cases_read($1,$2,null,null,null) r",
        [ACTOR, scope],
      )
    ).rows[0]!.r;
  expect((await read("active")).cases).toEqual([]);
  const history = (await read("closed")).cases;
  expect(history).toHaveLength(1);
  const parsed = normalizeModerationCase(history[0]);
  expect(parsed.decision).toMatchObject({
    result: "content_actioned",
    resolutionMessage: "Razón",
  });
  expect(parsed.post?.status).toBe("removed_pending_purge");
  expect(JSON.stringify(history)).not.toMatch(
    /storage_key|reporter_user_id|actor_user_id/,
  );
  expect(() =>
    parseModerationCase({ ...parsed, decision: { result: "content_actioned" } }),
  ).toThrow();
});

it("cross-post removal decision cannot be attributed to another publication", async () => {
  const c = await fixture();
  const r = await decide(c, "content_actioned", c.postVersion, "Razón");
  const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await db.query(
    "insert into community_posts(id,author_user_id,text) values($1,$2,'Other')",
    [other, ACTOR],
  );
  await rejects(
    () =>
      db.query(
        "update community_posts set status='removed_pending_purge',removal_decision_id=$1,removed_at=$2,purge_after=$2::timestamptz+interval '72 hours' where id=$3",
        [r.decisionId, r.createdAt, other],
      ),
    "foreign key constraint",
  );
});
it("No procede cannot receive a custom message or schedule purge", async () => {
  const c = await fixture();
  await rejects(
    () => decide(c, "reports_not_valid", c.postVersion, "Custom"),
    "invalid_argument",
  );
  const r = await decide(c);
  await rejects(
    () =>
      db.query(
        "update community_posts set removal_decision_id=$1,removed_at=$2,purge_after=$2::timestamptz+interval '72 hours'",
        [r.decisionId, r.createdAt],
      ),
    "check constraint",
  );
});
it("missing/incompatible resolution messages cannot bypass decision CHECK", async () => {
  const c = await fixture();
  await rejects(
    () =>
      db.query(
        "insert into community_moderation_decisions(case_id,post_id,cycle_id,actor_user_id,decision,expected_case_version,expected_post_version,resulting_post_status) values($1,$2,$3,$4,'content_actioned',1,2,'removed_pending_purge')",
        [c.caseId, POST, c.cycleId, ACTOR],
      ),
    "check constraint",
  );
});
it("wrong current cycle is rejected atomically", async () => {
  const c = await fixture();
  await rejects(() => decide({ ...c, cycleId: reporters[1]! }), "cycle_state_conflict");
});
it("mismatched HPR attribution is rejected before grouped writes", async () => {
  const c = await fixture(3);
  await db.query(
    "insert into community_moderation_cycles(case_id,post_id,cycle_number,status,opened_at) values($1,$2,2,'pending',now())",
    [c.caseId, POST],
  );
  await db.query(
    "update community_posts set quarantine_cycle_id=(select id from community_moderation_cycles where cycle_number=2)",
  );
  await rejects(() => decide(c), "post_state_conflict");
});
it("fresh forward schema preserves all ordinary Community write paths", async () => {
  const media = (
    await db.query<{ asset_id: string; id: string }>(
      "select asset_id,id from community_post_media order by position",
    )
  ).rows;
  const order = JSON.stringify(
    media.map((m, position) => ({ asset_id: m.asset_id, position })),
  );
  await db.query("select community_post_save($1,$2,2,'Edited',$3::jsonb)", [
    ACTOR,
    POST,
    order,
  ]);
  await db.query(
    "select community_post_save_atomic($1,$2,3,'Atomic',$3::jsonb,'{}'::uuid[])",
    [ACTOR, POST, order],
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
it("migration applied on existing R3 preserves data without retroactive resolution", async () => {
  const fresh = await createAtomicTestDatabase();
  try {
    await fresh.exec(
      "create table admin_roles(user_id uuid primary key,role text); alter table profiles add column username text; alter table media_assets add column storage_key text, add column width int, add column height int, add column duration_seconds numeric;",
    );
    for (const name of [
      "20261007120000_moderation_foundation.sql",
      "20261009120000_moderation_workflow_core.sql",
      "20261010120000_moderation_case_foundation.sql",
      "20261011120000_community_report_submission.sql",
      "20261012120000_community_report_submission_account_race_fix.sql",
      "20261013120000_moderation_case_read_model.sql",
      "20261014120000_moderation_case_media_references.sql",
    ])
      await fresh.exec(migration(name));
    await fresh.query("insert into auth.users values($1)", [reporters[0]]);
    await fresh.query("select community_post_report_submit($1,$2,'spam',null)", [
      reporters[0],
      POST,
    ]);
    const baseline = async () =>
      (
        await fresh.query(
          "select (select jsonb_agg(r order by id) from community_post_reports r) reports,(select jsonb_agg(c order by id) from community_moderation_cases c) cases,(select status from community_posts) status,(select count(*) from moderation_audit_log) audits",
        )
      ).rows;
    const before = await baseline();
    await fresh.exec(migration(FIX));
    expect(await baseline()).toEqual(before);
    expect(
      (await fresh.query("select count(*)::int n from community_moderation_decisions"))
        .rows[0],
    ).toEqual({ n: 0 });
    expect(
      (
        await fresh.query(
          "select count(*)::int n from community_moderation_author_notices",
        )
      ).rows[0],
    ).toEqual({ n: 0 });
  } finally {
    await fresh.close();
  }
});
it("migration cannot grant individual/direct mutation bypass or introduce R4-E/R5", async () => {
  for (const signature of [
    "community_moderation_action(uuid,uuid,text,integer,integer,text)",
    "community_post_report_set_status(uuid,uuid,text,text)",
  ])
    expect(
      (
        await db.query(
          "select has_function_privilege('service_role',$1,'EXECUTE') allowed",
          [signature],
        )
      ).rows[0],
    ).toEqual({ allowed: false });
  expect(
    (
      await db.query(
        "select has_table_privilege('service_role','community_post_reports','UPDATE') allowed",
      )
    ).rows[0],
  ).toEqual({ allowed: false });
  expect(
    (
      await db.query(
        "select relrowsecurity,relforcerowsecurity from pg_class where relname='community_moderation_author_notices'",
      )
    ).rows[0],
  ).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  const sql = migration(FIX);
  expect(sql).not.toMatch(
    /create.*strike|cron\.schedule|delete from public\.community_posts/i,
  );
  expect(sql).toContain("p_cycle_id for update");
  expect(sql).toContain("order by id for update");
  expect(sql.indexOf("v_now := clock_timestamp()")).toBeGreaterThan(
    sql.indexOf("order by id for update"),
  );
});
// Guard de inmutabilidad: CRLF y LF son el mismo contenido (autocrlf cambia los finales de línea
// del working tree). SOLO se normaliza CRLF a LF antes del SHA256; cualquier otro cambio rompe el hash.
function canonicalSha256(bytes: Uint8Array): string {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++)
    if (!(bytes[i] === 13 && bytes[i + 1] === 10)) out.push(bytes[i]);
  return createHash("sha256").update(Uint8Array.from(out)).digest("hex");
}
it.each([
  [
    "20261010120000_moderation_case_foundation.sql",
    "0415942b02ef6272f8ba0d4e9fd186b41d4a1c111f979fb633a6aaeb3102c92a",
  ],
  [
    "20261011120000_community_report_submission.sql",
    "b80ce5dd8714d659626903b4be53fed56fbbbb54483b9e650a07f2c8e452c059",
  ],
  [
    "20261012120000_community_report_submission_account_race_fix.sql",
    "7e383446c2b4b3a42d3619a0a623c718c7436e54eb245944a6971a18142f833a",
  ],
  [
    "20261013120000_moderation_case_read_model.sql",
    "8b8dc1265c886c8e306808b57aff0e435d6faa89ae2e635eb3e1fdd1438ac436",
  ],
  [
    "20261014120000_moderation_case_media_references.sql",
    "281929533b481164fa73144d2817805f0d2f3e35573b21acaea1bc503e85735e",
  ],
])("historical %s stays immutable", (name, hash) =>
  expect(canonicalSha256(readFileSync(resolve("supabase/migrations", name)))).toBe(hash),
);
