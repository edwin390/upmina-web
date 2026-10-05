// @vitest-environment node
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import {
  createAtomicTestDatabase,
  ACTOR,
  POST,
  type TestDatabase,
} from "./community-atomic-save-test-db";
const migration = (n: string) => readFileSync(`supabase/migrations/${n}`, "utf8");
const current = "20261017120000_community_author_moderation_access.sql";
const flagMigration = "20261018120000_community_author_resolved_notice_flag.sql";
const reporters = [1, 2, 3].map(
  (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`,
);
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
    current,
    flagMigration,
  ])
    await db.exec(migration(n));
  await db.exec(
    migration("20261004120000_community_posts_media.sql").match(
      /create or replace function public\.community_post_delete\([\s\S]*?\n\$\$;/,
    )![0],
  );
  await db.query("insert into admin_roles values($1,'moderator')", [ACTOR]);
  await db.query("update profiles set username='author_test' where user_id=$1", [ACTOR]);
  for (const id of reporters) await db.query("insert into auth.users values($1)", [id]);
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
async function read(id: string | null = POST, actor = ACTOR, entry = true) {
  return (
    await db.query<{
      r: {
        items: {
          id: string;
          status: string;
          resolvedNoticeUnseen: boolean;
          moderation: Record<string, unknown>;
        }[];
        noticeId: string | null;
        serverNow: string;
      };
    }>("select community_author_posts_read($1,$2,$3) r", [actor, id, entry])
  ).rows[0].r;
}
async function report(n = 1) {
  let context!: Record<string, unknown>;
  for (let i = 0; i < n; i++)
    context = (
      await db.query<{ r: Record<string, unknown> }>(
        "select community_post_report_submit($1,$2,'spam',null) r",
        [reporters[i], POST],
      )
    ).rows[0].r;
  return context;
}
async function decision(result = "reports_not_valid") {
  const c = await report(3);
  return (
    await db.query<{ r: Record<string, unknown> }>(
      "select community_moderation_case_decide($1,$2,$3,$4,$5,$6,$7) r",
      [
        ACTOR,
        c.caseId,
        c.cycleId,
        c.caseVersion,
        c.postVersion,
        result,
        result === "content_actioned" ? "<script>alert(1)</script>" : null,
      ],
    )
  ).rows[0].r;
}
it.each([0, 1, 2])(
  "published with %i reports exposes identical normal owner presentation",
  async (n) => {
    if (n) await report(n);
    const r = await read();
    expect(r.items[0]).toMatchObject({
      status: "published",
      moderation: { kind: "none", deadline: null, message: null },
    });
    expect(r.noticeId).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(
      /reporter|reportCount|reason|actor_user_id|storage_key|metadata/,
    );
  },
);
it("HPR owner sees paused projection; non-owner receives no row", async () => {
  await report(3);
  expect((await read()).items[0]).toMatchObject({
    status: "hidden_pending_review",
    moderation: { kind: "paused" },
  });
  expect((await read(POST, reporters[0])).items).toEqual([]);
});
it("hidden preserves list management but never adds private detail access", async () => {
  await db.exec("update community_posts set status='hidden'");
  expect((await read()).items).toEqual([]);
  expect((await read(null)).items[0].status).toBe("hidden");
});
it("missing post never creates phantom content or notice", async () => {
  await db.exec("delete from community_posts");
  expect(await read()).toMatchObject({ items: [], noticeId: null });
});
it("No procede reads never consume; generic/list/other owner reads do not expose notice", async () => {
  await decision();
  const r = await read();
  expect(r.noticeId).not.toBeNull();
  expect((await read()).noticeId).toBe(r.noticeId);
  expect((await read(POST, ACTOR, false)).noticeId).toBeNull();
  expect((await read(null)).noticeId).toBeNull();
  expect((await read(POST, reporters[0])).noticeId).toBeNull();
  expect(
    (await db.query("select seen_at from community_moderation_author_notices")).rows[0]
      .seen_at,
  ).toBeNull();
});
it("ack verifies ownership, is idempotent and modifies only seen_at", async () => {
  await decision();
  const r = await read();
  await db.exec("savepoint unauthorized");
  await expect(
    db.query("select community_author_notice_ack($1,$2,$3)", [
      reporters[0],
      POST,
      r.noticeId,
    ]),
  ).rejects.toThrow("not_found");
  await db.exec("rollback to savepoint unauthorized");
  const before = (
    await db.query(
      "select to_jsonb(n)-'seen_at' as n from community_moderation_author_notices n",
    )
  ).rows;
  await db.exec("set local role service_role");
  await db.query("select community_author_notice_ack($1,$2,$3)", [
    ACTOR,
    POST,
    r.noticeId,
  ]);
  await db.exec("reset role");
  const first = (
    await db.query("select seen_at from community_moderation_author_notices")
  ).rows;
  expect(first[0].seen_at).not.toBeNull();
  await db.exec("set local role service_role");
  await db.query("select community_author_notice_ack($1,$2,$3)", [
    ACTOR,
    POST,
    r.noticeId,
  ]);
  await db.exec("reset role");
  expect(
    (await db.query("select seen_at from community_moderation_author_notices")).rows,
  ).toEqual(first);
  expect(
    (
      await db.query(
        "select to_jsonb(n)-'seen_at' as n from community_moderation_author_notices n",
      )
    ).rows,
  ).toEqual(before);
  expect((await read()).noticeId).toBeNull();
});
it("retained withdrawn detail contains deadline/plain message only for owner", async () => {
  await decision("content_actioned");
  const r = await read();
  expect(r.items[0].moderation).toMatchObject({
    kind: "withdrawn",
    message: "<script>alert(1)</script>",
  });
  expect((await read(POST, reporters[0])).items).toEqual([]);
  expect(r.noticeId).toBeNull();
});
it.each([-1, 0, 1])(
  "DB expiry predicate at deadline offset %i milliseconds",
  async (offset) => {
    await decision("content_actioned");
    const deadline = (
      await db.query<{ t: string }>("select purge_after::text t from community_posts")
    ).rows[0].t;
    // Local clock seam replaces only the initializer, not the production predicate or input contract.
    const readSql = migration(flagMigration)
      .split("alter function public.community_author_posts_read")[0]
      .replace("create function", "create or replace function")
      .replace("clock_timestamp()", "current_setting('upmina.test_now')::timestamptz");
    await db.exec(readSql);
    await db.query(
      "select set_config('upmina.test_now',($1::timestamptz+$2*interval '1 millisecond')::text,true)",
      [deadline, offset],
    );
    expect((await read()).items.length).toBe(offset < 0 ? 1 : 0);
    expect((await read(null)).items.length).toBe(offset < 0 ? 1 : 0);
    expect(
      (await db.query("select count(*)::int n from community_posts")).rows[0].n,
    ).toBe(1);
  },
);
it.each(["hidden_pending_review", "removed_pending_purge"])(
  "controlled own delete preserves moderation history from %s",
  async (state) => {
    if (state === "hidden_pending_review") await report(3);
    else await decision("content_actioned");
    const v = (await db.query<{ version: number }>("select version from community_posts"))
      .rows[0].version;
    await db.exec("set local role service_role");
    await db.query("select community_post_delete($1,$2,$3)", [ACTOR, POST, v]);
    expect((await read()).items).toEqual([]);
    await db.exec("reset role");
    expect(
      (await db.query("select count(*)::int n from community_moderation_cases")).rows[0]
        .n,
    ).toBe(1);
  },
);
it("entrypoints closed to browsers; direct DML remains revoked", async () => {
  const rows = (
    await db.query(
      `select rol,has_function_privilege(rol,'community_author_posts_read(uuid,uuid,boolean)','EXECUTE') r,has_function_privilege(rol,'community_author_notice_ack(uuid,uuid,uuid)','EXECUTE') a from (values ('anon'),('authenticated'),('service_role')) t(rol)`,
    )
  ).rows;
  expect(rows).toEqual([
    { rol: "anon", r: false, a: false },
    { rol: "authenticated", r: false, a: false },
    { rol: "service_role", r: true, a: true },
  ]);
  expect(
    (
      await db.query(
        "select has_table_privilege('service_role','community_posts','UPDATE') p,has_table_privilege('service_role','community_post_media','DELETE') m,has_table_privilege('service_role','community_moderation_author_notices','UPDATE') n",
      )
    ).rows[0],
  ).toEqual({ p: false, m: false, n: false });
});

async function noticeRows() {
  return (
    await db.query(
      "select to_jsonb(n) as n from community_moderation_author_notices n order by id",
    )
  ).rows;
}
async function ackFirst() {
  const r = await read();
  await db.exec("set local role service_role");
  await db.query("select community_author_notice_ack($1,$2,$3)", [
    ACTOR,
    POST,
    r.noticeId,
  ]);
  await db.exec("reset role");
}
it.each([0, 1, 2])(
  "resolvedNoticeUnseen is false for a published post with %i reports",
  async (n) => {
    if (n) await report(n);
    expect((await read(null)).items[0].resolvedNoticeUnseen).toBe(false);
  },
);
it("unseen reports_not_valid notice: list flag true, list noticeId stays null, detail keeps noticeId", async () => {
  await decision();
  const list = await read(null);
  expect(list.items[0]).toMatchObject({
    status: "published",
    resolvedNoticeUnseen: true,
  });
  expect(list.noticeId).toBeNull();
  expect(JSON.stringify(list)).not.toMatch(/notice_id|decision_id|seen_at/);
  const detail = await read();
  expect(detail.noticeId).not.toBeNull();
  expect(detail.items[0].resolvedNoticeUnseen).toBe(true);
});
it("list reads never mutate or consume the notice", async () => {
  await decision();
  const before = await noticeRows();
  await read(null);
  await read(null, ACTOR, false);
  await read(POST, ACTOR, false);
  expect(await noticeRows()).toEqual(before);
  expect((await read(null)).items[0].resolvedNoticeUnseen).toBe(true);
});
it("a seen notice no longer projects the flag", async () => {
  await decision();
  await ackFirst();
  expect((await read(null)).items[0].resolvedNoticeUnseen).toBe(false);
  expect((await read()).noticeId).toBeNull();
});
it("removed_pending_purge and hidden_pending_review never project the flag", async () => {
  await report(3);
  expect((await read(null)).items[0]).toMatchObject({
    status: "hidden_pending_review",
    resolvedNoticeUnseen: false,
  });
  await db.exec("rollback;begin");
  await decision("content_actioned");
  expect((await read(null)).items[0]).toMatchObject({
    status: "removed_pending_purge",
    resolvedNoticeUnseen: false,
  });
});
it("flag requires the post to be currently published even with an unseen notice", async () => {
  await decision();
  await db.exec("update community_posts set status='hidden'");
  expect((await read(null)).items[0]).toMatchObject({
    status: "hidden",
    resolvedNoticeUnseen: false,
  });
});
it("a different user cannot obtain the private flag for the owner's post", async () => {
  await decision();
  expect((await read(null, reporters[0])).items).toEqual([]);
  expect((await read(POST, reporters[0])).items).toEqual([]);
  expect((await read(POST, reporters[0])).noticeId).toBeNull();
});
it("historical seen notices never revive; only the current unseen notice projects true", async () => {
  await decision();
  await ackFirst();
  expect((await read(null)).items[0].resolvedNoticeUnseen).toBe(false);
  await decision();
  expect((await noticeRows()).length).toBe(2);
  expect((await read(null)).items[0].resolvedNoticeUnseen).toBe(true);
  await ackFirst();
  expect((await read(null)).items[0].resolvedNoticeUnseen).toBe(false);
});
it("installed read function keeps definer/owner/search_path/ACL after the flag migration", async () => {
  const row = (
    await db.query<{
      owner: string;
      secdef: boolean;
      cfg: string[];
      pub: boolean;
      anon: boolean;
      auth: boolean;
      svc: boolean;
    }>(
      `select pg_get_userbyid(p.proowner) owner,p.prosecdef secdef,p.proconfig cfg,
       has_function_privilege('public',p.oid,'EXECUTE') pub,has_function_privilege('anon',p.oid,'EXECUTE') anon,
       has_function_privilege('authenticated',p.oid,'EXECUTE') auth,has_function_privilege('service_role',p.oid,'EXECUTE') svc
       from pg_proc p where p.oid='community_author_posts_read(uuid,uuid,boolean)'::regprocedure`,
    )
  ).rows[0];
  expect(row).toMatchObject({
    secdef: true,
    pub: false,
    anon: false,
    auth: false,
    svc: true,
  });
  expect(row.cfg).toContain("search_path=pg_catalog, public");
  expect(row.owner).toBe("postgres");
});
