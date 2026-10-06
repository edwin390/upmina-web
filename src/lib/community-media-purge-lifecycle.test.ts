// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  ASSETS,
  ATTACHMENTS,
  POST,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// R4-E1: fundación de BD del purge físico (sin R2, sin red). PGlite es una sola conexión, así que
// la contención real entre dos sesiones NO es reproducible aquí: se prueban las invariantes SQL
// (SKIP LOCKED presente, idempotencia, token por claim) y la concurrencia real queda para Testing.

const migration = (n: string) => readFileSync(`supabase/migrations/${n}`, "utf8");
const E1 = "20261020120000_community_media_purge_lifecycle.sql";
const e1 = migration(E1);
const reporters = [1, 2, 3].map(
  (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`,
);
const COSPLAY_ASSET = "88888888-8888-4888-8888-888888888888";
const MISSING = "99999999-9999-4999-8999-999999999999";
const POST_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const POST_C = "bbbbbbbb-0000-4000-8000-00000000000c";
const ASSET_B = "cccccccc-0000-4000-8000-00000000000b";
const ASSET_C = "cccccccc-0000-4000-8000-00000000000c";
const SECRET_TEXT = "post-body-that-must-not-reach-audit";
const SECRET_MESSAGE = "resolution-message-that-must-not-be-duplicated";
let db: TestDatabase;

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
    E1,
  ])
    await db.exec(migration(n));
  // community_post_delete (owner delete) lives in the 9J-1 foundation; load only that function.
  await db.exec(
    migration("20261004120000_community_posts_media.sql").match(
      /create or replace function public\.community_post_delete\([\s\S]*?\n\$\$;/,
    )![0],
  );
  await db.query("insert into admin_roles values($1,'moderator')", [ACTOR]);
  await db.query("update profiles set username='author_test' where user_id=$1", [ACTOR]);
  for (const id of reporters) await db.query("insert into auth.users values($1)", [id]);
}, 60000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("begin");
  await db.query("update community_posts set text=$1 where id=$2", [SECRET_TEXT, POST]);
  for (const [i, id] of ASSETS.entries())
    await db.query("update media_assets set storage_key=$2 where id=$1", [
      id,
      `community/${id}/w${i === 0 ? 960 : 480}.webp`,
    ]);
});
afterEach(async () => {
  await db.exec("reset role;rollback");
});

async function removeViaDecision(postId = POST) {
  let ctx!: Record<string, unknown>;
  for (const r of reporters)
    ctx = await one(`select community_post_report_submit($1,$2,'spam',null) r`, [
      r,
      postId,
    ]);
  await db.query(
    "select community_moderation_case_decide($1,$2,$3,$4,$5,'content_actioned',$6)",
    [ACTOR, ctx.caseId, ctx.cycleId, ctx.caseVersion, ctx.postVersion, SECRET_MESSAGE],
  );
  return { caseId: ctx.caseId as string, cycleId: ctx.cycleId as string };
}
async function extraRemovedPost(postId: string, assetId: string) {
  await db.query(
    "insert into community_posts(id,author_user_id,text,version) values($1,$2,'extra',2)",
    [postId, ACTOR],
  );
  await db.query(
    "insert into media_assets(id,domain,status,kind,created_by,storage_key) values($1,'community','ready','image',$2,$3)",
    [assetId, ACTOR, `community/${assetId}/w960.webp`],
  );
  await db.query(
    "insert into community_post_media(post_id,asset_id,position) values($1,$2,0)",
    [postId, assetId],
  );
  return removeViaDecision(postId);
}
const deadline = async (id = POST) =>
  (
    await db.query<{ t: string }>(
      "select purge_after::text t from community_posts where id=$1",
      [id],
    )
  ).rows[0].t;

// Seam de reloj de prueba: SOLO sustituye el inicializador/lecturas del reloj en una copia de la
// función de producción dentro de la transacción de prueba (se revierte). Producción no tiene
// parámetro "now": el seam se instala aquí, nunca en la migración.
const installClock = async (name: string, replaceAll = false) => {
  const src = e1.match(
    new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`),
  )![0];
  const seamed = (
    replaceAll
      ? src.replaceAll(
          "clock_timestamp()",
          "current_setting('upmina.test_now')::timestamptz",
        )
      : src.replace(
          "v_now timestamptz := clock_timestamp();",
          "v_now timestamptz := current_setting('upmina.test_now')::timestamptz;",
        )
  ).replace("create function", "create or replace function");
  expect(seamed).not.toBe(src);
  await db.exec(seamed);
};
const setNow = (iso: string, offsetMs: number) =>
  db.query(
    "select set_config('upmina.test_now',($1::timestamptz+$2*interval '1 millisecond')::text,true)",
    [iso, offsetMs],
  );
