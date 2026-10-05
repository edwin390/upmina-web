// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  ACTOR,
  ASSETS,
  POST,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

const migration = (n: string) => readFileSync(`supabase/migrations/${n}`, "utf8");
const current = "20261019120000_community_media_delivery_state.sql";
const reporters = [1, 2, 3].map(
  (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`,
);
const MISSING = "99999999-9999-4999-8999-999999999999";
const COSPLAY_ASSET = "88888888-8888-4888-8888-888888888888";
let db: TestDatabase;

beforeAll(async () => {
  db = await createAtomicTestDatabase();
  await db.exec(`create table admin_roles(user_id uuid primary key,role text);
 alter table profiles add column username text,add column display_name text;
 alter table media_assets add column storage_key text,add column width int,add column height int,add column duration_seconds numeric;`);
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
    current,
  ])
    await db.exec(migration(n));
  await db.query("insert into admin_roles values($1,'moderator')", [ACTOR]);
  await db.query("update profiles set username='author_test' where user_id=$1", [ACTOR]);
  for (const id of reporters) await db.query("insert into auth.users values($1)", [id]);
  await db.query(
    "insert into media_assets(id,domain,status,kind,created_by) values ($1,'cosplay','ready','image',$2)",
    [COSPLAY_ASSET, ACTOR],
  );
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("begin");
});
afterEach(async () => {
  await db.exec("reset role;rollback");
});

interface State {
  exists: boolean;
  domain: string | null;
  delivery: string;
  privateUntil: string | null;
}
async function state(id: string): Promise<State> {
  return (
    await db.query<{ r: State }>("select community_media_delivery_state($1) r", [id])
  ).rows[0].r;
}
async function removeViaDecision() {
  let ctx!: Record<string, unknown>;
  for (const r of reporters)
    ctx = (
      await db.query<{ r: Record<string, unknown> }>(
        "select community_post_report_submit($1,$2,'spam',null) r",
        [r, POST],
      )
    ).rows[0].r;
  await db.query(
    "select community_moderation_case_decide($1,$2,$3,$4,$5,'content_actioned','x')",
    [ACTOR, ctx.caseId, ctx.cycleId, ctx.caseVersion, ctx.postVersion],
  );
}
const PUB = { exists: true, domain: "community", privateUntil: null };

it("published post → public", async () => {
  expect(await state(ASSETS[0])).toEqual({ ...PUB, delivery: "public" });
});
it("hidden_pending_review → private (never public)", async () => {
  for (const r of reporters)
    await db.query("select community_post_report_submit($1,$2,'spam',null)", [r, POST]);
  expect(
    (await db.query<{ status: string }>("select status from community_posts")).rows[0]
      .status,
  ).toBe("hidden_pending_review");
  expect(await state(ASSETS[0])).toEqual({ ...PUB, delivery: "private" });
});
it("removed_pending_purge before expiry → private with the deadline", async () => {
  await removeViaDecision();
  const deadline = (
    await db.query<{ t: string }>("select purge_after::text t from community_posts")
  ).rows[0].t;
  const result = await state(ASSETS[0]);
  expect(result).toMatchObject({ exists: true, delivery: "private" });
  expect(Date.parse(result.privateUntil!)).toBe(Date.parse(deadline));
});
it.each([
  [-1, "private"],
  [0, "denied"],
  [1, "denied"],
])("expiry boundary at deadline offset %i ms → %s", async (offset, expected) => {
  await removeViaDecision();
  const deadline = (
    await db.query<{ t: string }>("select purge_after::text t from community_posts")
  ).rows[0].t;
  // Seam de reloj: solo reemplaza el inicializador; el predicado de producción no cambia.
  await db.exec(
    migration(current)
      .split("alter function public.community_media_delivery_state")[0]
      .replace("create function", "create or replace function")
      .replace("clock_timestamp()", "current_setting('upmina.test_now')::timestamptz"),
  );
  await db.query(
    "select set_config('upmina.test_now',($1::timestamptz+$2*interval '1 millisecond')::text,true)",
    [deadline, offset],
  );
  expect((await state(ASSETS[0])).delivery).toBe(expected);
});
it("hidden (manual state) → denied", async () => {
  await db.exec("update community_posts set status='hidden'");
  expect((await state(ASSETS[0])).delivery).toBe("denied");
});
it("ready but unattached asset → private, never public", async () => {
  expect(await state(ASSETS[3])).toEqual({ ...PUB, delivery: "private" });
});
it.each(["reserved", "uploaded", "verifying", "processing", "failed", "deleting"])(
  "asset status %s is never deliverable",
  async (status) => {
    await db.query("update media_assets set status=$1 where id=$2", [status, ASSETS[0]]);
    expect((await state(ASSETS[0])).delivery).toBe("denied");
    await db.query("update media_assets set status=$1 where id=$2", [status, ASSETS[3]]);
    expect((await state(ASSETS[3])).delivery).toBe("denied");
  },
);
it("nonexistent and cosplay-domain assets are uniform and never authorized as Community", async () => {
  const uniform = { exists: false, domain: null, delivery: "denied", privateUntil: null };
  expect(await state(MISSING)).toEqual(uniform);
  expect(await state(COSPLAY_ASSET)).toEqual(uniform);
});
it("null asset id is an invalid argument", async () => {
  await db.exec("savepoint s");
  await expect(db.query("select community_media_delivery_state(null)")).rejects.toThrow(
    "invalid_argument",
  );
  await db.exec("rollback to savepoint s");
});
it("projection never leaks owner, post, report, case, decision or storage data", async () => {
  await removeViaDecision();
  for (const id of [ASSETS[0], ASSETS[3], MISSING, COSPLAY_ASSET]) {
    const result = await state(id);
    expect(Object.keys(result).sort()).toEqual([
      "delivery",
      "domain",
      "exists",
      "privateUntil",
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      new RegExp(
        `${ACTOR}|${POST}|${reporters[0]}|storage|reason|case|decision|resolution`,
        "i",
      ),
    );
  }
});
it("is read-only: it never mutates any table", async () => {
  await removeViaDecision();
  const snapshot = async () =>
    (
      await db.query(`select
      (select jsonb_agg(to_jsonb(p) order by id) from community_posts p) posts,
      (select jsonb_agg(to_jsonb(a) order by id) from media_assets a) assets,
      (select count(*) from community_moderation_author_notices) notices,
      (select count(*) from moderation_audit_log) audits`)
    ).rows[0];
  const before = await snapshot();
  for (const id of [...ASSETS, MISSING, COSPLAY_ASSET]) await state(id);
  expect(await snapshot()).toEqual(before);
});
it("catalog: SECURITY DEFINER, postgres owner, fixed search_path, service_role only", async () => {
  const row = (
    await db.query<{
      owner: string;
      secdef: boolean;
      cfg: string[];
      ret: string;
      pub: boolean;
      anon: boolean;
      auth: boolean;
      svc: boolean;
    }>(
      `select pg_get_userbyid(p.proowner) owner,p.prosecdef secdef,p.proconfig cfg,pg_get_function_result(p.oid) ret,
       has_function_privilege('public',p.oid,'EXECUTE') pub,has_function_privilege('anon',p.oid,'EXECUTE') anon,
       has_function_privilege('authenticated',p.oid,'EXECUTE') auth,has_function_privilege('service_role',p.oid,'EXECUTE') svc
       from pg_proc p where p.oid='community_media_delivery_state(uuid)'::regprocedure`,
    )
  ).rows[0];
  expect(row).toMatchObject({ owner: "postgres", secdef: true, ret: "jsonb" });
  expect(row.cfg).toContain("search_path=pg_catalog, public");
  expect({ pub: row.pub, anon: row.anon, auth: row.auth, svc: row.svc }).toEqual({
    pub: false,
    anon: false,
    auth: false,
    svc: true,
  });
});
it("anon and authenticated cannot execute it (runtime check)", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec("savepoint s");
    await db.exec(`set local role ${role}`);
    await expect(
      db.query("select community_media_delivery_state($1)", [ASSETS[0]]),
    ).rejects.toThrow(/permission denied/);
    await db.exec("rollback to savepoint s");
    await db.exec("reset role");
  }
});
