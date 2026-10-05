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
import type { ModerationCaseItem } from "./moderation-case-contract";
const migration = (n: string) => readFileSync(resolve("supabase/migrations", n), "utf8");
const sql = migration("20261013120000_moderation_case_read_model.sql");
const reporters = [1, 2, 3, 4].map(
  (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`,
);
let db: TestDatabase;
async function submit(reporter = reporters[0], target = POST, reason = "spam") {
  return (
    await db.query<{ result: { caseId: string; cycleId: string } }>(
      "select community_post_report_submit($1,$2,$3,'context') result",
      [reporter, target, reason],
    )
  ).rows[0]!.result;
}
async function page(
  scope = "active",
  before: { activityAt: string; cycleId: string } | null = null,
) {
  return (
    await db.query<{
      result: {
        cases: ModerationCaseItem[];
        next: { activityAt: string; cycleId: string } | null;
      };
    }>("select community_moderation_cases_read($1,$2,$3,$4,null) result", [
      ACTOR,
      scope,
      before?.activityAt ?? null,
      before?.cycleId ?? null,
    ])
  ).rows[0]!.result;
}
async function detail(cycle: string) {
  return (
    await db.query<{ result: { item: ModerationCaseItem } }>(
      "select community_moderation_cases_read($1,'active',null,null,$2) result",
      [ACTOR, cycle],
    )
  ).rows[0]!.result.item;
}
beforeAll(async () => {
  db = await createAtomicTestDatabase();
  await db.exec(`create table admin_roles(user_id uuid primary key,role text);
    alter table profiles add column username text;
    alter table media_assets add column storage_key text, add column width int, add column height int, add column duration_seconds numeric;`);
  for (const n of [
    "20261007120000_moderation_foundation.sql",
    "20261009120000_moderation_workflow_core.sql",
    "20261010120000_moderation_case_foundation.sql",
    "20261011120000_community_report_submission.sql",
    "20261012120000_community_report_submission_account_race_fix.sql",
    "20261013120000_moderation_case_read_model.sql",
    "20261014120000_moderation_case_media_references.sql",
  ])
    await db.exec(migration(n));
  await db.query("insert into admin_roles values($1,'moderator')", [ACTOR]);
  for (const r of reporters) await db.query("insert into auth.users values($1)", [r]);
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

it.each([1, 3])(
  "%i reports produce exactly one current case card with authoritative count",
  async (n) => {
    for (let i = 0; i < n; i++) await submit(reporters[i]);
    const p = await page();
    expect(p.cases).toHaveLength(1);
    expect(p.cases[0]).toMatchObject({
      totalReports: n,
      qualifyingReporters: n,
      post: { status: n === 3 ? "hidden_pending_review" : "published" },
      reports: [],
    });
  },
);
it("grouped canonical reasons preserve raw totals without leaking identities", async () => {
  const { cycleId } = await submit();
  await submit(reporters[1]);
  await submit(reporters[2], POST, "harassment");
  const d = await detail(cycleId);
  expect(d.reasons).toEqual([
    { reason: "harassment", count: 1 },
    { reason: "spam", count: 2 },
  ]);
  expect(d.reports).toHaveLength(3);
  for (const r of reporters) expect(JSON.stringify(d)).not.toContain(r);
  expect(JSON.stringify(d)).not.toMatch(
    /reporter_user_id|actor_user_id|target_author_user_id/,
  );
});
it("pending duplicates count once; resolved/dismissed and deleted accounts do not count", async () => {
  const { caseId, cycleId } = await submit();
  await db.query(
    "insert into community_post_reports(post_id,reporter_user_id,reason,status,case_id,cycle_id) values($1,$2,'spam','reviewing',$3,$4)",
    [POST, reporters[0], caseId, cycleId],
  );
  for (const status of ["resolved", "dismissed"])
    await db.query(
      "insert into community_post_reports(post_id,reporter_user_id,reason,status,resolved_by,case_id,cycle_id) values($1,$2,'other',$3,$4,$5,$6)",
      [POST, reporters[1], status, ACTOR, caseId, cycleId],
    );
  await submit(reporters[2]);
  await db.query("delete from auth.users where id=$1", [reporters[2]]);
  expect(await detail(cycleId)).toMatchObject({
    totalReports: 5,
    qualifyingReporters: 1,
  });
});
it("author reports do not qualify and valid submission rejects self-report", async () => {
  const { caseId, cycleId } = await submit();
  await db.query(
    "insert into community_post_reports(post_id,reporter_user_id,reason,case_id,cycle_id) values($1,$2,'spam',$3,$4)",
    [POST, ACTOR, caseId, cycleId],
  );
  expect((await detail(cycleId)).qualifyingReporters).toBe(1);
  await expect(submit(ACTOR)).rejects.toThrow("self_report");
});
it("previous closed cycles are history; new current cycle excludes previous reports", async () => {
  const first = await submit();
  await db.query(
    "update community_moderation_cycles set status='closed',closure_kind='legacy',closed_at=now() where id=$1",
    [first.cycleId],
  );
  await db.query(
    "update community_moderation_cases set status='closed',closed_at=now() where id=$1",
    [first.caseId],
  );
  await submit(reporters[1]);
  await db.exec("set constraints all immediate");
  expect((await page()).cases[0]).toMatchObject({
    cycleNumber: 2,
    totalReports: 1,
    qualifyingReporters: 1,
    isCurrentCycle: true,
  });
  expect((await page("closed")).cases[0]).toMatchObject({
    cycleNumber: 1,
    closureKind: "legacy",
    isCurrentCycle: false,
  });
  expect(
    (await db.query("select * from community_moderation_decisions")).rows,
  ).toHaveLength(0);
});
it("old individual closure does not falsely turn pending case into a grouped decision", async () => {
  const { cycleId } = await submit();
  const r = (await detail(cycleId)).reports[0]!;
  await db.query("select community_moderation_action($1,$2,'dismiss',1,2,null)", [
    ACTOR,
    r.reportId,
  ]);
  expect((await page()).cases[0]).toMatchObject({
    cycleStatus: "pending",
    qualifyingReporters: 0,
    closureKind: null,
  });
});
it("deleted target remains one honestly unavailable case without historical snapshot", async () => {
  const { cycleId } = await submit();
  await db.exec("delete from community_post_media");
  await db.query("delete from community_posts where id=$1", [POST]);
  expect(await detail(cycleId)).toMatchObject({ post: null, totalReports: 1, media: [] });
});
it("report detail is capped at 50 with explicit truncation; summaries remain complete", async () => {
  const { caseId, cycleId } = await submit();
  await db.query(
    "insert into community_post_reports(post_id,reporter_user_id,reason,case_id,cycle_id) select $1::uuid,$2::uuid,'spam',$3::uuid,$4::uuid from generate_series(1,55)",
    [POST, reporters[0], caseId, cycleId],
  );
  const d = await detail(cycleId);
  expect(d.reports).toHaveLength(50);
  expect(d.reportsTruncated).toBe(true);
  expect(d.totalReports).toBe(56);
  expect(d.qualifyingReporters).toBe(1);
});
it("stable cursor pages cycles, preserves tied activity and never splits reports", async () => {
  for (let i = 1; i <= 23; i++) {
    const target = `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}`;
    await db.query(
      "insert into community_posts(id,author_user_id,text) values($1,$2,'paged')",
      [target, ACTOR],
    );
    await submit(reporters[0], target);
  }
  await db.exec("update community_post_reports set updated_at='2030-01-01';");
  const first = await page();
  const second = await page("active", first.next);
  expect(first.cases).toHaveLength(20);
  expect(second.cases).toHaveLength(3);
  expect(second.next).toBeNull();
  const ids = [...first.cases, ...second.cases].map((c) => c.cycleId);
  expect(new Set(ids).size).toBe(23);
  expect(ids).toEqual([...ids].sort().reverse());
});
it.each(["moderator", "developer", "admin"])("DB authority accepts %s", async (role) => {
  await db.query("update admin_roles set role=$1 where user_id=$2", [role, ACTOR]);
  expect((await page()).cases).toEqual([]);
});
it("DB rejects an actor without moderation authority", async () => {
  await db.query("delete from admin_roles where user_id=$1", [ACTOR]);
  await expect(page()).rejects.toThrow("actor_not_moderator");
});
it("read does not change reports/post/case versions or produce audit/decisions", async () => {
  const { cycleId } = await submit();
  const snap = async () =>
    (
      await db.query(
        "select jsonb_build_object('p',(select jsonb_agg(p) from community_posts p),'r',(select jsonb_agg(r) from community_post_reports r),'c',(select jsonb_agg(c) from community_moderation_cases c),'a',(select count(*) from moderation_audit_log),'d',(select count(*) from community_moderation_decisions)) s",
      )
    ).rows;
  const before = await snap();
  await page();
  await detail(cycleId);
  expect(await snap()).toEqual(before);
});
it("media uses existing attachment shape and audit is capped/allowlisted", async () => {
  const { cycleId } = await submit();
  await db.exec(
    "update media_assets set storage_key='synthetic/image',width=640,height=480;",
  );
  for (let i = 0; i < 23; i++)
    await db.query(
      "insert into moderation_audit_log(actor_user_id,target_type,target_id,action,metadata) values($1,'community_post',$2,'post_hidden',$3)",
      [
        ACTOR,
        POST,
        JSON.stringify({
          from_post_status: "published",
          to_post_status: "hidden",
          private_note: "do not disclose",
        }),
      ],
    );
  const d = await detail(cycleId);
  expect(d.media).toHaveLength(3);
  expect(d.audit).toHaveLength(20);
  expect(JSON.stringify(d.audit)).not.toContain("private_note");
  expect(JSON.stringify(d.audit)).not.toContain(ACTOR);
});
it("closed legacy cycle does not count historical pending rows as current votes", async () => {
  const { caseId, cycleId } = await submit();
  await db.query(
    "update community_moderation_cycles set status='closed',closure_kind='legacy',closed_at=now() where id=$1",
    [cycleId],
  );
  await db.query(
    "update community_moderation_cases set status='closed',closed_at=now() where id=$1",
    [caseId],
  );
  expect((await page("closed")).cases[0]).toMatchObject({
    totalReports: 1,
    qualifyingReporters: 0,
    closureKind: "legacy",
  });
});
it("missing cycle and malformed page context fail closed", async () => {
  await expect(detail("ffffffff-ffff-4fff-8fff-ffffffffffff")).rejects.toThrow(
    "case_not_found",
  );
});
it.each(["anon", "authenticated", "service_role"])(
  "effective local EXECUTE boundary for %s",
  async (role) => {
    const privileges = (
      await db.query(
        "select has_function_privilege($1,'public.community_moderation_cases_read(uuid,text,timestamp with time zone,uuid,uuid)','EXECUTE') entry, has_function_privilege($1,'public.community_moderation_cycle_read(uuid,boolean)','EXECUTE') helper",
        [role],
      )
    ).rows[0];
    expect(privileges).toEqual({ entry: role === "service_role", helper: false });
  },
);
it("security is service-only read entry and internal projection has no API EXECUTE", () => {
  expect(sql).toMatch(/owner to postgres/g);
  expect(sql.match(/security definer/g)).toHaveLength(2);
  expect(sql.match(/set search_path = pg_catalog, public/g)).toHaveLength(2);
  expect(sql).toMatch(
    /revoke all on function public.community_moderation_cycle_read[^;]*from public, anon, authenticated, service_role/,
  );
  expect(sql.match(/grant execute/g)).toHaveLength(1);
  expect(sql).toMatch(/grant execute[^;]*cases_read[^;]*to service_role/);
  expect(sql).not.toMatch(
    /\b(?:update public|insert into|delete from|create trigger|alter table|grant insert)\b/i,
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
    "20261013120000_moderation_case_read_model.sql",
    "8b8dc1265c886c8e306808b57aff0e435d6faa89ae2e635eb3e1fdd1438ac436",
  ],
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
])("preserves applied migration %s (CRLF/LF-insensitive)", (file, hash) => {
  expect(canonicalSha256(readFileSync(resolve("supabase/migrations", file)))).toBe(hash);
});

it("SQL caps more than ten valid media associations in deterministic position order", async () => {
  const { cycleId } = await submit();
  for (let position = 3; position < 12; position++) {
    const asset = "bbbbbbbb-bbbb-4bbb-8bbb-" + String(position).padStart(12, "0");
    await db.query(
      "insert into media_assets(id,domain,status,kind,created_by,storage_key,width,height) values($1,'community','ready','image',$2,'synthetic/image',640,480)",
      [asset, ACTOR],
    );
    await db.query(
      "insert into community_post_media(post_id,asset_id,position) values($1,$2,$3)",
      [POST, asset, position],
    );
  }
  const result = await detail(cycleId);
  expect(result.media).toHaveLength(10);
  expect(result.media.map((m) => m.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

it("FIX2 raw detail minimizes media and private fields", async () => {
  const { cycleId } = await submit();
  const d = await detail(cycleId);
  expect(d.media.length).toBeGreaterThan(0);
  const forbidden = [
    "storage_key",
    "reporter_user_id",
    "reporterId",
    "email",
    "actor_user_id",
    "metadata",
    "raw_user_meta_data",
  ];
  function check(v: unknown) {
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      expect(forbidden).not.toContain(k);
      check(x);
    }
  }
  check(d);
  for (const m of d.media)
    expect(Object.keys(m).sort()).toEqual(["assetId", "id", "position"]);
});

it("forward replacement on populated R3 preserves all data and closes helper ACL", async () => {
  const { cycleId } = await submit();
  const oldHelper = sql
    .slice(
      sql.indexOf("create function public.community_moderation_cycle_read"),
      sql.indexOf("-- One SQL snapshot"),
    )
    .replace("create function", "create or replace function");
  await db.exec(oldHelper);
  expect(JSON.stringify(await detail(cycleId))).toContain("storage_key");
  const snapshot = async () =>
    (
      await db.query(
        "select jsonb_build_object('p',(select jsonb_agg(p) from community_posts p),'r',(select jsonb_agg(r) from community_post_reports r),'c',(select jsonb_agg(c) from community_moderation_cases c),'y',(select jsonb_agg(y) from community_moderation_cycles y),'a',(select jsonb_agg(a) from moderation_audit_log a)) s",
      )
    ).rows;
  const before = await snapshot();
  const fix = migration("20261014120000_moderation_case_media_references.sql");
  await db.exec(fix);
  expect(await snapshot()).toEqual(before);
  expect(JSON.stringify(await detail(cycleId))).not.toContain("storage_key");
  expect(fix).toMatch(/owner to postgres/);
  expect(fix).toMatch(/set search_path = pg_catalog, public/);
  expect(fix).toMatch(/revoke all[^;]*from public, anon, authenticated, service_role/);
  expect(fix).not.toMatch(
    /storage_key|\b(insert into|update public|delete from|grant|alter table|create trigger)\b/i,
  );
});