async function purge(offsetMs = 1, limit = 50) {
  await installClock("community_purge_due_posts");
  await setNow(await deadline(), offsetMs);
  return one<{ purged: number; assetsMarked: number; assetsRetained: number }>(
    "select community_purge_due_posts($1) r",
    [limit],
  );
}
const claim = (limit = 20, lease = 300) =>
  one<{ claimed: { assetId: string; claimToken: string; domain: string }[] }>(
    "select community_asset_gc_claim($1,$2) r",
    [limit, lease],
  );
const statusOf = async (id: string) =>
  (
    await db.query<{ status: string }>("select status from media_assets where id=$1", [
      id,
    ])
  ).rows[0]?.status;

describe("migration structure and privileges", () => {
  const fns = [
    "community_purge_due",
    "community_purge_due_posts",
    "community_asset_gc_claim",
    "community_asset_gc_objects",
    "community_asset_gc_finalize",
    "community_asset_gc_fail",
    "media_gc_backlog",
  ];
  it("each new function exists exactly once (no accidental overloads)", async () => {
    const rows = (
      await db.query<{ proname: string; n: string }>(
        "select proname, count(*)::text n from pg_proc where proname = any($1) group by proname",
        [fns],
      )
    ).rows;
    expect(rows.map((r) => r.proname).sort()).toEqual([...fns].sort());
    expect(rows.every((r) => r.n === "1")).toBe(true);
  });
  it("mutators and readers are postgres-owned SECURITY DEFINER with a pinned search_path", async () => {
    const rows = (
      await db.query<{
        proname: string;
        definer: boolean;
        owner: string;
        cfg: string[] | null;
      }>(
        `select p.proname, p.prosecdef definer, r.rolname owner, p.proconfig cfg
           from pg_proc p join pg_roles r on r.oid = p.proowner where p.proname = any($1)`,
        [fns.filter((f) => f !== "community_purge_due")],
      )
    ).rows;
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.definer).toBe(true);
      expect(r.owner).toBe("postgres");
      expect(r.cfg).toContain("search_path=pg_catalog, public");
    }
  });
  it("EXECUTE is granted to service_role only (not public/anon/authenticated)", async () => {
    const sigs = (
      await db.query<{ sig: string }>(
        "select p.oid::regprocedure::text sig from pg_proc p where p.proname = any($1)",
        [fns],
      )
    ).rows.map((r) => r.sig);
    expect(sigs).toHaveLength(fns.length);
    for (const sig of sigs) {
      for (const role of ["anon", "authenticated"])
        expect(
          (
            await db.query<{ ok: boolean }>(
              "select has_function_privilege($1,$2,'execute') ok",
              [role, sig],
            )
          ).rows[0].ok,
        ).toBe(false);
      expect(
        (
          await db.query<{ ok: boolean }>(
            "select has_function_privilege('service_role',$1,'execute') ok",
            [sig],
          )
        ).rows[0].ok,
      ).toBe(true);
      expect(
        (
          await db.query<{ n: string }>(
            "select count(*)::text n from pg_proc p, aclexplode(p.proacl) a where p.oid = $1::regprocedure and a.grantee = 0",
            [sig],
          )
        ).rows[0].n,
      ).toBe("0");
    }
  });
  it("the purge accepts no caller-supplied time or keys: only a bounded limit", async () => {
    const args = (
      await db.query<{ a: string }>(
        "select pg_get_function_arguments(oid) a from pg_proc where proname='community_purge_due_posts'",
      )
    ).rows[0].a;
    expect(args).toBe("p_limit integer DEFAULT 50");
    expect(e1).toMatch(/for update skip locked/g);
    const claimArgs = (
      await db.query<{ a: string }>(
        "select pg_get_function_arguments(oid) a from pg_proc where proname='community_asset_gc_claim'",
      )
    ).rows[0].a;
    expect(claimArgs).not.toMatch(/key|url|path/i);
  });
  it("invalid arguments are rejected", async () => {
    for (const sql of [
      "select community_purge_due_posts(0)",
      "select community_purge_due_posts(201)",
      "select community_purge_due_posts(null)",
      "select community_asset_gc_claim(0,300)",
      "select community_asset_gc_claim(101,300)",
      "select community_asset_gc_claim(10,29)",
      "select community_asset_gc_claim(10,3601)",
    ]) {
      await db.exec("savepoint s");
      await expect(db.query(sql)).rejects.toThrow(/invalid_argument/);
      await db.exec("rollback to savepoint s");
    }
  });
});

describe("audit constraints", () => {
  const insert = (actor: "human" | "system", target: string, action: string) =>
    db.query(
      `insert into moderation_audit_log(actor_kind,actor_user_id,target_type,target_id,action,metadata)
       values($1,$2,$3,$4,$5,'{}')`,
      [actor, actor === "human" ? ACTOR : null, target, MISSING, action],
    );
  const rejects = async (fn: () => Promise<unknown>) => {
    await db.exec("savepoint s");
    await expect(fn()).rejects.toThrow();
    await db.exec("rollback to savepoint s");
  };
  it("system may record post_purged on a community_post", async () => {
    await expect(
      insert("system", "community_post", "post_purged"),
    ).resolves.toBeDefined();
  });
  it("post_purged is system-only and community_post-only; other system actions stay forbidden", async () => {
    await rejects(() => insert("human", "community_post", "post_purged"));
    await rejects(() => insert("system", "community_moderation_case", "post_purged"));
    await rejects(() => insert("system", "community_post", "content_actioned"));
    await expect(
      insert("system", "community_post", "post_quarantined"),
    ).resolves.toBeDefined();
    await expect(
      insert("human", "community_post", "content_actioned"),
    ).resolves.toBeDefined();
    await rejects(() => insert("human", "community_post", "post_quarantined"));
    await rejects(() => insert("system", "community_post", "unknown_action"));
  });
});

