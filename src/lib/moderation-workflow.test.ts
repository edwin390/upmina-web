// @vitest-environment node
// Embedded PostgreSQL executes the actual migrations and RPCs. It is not a
// substitute for multi-connection integration in Testing after authorization.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "./community-atomic-save-test-db";

const migration = (name: string) =>
  readFileSync(resolve("supabase/migrations", name), "utf8");
const sql = migration("20261009120000_moderation_workflow_core.sql");
const ACTOR = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const POST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPORT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECOND = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let db: TestDatabase;

describe("9K-2 PostgreSQL workflow", () => {
  beforeAll(async () => {
    const modulePath = process.env.UPMINA_TEST_PGLITE_MODULE;
    if (!modulePath)
      throw new Error("Set UPMINA_TEST_PGLITE_MODULE to temporary PGlite dist/index.js");
    const { PGlite } = await import(/* @vite-ignore */ modulePath);
    db = new PGlite();
    // Real Community table definition, minimal unrelated auth/roles fixture.
    const posts = migration("20261004120000_community_posts_media.sql").match(
      /create table public.community_posts \([\s\S]*?\n\);/,
    )![0];
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key);
      create table public.admin_roles(user_id uuid primary key,role text not null);
      ${posts}
      ${migration("20261007120000_moderation_foundation.sql")}
      ${sql}`);
    await db.query("insert into auth.users values ($1),($2)", [ACTOR, OTHER]);
  }, 30000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    // Clear immutable audit only by resetting fixtures in a rollback transaction.
    await db.exec("begin");
    await db.query("insert into admin_roles values ($1,'moderator'),($2,'moderator')", [
      ACTOR,
      OTHER,
    ]);
    await db.query(
      "insert into community_posts(id,author_user_id,text) values ($1,$2,'Current content')",
      [POST, ACTOR],
    );
    await db.query(
      "insert into community_post_reports(id,reporter_user_id,post_id,reason) values ($1,$3,$4,'spam'),($2,$3,$4,'other')",
      [REPORT, SECOND, OTHER, POST],
    );
  });
  afterEach(async () => {
    await db.exec("rollback");
  });
  async function action(
    name: string,
    reportVersion = 1,
    postVersion: number | null = 1,
    actor = ACTOR,
    report = REPORT,
    note: string | null = null,
  ) {
    // A savepoint models an independent failed request inside the test fixture.
    await db.exec("savepoint request");
    try {
      const result = await db.query<{ result: { status: string; version: number } }>(
        "select community_moderation_action($1,$2,$3,$4,$5,$6) result",
        [actor, report, name, reportVersion, postVersion, note],
      );
      await db.exec("release savepoint request");
      return result.rows[0]!.result;
    } catch (err) {
      await db.exec("rollback to savepoint request; release savepoint request");
      throw err;
    }
  }
  async function state() {
    const posts = (
      await db.query("select status,version,text from community_posts order by id")
    ).rows;
    const reports = (
      await db.query(
        "select id,status,version,resolved_by,resolution_note from community_post_reports order by id",
      )
    ).rows;
    const audit = (
      await db.query(
        "select actor_user_id,action,metadata from moderation_audit_log order by created_at,id",
      )
    ).rows;
    return { posts, reports, audit };
  }
  it.each(["moderator", "developer", "admin"])(
    "%s can hide atomically and audit",
    async (role) => {
      await db.query("update admin_roles set role=$1 where user_id=$2", [role, ACTOR]);
      expect(await action("hide", 1, 1, ACTOR, REPORT, "Reviewed")).toMatchObject({
        status: "resolved",
        version: 2,
      });
      const s = await state();
      expect(s.posts).toEqual([
        { status: "hidden", version: 2, text: "Current content" },
      ]);
      expect(s.reports[0]).toMatchObject({
        status: "resolved",
        version: 2,
        resolved_by: ACTOR,
        resolution_note: "Reviewed",
      });
      expect(s.reports[1]).toMatchObject({ status: "open", version: 1 });
      expect(s.audit).toHaveLength(1);
      expect(s.audit[0]).toMatchObject({
        actor_user_id: ACTOR,
        action: "post_hidden",
        metadata: {
          from_post_status: "published",
          to_post_status: "hidden",
          from_post_version: 1,
          to_post_version: 2,
        },
      });
    },
  );
  it("missing or revoked authority writes nothing", async () => {
    await db.query("delete from admin_roles where user_id=$1", [ACTOR]);
    const before = await state();
    await expect(action("hide")).rejects.toThrow("actor_not_moderator");
    expect(await state()).toEqual(before);
    await db.query("insert into admin_roles values ($1,'user')", [ACTOR]);
    await expect(action("dismiss")).rejects.toThrow("actor_not_moderator");
    expect(await state()).toEqual(before);
  });
  it("restore bumps post version and never reopens any reports", async () => {
    await action("hide");
    await action("restore", 2, 2);
    const s = await state();
    expect(s.posts[0]).toMatchObject({ status: "published", version: 3 });
    expect(s.reports[0]).toMatchObject({ status: "resolved", version: 2 });
    expect(s.reports[1]).toMatchObject({ status: "open", version: 1 });
    expect(s.audit.map((a) => a.action)).toEqual(["post_hidden", "post_restored"]);
  });
  it.each(["dismiss", "resolve", "reviewing"])(
    "%s audits without changing content",
    async (name) => {
      await action(name);
      const s = await state();
      expect(s.posts[0]).toMatchObject({ status: "published", version: 1 });
      expect(s.reports[0]).toMatchObject({
        status:
          name === "dismiss"
            ? "dismissed"
            : name === "resolve"
              ? "resolved"
              : "reviewing",
        version: 2,
      });
      expect(s.audit[0]).toMatchObject({ action: "report_status_changed" });
    },
  );
  it.each(["hide", "dismiss", "resolve", "reviewing"])(
    "replayed %s conflicts without duplicate audit",
    async (name) => {
      await action(name);
      const before = await state();
      await expect(action(name)).rejects.toThrow("report_version_conflict");
      expect(await state()).toEqual(before);
    },
  );
  it("stale restore and already-restored requests conflict", async () => {
    await action("hide");
    await expect(action("restore", 2, 1)).rejects.toThrow("post_version_conflict");
    await action("restore", 2, 2);
    const before = await state();
    await expect(action("restore", 2, 2)).rejects.toThrow("post_version_conflict");
    await expect(action("restore", 2, 3)).rejects.toThrow("post_state_conflict");
    expect(await state()).toEqual(before);
  });
  it("hide versus another moderator's stale hide/dismiss has one winner", async () => {
    await action("hide");
    const before = await state();
    await expect(action("hide", 1, 1, OTHER)).rejects.toThrow("report_version_conflict");
    await expect(action("dismiss", 1, 1, OTHER)).rejects.toThrow(
      "report_version_conflict",
    );
    expect(await state()).toEqual(before);
  });
  it("dismiss winning first prevents stale hide", async () => {
    await action("dismiss", 1, 1, OTHER);
    await expect(action("hide")).rejects.toThrow("report_version_conflict");
    expect((await state()).posts[0]).toMatchObject({ status: "published", version: 1 });
  });
  it("stale independent report action cannot overwrite hidden/restored post", async () => {
    await action("hide");
    await expect(action("dismiss", 1, 1, OTHER, SECOND)).rejects.toThrow(
      "post_version_conflict",
    );
    await action("restore", 2, 2);
    await expect(action("hide", 1, 2, OTHER, SECOND)).rejects.toThrow(
      "post_version_conflict",
    );
  });
  it("post edited after queue load must be reviewed again", async () => {
    await db.query("update community_posts set text='Changed',version=2 where id=$1", [
      POST,
    ]);
    const before = await state();
    await expect(action("hide")).rejects.toThrow("post_version_conflict");
    expect(await state()).toEqual(before);
  });
  it("already hidden, closed report and duplicate reviewing reject safely", async () => {
    await action("hide");
    await expect(action("hide", 1, 2, ACTOR, SECOND)).rejects.toThrow(
      "post_state_conflict",
    );
    await expect(action("dismiss", 2, 2)).rejects.toThrow("report_closed");
    await action("reviewing", 1, 2, ACTOR, SECOND);
    await expect(action("reviewing", 2, 2, ACTOR, SECOND)).rejects.toThrow(
      "report_state_conflict",
    );
  });
  it("deleted post remains resolvable with explicit missing expectation", async () => {
    await db.query("delete from community_posts where id=$1", [POST]);
    await expect(action("dismiss")).rejects.toThrow("post_version_conflict");
    await expect(action("hide", 1, null)).rejects.toThrow("post_not_found");
    await action("dismiss", 1, null);
    expect((await state()).reports[0]).toMatchObject({ status: "dismissed" });
  });
  it("audit insertion failure rolls back post and report together", async () => {
    await db.exec(
      "create function fail_audit() returns trigger language plpgsql as $$ begin raise exception 'fixture_audit_failure'; end; $$; create trigger fixture_failure before insert on moderation_audit_log for each row execute function fail_audit()",
    );
    const before = await state();
    await expect(action("hide")).rejects.toThrow("fixture_audit_failure");
    expect(await state()).toEqual(before);
  });
  it("audit cannot update/delete/truncate and reader is bounded", async () => {
    await action("reviewing");
    for (const statement of [
      "update moderation_audit_log set action='post_hidden'",
      "delete from moderation_audit_log",
      "truncate moderation_audit_log",
    ]) {
      await db.exec("savepoint immutable");
      await expect(db.exec(statement)).rejects.toThrow("moderation_audit_log_immutable");
      await db.exec("rollback to savepoint immutable; release savepoint immutable");
    }
    for (let i = 0; i < 25; i++)
      await db.query(
        "insert into moderation_audit_log(actor_user_id,target_type,target_id,action) values($1,'community_post',$2,'post_hidden')",
        [ACTOR, POST],
      );
    const result = await db.query<{ result: unknown[] }>(
      "select community_moderation_audit($1,$2) result",
      [ACTOR, REPORT],
    );
    expect(result.rows[0]!.result).toHaveLength(20);
  });
  it("RLS/grants/signatures/security pin the trusted boundary", async () => {
    const tables = (
      await db.query(
        "select relrowsecurity,relforcerowsecurity from pg_class where relname in ('community_post_reports','moderation_audit_log')",
      )
    ).rows;
    expect(tables).toEqual([
      { relrowsecurity: true, relforcerowsecurity: true },
      { relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const functions = (
      await db.query(
        "select proname,prosecdef,proconfig,pg_get_function_identity_arguments(oid) args from pg_proc where proname in ('community_moderation_action','community_moderation_audit') order by proname",
      )
    ).rows;
    expect(functions).toHaveLength(2);
    for (const f of functions)
      expect(f).toMatchObject({
        prosecdef: true,
        proconfig: ["search_path=pg_catalog, public"],
      });
    for (const role of ["anon", "authenticated", "service_role"]) {
      const privileges = (
        await db.query<{ allowed: boolean }>(
          "select has_function_privilege($1,'community_moderation_action(uuid,uuid,text,integer,integer,text)','execute') allowed",
          [role],
        )
      ).rows;
      expect(privileges[0]!.allowed).toBe(role === "service_role");
      expect(
        (
          await db.query<{ allowed: boolean }>(
            "select has_table_privilege($1,'moderation_audit_log','select') allowed",
            [role],
          )
        ).rows[0]!.allowed,
      ).toBe(false);
    }
    expect(
      (
        await db.query<{ allowed: boolean }>(
          "select has_function_privilege('service_role','community_post_report_set_status(uuid,uuid,text,text)','execute') allowed",
        )
      ).rows[0]!.allowed,
    ).toBe(false);
    expect(sql).toMatch(/where user_id = p_actor_user_id for share/);
    expect(sql).toMatch(/community_posts where id = v_post_id for update/);
    expect(sql).toMatch(/community_post_reports where id = p_report_id for update/);
  });
  it("API client roles cannot execute or read audit; service RPC still works", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`savepoint denied; set local role ${role}`);
      await expect(
        db.query("select community_moderation_action($1,$2,'hide',1,1,null)", [
          ACTOR,
          REPORT,
        ]),
      ).rejects.toThrow(/permission denied/);
      await db.exec("rollback to savepoint denied; release savepoint denied");
    }
    await db.exec("set local role service_role");
    await db.query("select community_moderation_action($1,$2,'hide',1,1,null)", [
      ACTOR,
      REPORT,
    ]);
    await db.exec("reset role");
    expect((await state()).audit).toHaveLength(1);
    const privileges = (
      await db.query<{ count: number }>(
        "select count(*)::int count from pg_proc p, lateral aclexplode(p.proacl) a where p.proname in ('community_moderation_action','community_moderation_audit') and a.grantee=0 and a.privilege_type='EXECUTE'",
      )
    ).rows;
    expect(privileges[0]!.count).toBe(0);
  });
  it("report version constraint, function owner and queue/audit indexes materialize", async () => {
    await db.exec("savepoint invalid_version");
    await expect(
      db.query("update community_post_reports set version=0 where id=$1", [REPORT]),
    ).rejects.toThrow(/community_post_reports_version_check/);
    await db.exec(
      "rollback to savepoint invalid_version; release savepoint invalid_version",
    );
    const owners = (
      await db.query(
        "select pg_get_userbyid(proowner) owner from pg_proc where proname in ('community_moderation_action','community_moderation_audit')",
      )
    ).rows;
    expect(owners).toEqual([{ owner: "postgres" }, { owner: "postgres" }]);
    expect(
      (
        await db.query(
          "select indexname from pg_indexes where indexname in ('moderation_audit_log_target_created_idx','community_post_reports_status_created_at_idx')",
        )
      ).rows,
    ).toHaveLength(2);
  });
});