describe("media_assets GC state constraints", () => {
  const set = async (sql: string, params: unknown[] = []) => {
    await db.exec("savepoint s");
    await expect(db.query(sql, params)).rejects.toThrow();
    await db.exec("rollback to savepoint s");
  };
  it("a ready asset cannot carry GC state and attempts cannot be negative", async () => {
    await set("update media_assets set purge_attempts=1 where id=$1", [ASSETS[0]]);
    await set("update media_assets set purge_next_attempt_at=now() where id=$1", [
      ASSETS[0],
    ]);
    await set("update media_assets set purge_last_error_class='x' where id=$1", [
      ASSETS[0],
    ]);
    await set("update media_assets set status='deleting',purge_attempts=-1 where id=$1", [
      ASSETS[0],
    ]);
  });
  it("claim token and lease are set or cleared together; error class is a short token", async () => {
    await set(
      "update media_assets set status='deleting',purge_claim_token=gen_random_uuid() where id=$1",
      [ASSETS[0]],
    );
    await set(
      "update media_assets set status='deleting',purge_lease_until=now() where id=$1",
      [ASSETS[0]],
    );
    await set(
      "update media_assets set status='deleting',purge_last_error_class='Provider says: <xml>' where id=$1",
      [ASSETS[0]],
    );
    await set(
      `update media_assets set status='deleting',purge_last_error_class=repeat('a',41) where id=$1`,
      [ASSETS[0]],
    );
  });
});

describe("post purge transaction", () => {
  it("not due → nothing happens with the real DB clock (purge_after is 72 h away)", async () => {
    await removeViaDecision();
    expect(
      await one<{ purged: number }>("select community_purge_due_posts(50) r"),
    ).toMatchObject({ purged: 0, assetsMarked: 0 });
    expect(await statusOf(ASSETS[0])).toBe("ready");
    expect(
      (await db.query("select 1 from community_posts where id=$1", [POST])).rows,
    ).toHaveLength(1);
  });
  it.each([
    [-1, 0],
    [0, 1],
    [1, 1],
  ])(
    "exact boundary: server_now = purge_after %i ms → purged %i",
    async (offset, expected) => {
      await removeViaDecision();
      expect((await purge(offset)).purged).toBe(expected);
    },
  );
  it("deletes the post, its media rows and marks only its exclusive assets deleting", async () => {
    await removeViaDecision();
    const result = await purge(1);
    expect(result).toMatchObject({ purged: 1, assetsMarked: 3, assetsRetained: 0 });
    expect(
      (await db.query("select 1 from community_posts where id=$1", [POST])).rows,
    ).toHaveLength(0);
    expect(
      (await db.query("select 1 from community_post_media where post_id=$1", [POST]))
        .rows,
    ).toHaveLength(0);
    for (const id of ASSETS.slice(0, 3)) expect(await statusOf(id)).toBe("deleting");
    expect(await statusOf(ASSETS[3])).toBe("ready"); // unattached asset is not part of the post
    expect(ATTACHMENTS).toHaveLength(3);
  });
  it("preserves moderation history and writes a minimal post_purged audit row", async () => {
    const { caseId, cycleId } = await removeViaDecision();
    await purge(1);
    const count = async (sql: string, p: unknown[]) =>
      Number((await db.query<{ n: string }>(sql, p)).rows[0].n);
    expect(
      await count("select count(*)::text n from community_moderation_cases where id=$1", [
        caseId,
      ]),
    ).toBe(1);
    expect(
      await count(
        "select count(*)::text n from community_moderation_cycles where id=$1",
        [cycleId],
      ),
    ).toBe(1);
    expect(
      await count(
        "select count(*)::text n from community_moderation_decisions where cycle_id=$1 and resolution_message=$2",
        [cycleId, SECRET_MESSAGE],
      ),
    ).toBe(1);
    expect(
      await count(
        "select count(*)::text n from community_post_reports where case_id=$1",
        [caseId],
      ),
    ).toBe(3);
    expect(
      await count(
        "select count(*)::text n from moderation_audit_log where action='content_actioned'",
        [],
      ),
    ).toBe(1);
    expect(
      await count(
        "select count(*)::text n from community_moderation_cases where id=$1 and target_author_user_id=$2",
        [caseId, ACTOR],
      ),
    ).toBe(1);
    const audit = (
      await db.query<{
        actor_kind: string;
        actor_user_id: string | null;
        target_type: string;
        target_id: string;
        metadata: Obj;
      }>(
        "select actor_kind,actor_user_id,target_type,target_id,metadata from moderation_audit_log where action='post_purged'",
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_kind: "system",
      actor_user_id: null,
      target_type: "community_post",
      target_id: POST,
    });
    expect(Object.keys(audit[0].metadata).sort()).toEqual([
      "assets_marked",
      "assets_retained",
      "post_id",
      "purged_at",
      "removal_decision_id",
    ]);
    const text = JSON.stringify(audit[0]);
    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toContain(SECRET_MESSAGE);
    expect(text).not.toMatch(/storage|community\/|staging|objects\/|https?:/i);
  });
  it("is idempotent: running again changes nothing and writes no second audit row", async () => {
    await removeViaDecision();
    await purge(1);
    const again = await one<{ purged: number }>("select community_purge_due_posts(50) r");
    expect(again.purged).toBe(0);
    expect(
      (
        await db.query<{ n: string }>(
          "select count(*)::text n from moderation_audit_log where action='post_purged'",
        )
      ).rows[0].n,
    ).toBe("1");
  });
  it("respects the batch limit and orders by purge_after, id", async () => {
    await removeViaDecision(); // POST first
    await extraRemovedPost(POST_B, ASSET_B);
    await extraRemovedPost(POST_C, ASSET_C);
    const order = (
      await db.query<{ id: string }>(
        "select id from community_posts where status='removed_pending_purge' order by purge_after,id",
      )
    ).rows.map((r) => r.id);
    expect(order).toEqual([POST, POST_B, POST_C]);
    await installClock("community_purge_due_posts");
    await setNow(await deadline(POST_C), 1);
    expect(
      (await one<{ purged: number }>("select community_purge_due_posts(2) r")).purged,
    ).toBe(2);
    const left = (
      await db.query<{ id: string }>("select id from community_posts")
    ).rows.map((r) => r.id);
    expect(left).toEqual([POST_C]);
    expect(
      (await one<{ purged: number }>("select community_purge_due_posts(2) r")).purged,
    ).toBe(1);
  });
  it("a post that is not removed_pending_purge is never touched even if purge_after logic could match", async () => {
    await db.exec("update community_posts set status='hidden'");
    await installClock("community_purge_due_posts");
    await db.query(
      "select set_config('upmina.test_now',(now()+interval '30 days')::text,true)",
    );
    expect(
      (await one<{ purged: number }>("select community_purge_due_posts(50) r")).purged,
    ).toBe(0);
    expect(await statusOf(ASSETS[0])).toBe("ready");
  });
});

describe("asset ownership", () => {
  it("an asset belongs to at most one community post (unique asset_id)", async () => {
    await db.query(
      "insert into community_posts(id,author_user_id,text,version) values($1,$2,'b',2)",
      [POST_B, ACTOR],
    );
    await db.exec("savepoint s");
    await expect(
      db.query(
        "insert into community_post_media(post_id,asset_id,position) values($1,$2,0)",
        [POST_B, ASSETS[0]],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
    await db.exec("rollback to savepoint s");
  });
  it("the purge never marks an asset that is also used by Cosplay or belongs to another domain", async () => {
    await db.query(
      "insert into media_assets(id,domain,status,kind,created_by) values($1,'cosplay','ready','image',$2)",
      [COSPLAY_ASSET, ACTOR],
    );
    await db.query(
      "insert into community_post_media(post_id,asset_id,position) values($1,$2,9)",
      [POST, COSPLAY_ASSET],
    );
    await db.query("insert into cosplay_post_images(asset_id) values($1)", [ASSETS[1]]);
    await removeViaDecision();
    const result = await purge(1);
    expect(result).toMatchObject({ purged: 1, assetsMarked: 2, assetsRetained: 2 });
    expect(await statusOf(ASSETS[0])).toBe("deleting");
    expect(await statusOf(ASSETS[1])).toBe("ready"); // also referenced by cosplay_post_images
    expect(await statusOf(ASSETS[2])).toBe("deleting");
    expect(await statusOf(COSPLAY_ASSET)).toBe("ready"); // cosplay domain
  });
});

describe("GC queue: claim, lease, finalize, fail, backlog", () => {
  async function queue() {
    await removeViaDecision();
    await purge(1);
  }
  it("claims only deleting assets and returns ids/metadata, never object keys", async () => {
    await queue();
    const { claimed } = await claim();
    expect(claimed.map((c) => c.assetId).sort()).toEqual([...ASSETS.slice(0, 3)].sort());
    for (const c of claimed) {
      expect(Object.keys(c).sort()).toEqual([
        "assetId",
        "attempts",
        "claimToken",
        "domain",
        "kind",
        "leaseUntil",
      ]);
      expect(c.claimToken).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(await statusOf(ASSETS[3])).toBe("ready");
  });
  it("a live lease blocks a second claim; limit is honoured", async () => {
    await queue();
    expect((await claim(2)).claimed).toHaveLength(2);
    expect((await claim(20)).claimed).toHaveLength(1);
    expect((await claim(20)).claimed).toHaveLength(0);
  });
  it("expired lease is recoverable with a new token; the old token is dead", async () => {
    await queue();
    const [first] = (await claim(1)).claimed;
    await db.query(
      "update media_assets set purge_lease_until = clock_timestamp() - interval '1 second' where id=$1",
      [first.assetId],
    );
    const again = (await claim(20)).claimed.find((c) => c.assetId === first.assetId)!;
    expect(again.claimToken).not.toBe(first.claimToken);
    expect(
      await one("select community_asset_gc_finalize($1,$2) r", [
        first.assetId,
        first.claimToken,
      ]),
    ).toEqual({ result: "invalid_claim" });
    expect(
      await one("select community_asset_gc_fail($1,$2,'x') r", [
        first.assetId,
        first.claimToken,
      ]),
    ).toEqual({ result: "invalid_claim" });
    expect(await statusOf(first.assetId)).toBe("deleting");
    expect(
      await one("select community_asset_gc_finalize($1,$2) r", [
        first.assetId,
        again.claimToken,
      ]),
    ).toEqual({ result: "deleted" });
    expect(await statusOf(first.assetId)).toBeUndefined();
  });
  it("finalize needs the token (random token or ready asset cannot delete) and is idempotent", async () => {
    await queue();
    const [c] = (await claim(1)).claimed;
    expect(
      await one("select community_asset_gc_finalize($1,gen_random_uuid()) r", [
        c.assetId,
      ]),
    ).toEqual({ result: "invalid_claim" });
    expect(
      await one("select community_asset_gc_finalize($1,gen_random_uuid()) r", [
        ASSETS[3],
      ]),
    ).toEqual({ result: "invalid_claim" });
    expect(await statusOf(ASSETS[3])).toBe("ready");
    await db.query(
      "insert into media_asset_variants(asset_id,variant,storage_key) values($1,960,$2)",
      [c.assetId, `community/${c.assetId}/w960.webp`],
    );
    expect(
      await one("select community_asset_gc_finalize($1,$2) r", [c.assetId, c.claimToken]),
    ).toEqual({ result: "deleted" });
    expect(
      (
        await db.query("select 1 from media_asset_variants where asset_id=$1", [
          c.assetId,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(
      await one("select community_asset_gc_finalize($1,$2) r", [c.assetId, c.claimToken]),
    ).toEqual({ result: "already_gone" });
    expect(
      await one("select community_asset_gc_finalize($1,gen_random_uuid()) r", [MISSING]),
    ).toEqual({ result: "already_gone" });
  });
  it("expired lease with an unchanged token can still finalize (R2 deletes are idempotent)", async () => {
    await queue();
    const [c] = (await claim(1)).claimed;
    await db.query(
      "update media_assets set purge_lease_until = clock_timestamp() - interval '1 hour' where id=$1",
      [c.assetId],
    );
    expect(
      await one("select community_asset_gc_finalize($1,$2) r", [c.assetId, c.claimToken]),
    ).toEqual({ result: "deleted" });
  });
  it("a deleting asset still referenced by Cosplay is not deleted: finalize reports blocked and schedules a retry", async () => {
    await db.query(
      "insert into media_assets(id,domain,status,kind,created_by) values($1,'cosplay','deleting','image',$2)",
      [COSPLAY_ASSET, ACTOR],
    );
    await db.query("insert into cosplay_post_images(asset_id) values($1)", [
      COSPLAY_ASSET,
    ]);
    const [c] = (await claim(5)).claimed;
    expect(c).toMatchObject({ assetId: COSPLAY_ASSET, domain: "cosplay" });
    expect(
      await one("select community_asset_gc_finalize($1,$2) r", [c.assetId, c.claimToken]),
    ).toEqual({ result: "blocked" });
    const row = (
      await db.query<{ a: number; e: string }>(
        "select purge_attempts a, purge_last_error_class e from media_assets where id=$1",
        [COSPLAY_ASSET],
      )
    ).rows[0];
    expect(row).toEqual({ a: 1, e: "asset_referenced" });
  });
  it("fail: counts the attempt, clears the lease, sanitises the error and backs off 60 s doubling", async () => {
    await queue();
    const [c] = (await claim(1)).claimed;
    const r = await one<{ result: string; attempts: number }>(
      "select community_asset_gc_fail($1,$2,'r2_timeout') r",
      [c.assetId, c.claimToken],
    );
    expect(r).toMatchObject({ result: "retry_scheduled", attempts: 1 });
    const row = (
      await db.query<{ lease: unknown; token: unknown; err: string; secs: string }>(
        "select purge_lease_until lease, purge_claim_token token, purge_last_error_class err, extract(epoch from (purge_next_attempt_at - clock_timestamp()))::text secs from media_assets where id=$1",
        [c.assetId],
      )
    ).rows[0];
    expect(row.lease).toBeNull();
    expect(row.token).toBeNull();
    expect(row.err).toBe("r2_timeout");
    expect(Number(row.secs)).toBeGreaterThan(55);
    expect(Number(row.secs)).toBeLessThanOrEqual(60);
    // not claimable until next_attempt_at; claimable once it passes
    expect((await claim(20)).claimed.some((x) => x.assetId === c.assetId)).toBe(false);
    await db.query(
      "update media_assets set purge_next_attempt_at = clock_timestamp() where id=$1",
      [c.assetId],
    );
    const second = (await claim(20)).claimed.find((x) => x.assetId === c.assetId)!;
    const r2 = await one<{ attempts: number }>(
      "select community_asset_gc_fail($1,$2,'r2_timeout') r",
      [c.assetId, second.claimToken],
    );
    expect(r2.attempts).toBe(2);
    const secs2 = Number(
      (
        await db.query<{ s: string }>(
          "select extract(epoch from (purge_next_attempt_at - clock_timestamp()))::text s from media_assets where id=$1",
          [c.assetId],
        )
      ).rows[0].s,
    );
    expect(secs2).toBeGreaterThan(115);
    expect(secs2).toBeLessThanOrEqual(120);
  });
  it("never stores provider bodies: anything that is not a short token becomes 'unclassified'", async () => {
    await queue();
    for (const bad of [
      "<Error><Code>X</Code></Error>",
      "A".repeat(80),
      "has space",
      "",
      null,
    ]) {
      await db.query("update media_assets set purge_next_attempt_at=null where id=$1", [
        ASSETS[0],
      ]);
      const [c] = (await claim(1)).claimed;
      await one("select community_asset_gc_fail($1,$2,$3) r", [
        c.assetId,
        c.claimToken,
        bad,
      ]);
      expect(
        (
          await db.query<{ e: string }>(
            "select purge_last_error_class e from media_assets where id=$1",
            [c.assetId],
          )
        ).rows[0].e,
      ).toBe("unclassified");
    }
  });
  it("backoff is capped at 6 h and attempts >= 10 stays retryable (never abandoned)", async () => {
    await queue();
    await db.query("update media_assets set purge_attempts=12 where id=$1", [ASSETS[0]]);
    const [c] = (await claim(1)).claimed;
    const r = await one<{ attempts: number }>(
      "select community_asset_gc_fail($1,$2,'r2_5xx') r",
      [c.assetId, c.claimToken],
    );
    expect(r.attempts).toBe(13);
    const secs = Number(
      (
        await db.query<{ s: string }>(
          "select extract(epoch from (purge_next_attempt_at - clock_timestamp()))::text s from media_assets where id=$1",
          [c.assetId],
        )
      ).rows[0].s,
    );
    expect(secs).toBeGreaterThan(21590);
    expect(secs).toBeLessThanOrEqual(21600);
    await db.query(
      "update media_assets set purge_next_attempt_at=clock_timestamp() where id=$1",
      [c.assetId],
    );
    const again = (await claim(20)).claimed.find((x) => x.assetId === c.assetId);
    expect(again).toBeDefined();
    expect(await statusOf(c.assetId)).toBe("deleting");
  });
  it("backlog reports counts and ages only (no keys, urls or errors)", async () => {
    await queue();
    const [c] = (await claim(1)).claimed;
    await one("select community_asset_gc_fail($1,$2,'r2_5xx') r", [
      c.assetId,
      c.claimToken,
    ]);
    await db.query("update media_assets set purge_attempts=10 where id=$1", [ASSETS[1]]);
    const b = await one<Obj>("select media_gc_backlog() r");
    expect(Object.keys(b).sort()).toEqual([
      "attemptsAtLeast10",
      "deleting",
      "eligibleNow",
      "oldestDeletingAt",
      "oldestEligibleAt",
      "retrying",
      "serverNow",
    ]);
    expect(b).toMatchObject({
      deleting: 3,
      retrying: 2,
      attemptsAtLeast10: 1,
      eligibleNow: 2,
    });
    expect(JSON.stringify(b)).not.toMatch(/community\/|http|r2_5xx|staging/);
    const empty = await (async () => {
      await db.exec(
        "update media_assets set status='ready',purge_claim_token=null,purge_lease_until=null,purge_next_attempt_at=null,purge_last_error_class=null,purge_attempts=0",
      );
      return one<Obj>("select media_gc_backlog() r");
    })();
    expect(empty).toMatchObject({
      deleting: 0,
      eligibleNow: 0,
      retrying: 0,
      attemptsAtLeast10: 0,
      oldestDeletingAt: null,
    });
  });
});

describe("object key derivation contract (no arbitrary keys)", () => {
  const objects = (id: string, token: string) =>
    one<{
      valid: boolean;
      publicKeys: string[];
      privateKeys: string[];
      rejectedKeys: number;
    }>("select community_asset_gc_objects($1,$2) r", [id, token]);
  async function deletingAsset(
    id: string,
    kind: "image" | "video",
    storage: string | null,
  ) {
    await db.query(
      "insert into media_assets(id,domain,status,kind,created_by,storage_key) values($1,'community','deleting',$2,$3,$4)",
      [id, kind, ACTOR, storage],
    );
  }
  const claimOne = async (id: string) =>
    (await claim(100)).claimed.find((c) => c.assetId === id)!;
  it("IMAGE: returns the real variants and a leftover private original", async () => {
    const id = ASSET_B;
    await deletingAsset(id, "image", `community/${id}/w960.webp`);
    for (const w of [480, 960])
      await db.query(
        "insert into media_asset_variants(asset_id,variant,storage_key) values($1,$2,$3)",
        [id, w, `community/${id}/w${w}.webp`],
      );
    await db.query("update media_assets set private_original_key=$2 where id=$1", [
      id,
      `staging/community/${id}/original.png`,
    ]);
    const c = await claimOne(id);
    const o = await objects(id, c.claimToken);
    expect(o).toMatchObject({
      valid: true,
      rejectedKeys: 0,
      privateKeys: [`staging/community/${id}/original.png`],
    });
    expect(o.publicKeys).toEqual([
      `community/${id}/w480.webp`,
      `community/${id}/w960.webp`,
    ]);
  });
  it("VIDEO: the single public object is media_assets.storage_key even without variants", async () => {
    const id = ASSET_C;
    await deletingAsset(id, "video", `community/${id}/original.mp4`);
    const o = await objects(id, (await claimOne(id)).claimToken);
    expect(o).toMatchObject({
      valid: true,
      publicKeys: [`community/${id}/original.mp4`],
      privateKeys: [],
      rejectedKeys: 0,
    });
  });
  it("keys that do not belong to the asset/domain are rejected and never returned", async () => {
    const id = ASSET_B;
    await deletingAsset(id, "image", `community/${ASSET_C}/w960.webp`);
    for (const k of [
      `community/${ASSET_C}/w480.webp`,
      "../secret",
      `community/${id}/../x.webp`,
      `cosplay/${id}/w480.webp`,
      `community/${id}/w123.webp`,
      `community/${id}/w480.webp?x=1`,
    ])
      await db.query(
        "insert into media_asset_variants(asset_id,variant,storage_key) values($1,480,$2)",
        [id, k],
      );
    await db.query("update media_assets set private_original_key=$2 where id=$1", [
      id,
      `objects/community/${ASSET_C}/original.png`,
    ]);
    const o = await objects(id, (await claimOne(id)).claimToken);
    expect(o.publicKeys).toEqual([]);
    expect(o.privateKeys).toEqual([]);
    expect(o.rejectedKeys).toBe(8);
  });
  it("requires a matching token and a live lease", async () => {
    const id = ASSET_B;
    await deletingAsset(id, "image", `community/${id}/w960.webp`);
    const c = await claimOne(id);
    expect(await objects(id, "00000000-0000-4000-8000-000000000000")).toEqual({
      valid: false,
    });
    expect(await objects(MISSING, c.claimToken)).toEqual({ valid: false });
    expect(await one("select community_asset_gc_objects($1,null) r", [id])).toEqual({
      valid: false,
    });
    await db.query(
      "update media_assets set purge_lease_until = clock_timestamp() - interval '1 second' where id=$1",
      [id],
    );
    expect(await objects(id, c.claimToken)).toEqual({ valid: false });
  });
  it("COSPLAY: the generic queue distinguishes the domain and only accepts cosplay-shaped keys", async () => {
    await db.query(
      "insert into media_assets(id,domain,status,kind,created_by,storage_key) values($1,'cosplay','deleting','image',$2,$3)",
      [COSPLAY_ASSET, ACTOR, `cosplay/${COSPLAY_ASSET}/w960.webp`],
    );
    await db.query(
      "insert into media_asset_variants(asset_id,variant,storage_key) values($1,480,$2),($1,960,$3)",
      [
        COSPLAY_ASSET,
        `community/${COSPLAY_ASSET}/w480.webp`,
        `cosplay/${COSPLAY_ASSET}/w480.webp`,
      ],
    );
    const c = await claimOne(COSPLAY_ASSET);
    expect(c.domain).toBe("cosplay");
    const o = await objects(COSPLAY_ASSET, c.claimToken);
    expect(o.publicKeys).toEqual([
      `cosplay/${COSPLAY_ASSET}/w480.webp`,
      `cosplay/${COSPLAY_ASSET}/w960.webp`,
    ]);
    expect(o.rejectedKeys).toBe(1);
  });
});

describe("owner delete converges into the same queue", () => {
  it("community_post_delete marks assets deleting and they are claimable without purge metadata", async () => {
    const r = await one<{ deleted_asset_ids: string[] }>(
      "select community_post_delete($1,$2,2) r",
      [ACTOR, POST],
    );
    expect([...r.deleted_asset_ids].sort()).toEqual([...ASSETS.slice(0, 3)].sort());
    for (const id of ASSETS.slice(0, 3)) expect(await statusOf(id)).toBe("deleting");
    const { claimed } = await claim();
    expect(claimed.map((c) => c.assetId).sort()).toEqual([...ASSETS.slice(0, 3)].sort());
  });
  it("owner delete of a removed_pending_purge post works and leaves nothing for the scheduled purge", async () => {
    await removeViaDecision();
    const v = (
      await db.query<{ version: number }>(
        "select version from community_posts where id=$1",
        [POST],
      )
    ).rows[0].version;
    const dl = await deadline();
    await one("select community_post_delete($1,$2,$3) r", [ACTOR, POST, v]);
    await installClock("community_purge_due_posts");
    await setNow(dl, 1);
    expect(
      (await one<{ purged: number }>("select community_purge_due_posts(50) r")).purged,
    ).toBe(0);
    expect(await statusOf(ASSETS[0])).toBe("deleting");
    expect(
      (
        await db.query<{ n: string }>(
          "select count(*)::text n from community_moderation_decisions",
        )
      ).rows[0].n,
    ).toBe("1");
  });
});

describe("moderator logical expiry (purge_after is the boundary)", () => {
  const read = (cycleId: string, detail: boolean) =>
    one<{
      post: { text: string | null; status: string; purgeAfter: string } | null;
      media: unknown[];
      decision: { resolutionMessage: string } | null;
      reports: unknown[];
    }>("select community_moderation_cycle_read($1,$2) r", [cycleId, detail]);
  async function seam(cycleId: string, offset: number) {
    const src = e1.slice(
      e1.indexOf("create or replace function public.community_moderation_cycle_read"),
    );
    const fn = src.slice(
      0,
      src.indexOf("alter function public.community_moderation_cycle_read"),
    );
    expect(fn).toContain("clock_timestamp()");
    await db.exec(
      fn.replaceAll(
        "clock_timestamp()",
        "current_setting('upmina.test_now')::timestamptz",
      ),
    );
    await setNow(await deadline(), offset);
    return cycleId;
  }
  it.each([
    [-1, true],
    [0, false],
    [1, false],
  ])(
    "offset %i ms: text and media references visible=%s, metadata always",
    async (offset, visible) => {
      const { cycleId } = await removeViaDecision();
      await seam(cycleId, offset);
      for (const detail of [true, false]) {
        const r = await read(cycleId, detail);
        expect(r.post).toMatchObject({ status: "removed_pending_purge" });
        expect(r.post!.purgeAfter).toBeTruthy();
        expect(r.post!.text).toBe(visible ? SECRET_TEXT : null);
        if (detail) expect(r.media).toHaveLength(visible ? 3 : 0);
        expect(r.decision!.resolutionMessage).toBe(SECRET_MESSAGE); // history is untouched
      }
    },
  );
  it("a published or paused post keeps its text for moderators", async () => {
    for (const r of reporters)
      await db.query("select community_post_report_submit($1,$2,'spam',null)", [r, POST]);
    const cycle = (
      await db.query<{ id: string }>("select id from community_moderation_cycles limit 1")
    ).rows[0].id;
    expect((await read(cycle, true)).post!.text).toBe(SECRET_TEXT);
  });
  it("after the purge the post is gone, history remains and post_purged is not listed yet", async () => {
    const { cycleId } = await removeViaDecision();
    await purge(1);
    // restore the production definition (the earlier seam only affected the purge function)
    const r = await one<{
      post: unknown;
      audit: { action: string }[];
      decision: unknown;
      reports: unknown[];
    }>("select community_moderation_cycle_read($1,true) r", [cycleId]);
    expect(r.post).toBeNull();
    expect(r.decision).toBeTruthy();
    expect(r.reports).toHaveLength(3);
    expect(r.audit.length).toBeGreaterThan(0);
    expect(r.audit.map((a) => a.action)).not.toContain("post_purged");
    expect(
      (
        await db.query<{ n: string }>(
          "select count(*)::text n from moderation_audit_log where action='post_purged'",
        )
      ).rows[0].n,
    ).toBe("1");
  });
  it("the shared predicate is a pure comparison: equal is due, null is never due", async () => {
    const due = async (a: string | null, b: string | null) =>
      (
        await db.query<{ r: boolean }>(
          "select community_purge_due($1::timestamptz,$2::timestamptz) r",
          [a, b],
        )
      ).rows[0].r;
    expect(await due("2026-10-05T00:00:00Z", "2026-10-05T00:00:00Z")).toBe(true);
    expect(await due("2026-10-05T00:00:00Z", "2026-10-04T23:59:59.999Z")).toBe(false);
    expect(await due("2026-10-05T00:00:00Z", "2026-10-05T00:00:00.001Z")).toBe(true);
    expect(await due(null, "2026-10-05T00:00:00Z")).toBe(false);
    expect(await due("2026-10-05T00:00:00Z", null)).toBe(false);
  });
});
