// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";

// R5-C: la restricción de strikes (R5-B) se aplica en los escritores REALES de publicación de
// Community. SQL real (migraciones hasta 20261024) sobre PGlite; el reloj de las funciones de strike
// se sustituye por un seam SOLO dentro de la transacción de prueba. PGlite es de una sola conexión:
// la concurrencia real (apply vs create/edit, revoke vs create) queda para el smoke de Testing R5-F.

const migration = (n: string) =>
  readFileSync(`supabase/migrations/${n}`, "utf8").replace(/\r\n/g, "\n");
const R5B = migration("20261023120000_community_strikes_foundation.sql");
const R5C = migration("20261024120000_community_strike_write_enforcement.sql");
const R4 = migration("20261015120000_moderation_grouped_decision_core.sql");
const uid = (n: number) => `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MOD = uid(1);
const DEV = uid(3);
const reporters = [11, 12, 13].map(uid);
const OTHER = uid(50); // another author
const AUTHOR = ACTOR;
const REASON = "Motivo humano del strike.";
let db: TestDatabase;
let seq = 0;
let assetSeq = 0;

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
    "20261020120000_community_media_purge_lifecycle.sql",
    "20261022120000_moderation_purged_history_read.sql",
    "20261023120000_community_strikes_foundation.sql",
    "20261024120000_community_strike_write_enforcement.sql",
  ])
    await db.exec(migration(n));
  await db.exec(
    migration("20261004120000_community_posts_media.sql").match(
      /create or replace function public\.community_post_delete\([\s\S]*?\n\$\$;/,
    )![0],
  );
  await db.query("insert into admin_roles values($1,'moderator'),($2,'developer')", [
    MOD,
    DEV,
  ]);
  for (const id of [MOD, DEV, OTHER, ...reporters])
    await db.query("insert into auth.users values($1) on conflict do nothing", [id]);
  await db.query("insert into profiles(user_id) values($1) on conflict do nothing", [
    OTHER,
  ]);
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
    /* aborted transaction */
  }
  await db.exec("rollback");
});

const setNow = (iso: string) =>
  db.query("select set_config('upmina.test_now', $1, true)", [iso]);
/** R5-B strike functions with ONLY the clock replaced (rolled back with the test). */
async function setupClock(iso: string) {
  for (const name of [
    "community_strike_apply",
    "community_strike_revoke",
    "community_author_restriction",
  ]) {
    const src = R5B.match(
      new RegExp(`create function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`),
    )![0];
    await db.exec(
      src
        .replace("create function", "create or replace function")
        .replaceAll(
          "clock_timestamp()",
          "current_setting('upmina.test_now')::timestamptz",
        ),
    );
  }
  await setNow(iso);
}

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
  return { post, decisionId: d.decisionId };
}
const strike = async (actor = MOD) =>
  one<{ strikeId: string; level: number }>(
    "select community_strike_apply($1,$2,$3,null) r",
    [actor, (await decision()).decisionId, REASON],
  );
const revokeStrike = (id: string) =>
  db.query("select community_strike_revoke($1,$2,'revocación')", [DEV, id]);

async function asset() {
  const id = uid(5000 + ++assetSeq);
  await db.query(
    "insert into media_assets(id,domain,kind,status,created_by) values($1,'community','image','ready',$2)",
    [id, AUTHOR],
  );
  return id;
}
const media = (...ids: string[]) =>
  JSON.stringify(ids.map((a, i) => ({ asset_id: a, position: i })));
async function makePost(n = 2) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await asset());
  const r = await one<{ post: { id: string; version: number } }>(
    "select community_post_save($1,null,null,'Texto original',$2::jsonb) r",
    [AUTHOR, media(...ids)],
  );
  return { postId: r.post.id, version: r.post.version, assets: ids };
}
const state = async (postId: string) => ({
  post: (
    await db.query(
      "select text, version, status, updated_at from community_posts where id=$1",
      [postId],
    )
  ).rows,
  media: (
    await db.query(
      "select id, asset_id, position from community_post_media where post_id=$1 order by id",
      [postId],
    )
  ).rows,
  assets: (await db.query("select id, status from media_assets order by id")).rows,
  audit: (await db.query("select count(*)::int n from moderation_audit_log")).rows,
  posts: (await db.query("select count(*)::int n from community_posts")).rows,
});
async function fails(sql: string, params: unknown[], code: string | RegExp) {
  await db.exec("savepoint s");
  let message = "";
  try {
    await db.query(sql, params);
  } catch (e) {
    message = String((e as Error).message);
  }
  await db.exec("rollback to savepoint s");
  expect(message).not.toBe("");
  expect(message).toMatch(code);
  return message;
}
const create = (text = "Nuevo") =>
  db.query("select community_post_save($1,null,null,$2,'[]'::jsonb) r", [AUTHOR, text]);
const failCreate = () =>
  fails(
    "select community_post_save($1,null,null,'Nuevo','[]'::jsonb)",
    [AUTHOR],
    /^.*author_restricted/,
  );
const postCount = async () =>
  Number(
    (await db.query<{ n: string }>("select count(*) n from community_posts")).rows[0].n,
  );

describe("CREATE", () => {
  it("no strike: allowed", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    await create();
  });
  it("Strike 1 active → blocked, nothing inserted", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    await strike();
    const before = await postCount();
    await failCreate();
    expect(await postCount()).toBe(before);
  });
  it("Strike 2 active → blocked (level 1 already over)", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    await strike();
    await setNow("2026-03-20T00:00:00Z");
    await strike();
    await setNow("2026-03-21T00:00:00Z");
    expect(
      (
        await one<{ level: number }>("select community_author_restriction($1) r", [
          AUTHOR,
        ])
      ).level,
    ).toBe(2);
    await failCreate();
  });
  it("Strike 3 → blocked forever", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    await strike();
    await strike();
    await strike();
    await setNow("2040-01-01T00:00:00Z");
    await failCreate();
  });
  it("expired temporary strike → allowed (exact boundary: now < ends blocks, now >= ends allows)", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    await strike(); // ends 2026-03-15T00:00:00Z
    await setNow("2026-03-14T23:59:59.999Z");
    await failCreate();
    await setNow("2026-03-15T00:00:00Z");
    await create();
  });
  it("revoked strike → allowed", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    const s = await strike();
    await failCreate();
    await revokeStrike(s.strikeId);
    await create();
  });
});

describe("EDIT (community_post_save)", () => {
  it("active strike blocks edit; text/version/media unchanged; expired and revoked allow it", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    const p = await makePost(1);
    const s = await strike();
    const before = await state(p.postId);
    await fails(
      "select community_post_save($1,$2,$3,'Editado',$4::jsonb)",
      [AUTHOR, p.postId, p.version, media(...p.assets)],
      /author_restricted/,
    );
    expect(await state(p.postId)).toEqual(before);
    await setNow("2026-03-15T00:00:00Z"); // expired
    const ok = await one<{ post: { version: number; text: string } }>(
      "select community_post_save($1,$2,$3,'Editado',$4::jsonb) r",
      [AUTHOR, p.postId, p.version, media(...p.assets)],
    );
    expect(ok.post).toMatchObject({ text: "Editado", version: p.version + 1 });
    // revoked variant
    await setNow("2026-04-01T00:00:00Z");
    const s2 = await strike();
    await fails(
      "select community_post_save($1,$2,$3,'Otra',$4::jsonb)",
      [AUTHOR, p.postId, p.version + 1, media(...p.assets)],
      /author_restricted/,
    );
    await revokeStrike(s2.strikeId);
    await db.query("select community_post_save($1,$2,$3,'Otra',$4::jsonb)", [
      AUTHOR,
      p.postId,
      p.version + 1,
      media(...p.assets),
    ]);
    expect(s.level).toBe(1);
  });
  it("strike restriction is ADDITIVE: moderation states stay non-editable without a strike", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    const hidden = await makePost(1);
    await db.query("update community_posts set status='hidden' where id=$1", [
      hidden.postId,
    ]);
    await fails(
      "select community_post_save($1,$2,$3,'x',$4::jsonb)",
      [AUTHOR, hidden.postId, hidden.version, media(...hidden.assets)],
      /post_not_editable/,
    );
    // a REAL removed_pending_purge post (produced by a Procede decision)
    const removed = await decision();
    const v = (
      await db.query<{ version: number }>(
        "select version from community_posts where id=$1",
        [removed.post],
      )
    ).rows[0].version;
    await fails(
      "select community_post_save($1,$2,$3,'x','[]'::jsonb)",
      [AUTHOR, removed.post, v],
      /post_not_editable/,
    );
  });
  it("a hidden_pending_review post stays blocked by the existing rule (no strike)", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    const d = await decision(); // closed case; reuse a fresh post for the HPR state
    expect(d.post).toBeTruthy();
    const p = await makePost(1);
    const cycle = uid(9000 + ++seq);
    // quarantine attribution needs a real cycle: open one through reports
    let ctx!: Obj;
    for (const r of reporters)
      ctx = await one<Obj>("select community_post_report_submit($1,$2,'spam',null) r", [
        r,
        p.postId,
      ]);
    expect(cycle).toBeTruthy();
    expect(
      (
        await db.query<{ status: string }>(
          "select status from community_posts where id=$1",
          [p.postId],
        )
      ).rows[0].status,
    ).toBe("hidden_pending_review");
    await fails(
      "select community_post_save($1,$2,$3,'x',$4::jsonb)",
      [AUTHOR, p.postId, Number(ctx.postVersion), media(...p.assets)],
      /post_not_editable/,
    );
  });
  it("with a strike AND a non-editable state the strike error wins (guard runs first, no information leak change)", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    const p = await makePost(1);
    await strike();
    await db.query("update community_posts set status='hidden' where id=$1", [p.postId]);
    await fails(
      "select community_post_save($1,$2,$3,'x',$4::jsonb)",
      [AUTHOR, p.postId, p.version, media(...p.assets)],
      /author_restricted/,
    );
  });
  it("another author with no strike is unaffected", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    await strike();
    await db.query(
      "select community_post_save($1,null,null,'de otro autor','[]'::jsonb)",
      [OTHER],
    );
  });
});

describe("ATOMIC save (independent authoritative writer)", () => {
  it("active strike blocks it; NO media is removed and no asset leaves 'ready'", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    const p = await makePost(2);
    const removed = (
      await db.query<{ id: string }>(
        "select id from community_post_media where post_id=$1 order by position limit 1",
        [p.postId],
      )
    ).rows[0].id;
    await strike();
    const before = await state(p.postId);
    await fails(
      "select community_post_save_atomic($1,$2,$3,'Editado',$4::jsonb,$5::uuid[])",
      [AUTHOR, p.postId, p.version, media(p.assets[1]), `{${removed}}`],
      /author_restricted/,
    );
    expect(await state(p.postId)).toEqual(before);
  });
  it("create through the atomic wrapper is blocked too; expired allows the full removal flow", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    const p = await makePost(2);
    await strike();
    await fails(
      "select community_post_save_atomic($1,null,null,'n','[]'::jsonb,'{}'::uuid[])",
      [AUTHOR],
      /author_restricted/,
    );
    await setNow("2026-03-15T00:00:00Z");
    const removed = (
      await db.query<{ id: string }>(
        "select id from community_post_media where post_id=$1 order by position limit 1",
        [p.postId],
      )
    ).rows[0].id;
    const r = await one<{ cleanup_asset_ids: string[] }>(
      "select community_post_save_atomic($1,$2,$3,'Editado',$4::jsonb,$5::uuid[]) r",
      [AUTHOR, p.postId, p.version, media(p.assets[1]), `{${removed}}`],
    );
    expect(r.cleanup_asset_ids).toHaveLength(1);
  });
  it("a direct service_role invocation is also rejected (no frontend, no HTTP, no precheck)", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    const p = await makePost(1);
    await strike();
    await db.exec("set role service_role");
    await fails(
      "select community_post_save_atomic($1,$2,$3,'x',$4::jsonb,'{}'::uuid[])",
      [AUTHOR, p.postId, p.version, media(...p.assets)],
      /author_restricted/,
    );
    await fails(
      "select community_post_save($1,null,null,'x','[]'::jsonb)",
      [AUTHOR],
      /author_restricted/,
    );
  });
});

describe("REORDER and DETACH", () => {
  it("reorder is blocked: positions and version unchanged; allowed after expiry", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    const p = await makePost(2);
    const mids = (
      await db.query<{ id: string }>(
        "select id from community_post_media where post_id=$1 order by position",
        [p.postId],
      )
    ).rows.map((r) => r.id);
    const swap = JSON.stringify([
      { media_id: mids[0], position: 1 },
      { media_id: mids[1], position: 0 },
    ]);
    await strike();
    const before = await state(p.postId);
    await fails(
      "select community_post_reorder_media($1,$2,$3,$4::jsonb)",
      [AUTHOR, p.postId, p.version, swap],
      /author_restricted/,
    );
    expect(await state(p.postId)).toEqual(before);
    await setNow("2026-03-15T00:00:00Z");
    await db.query("select community_post_reorder_media($1,$2,$3,$4::jsonb)", [
      AUTHOR,
      p.postId,
      p.version,
      swap,
    ]);
  });
  it("detach is blocked: media row, asset status and version unchanged; allowed after revocation", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    const p = await makePost(2);
    const mid = (
      await db.query<{ id: string }>(
        "select id from community_post_media where post_id=$1 order by position limit 1",
        [p.postId],
      )
    ).rows[0].id;
    const s = await strike();
    const before = await state(p.postId);
    await fails(
      "select community_post_detach_media($1,$2,$3,$4)",
      [AUTHOR, p.postId, p.version, mid],
      /author_restricted/,
    );
    expect(await state(p.postId)).toEqual(before);
    await revokeStrike(s.strikeId);
    await db.query("select community_post_detach_media($1,$2,$3,$4)", [
      AUTHOR,
      p.postId,
      p.version,
      mid,
    ]);
    expect(
      (await db.query("select 1 from community_post_media where id=$1", [mid])).rows,
    ).toHaveLength(0);
  });
});

describe("OWN DELETE stays allowed at every level", () => {
  it.each([1, 2, 3])(
    "strike level %i active → the author can delete their own post",
    async (level) => {
      await setupClock("2026-03-01T00:00:00Z");
      const p = await makePost(1);
      for (let i = 0; i < level; i++) {
        await setNow(`2026-03-0${i + 1}T00:00:00Z`);
        await strike();
      }
      expect(
        (
          await one<{ restricted: boolean }>(
            "select community_author_restriction($1) r",
            [AUTHOR],
          )
        ).restricted,
      ).toBe(true);
      await db.query("select community_post_delete($1,$2,$3)", [
        AUTHOR,
        p.postId,
        p.version,
      ]);
      expect(
        (await db.query("select 1 from community_posts where id=$1", [p.postId])).rows,
      ).toHaveLength(0);
    },
  );
  it("the delete function does not carry the guard (static)", () => {
    const fn = migration("20261004120000_community_posts_media.sql").match(
      /create or replace function public\.community_post_delete\([\s\S]*?\n\$\$;/,
    )![0];
    expect(fn).not.toMatch(/author_restricted|community_assert_author_may_write/);
    expect(R5C).not.toMatch(/function public\.community_post_delete/);
  });
});

describe("multiple strikes: deterministic selection", () => {
  it("expired old + active newer → blocked", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    await strike();
    await setNow("2026-03-20T00:00:00Z");
    await strike();
    await setNow("2026-03-25T00:00:00Z");
    await failCreate();
  });
  it("revoked newest + active older → blocked; once the older one expires → allowed", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    await strike();
    await setNow("2026-03-02T00:00:00Z");
    const newest = await strike();
    await setNow("2026-03-03T00:00:00Z");
    await revokeStrike(newest.strikeId);
    await failCreate();
    await setNow("2026-03-15T00:00:00Z");
    await create();
  });
  it("all non-revoked temporary strikes expired → allowed", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    await strike();
    await setNow("2026-03-02T00:00:00Z");
    await strike();
    await setNow("2026-06-01T00:00:00Z");
    await create();
  });
  it("a still-active strike remains after revoking another one → blocked", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    const a = await strike();
    await setNow("2026-03-02T00:00:00Z");
    await strike();
    await revokeStrike(a.strikeId);
    await failCreate();
  });
});

describe("error contract and privacy at the DB layer", () => {
  it("the SQL error is the bare business code: no level, deadline, reason or ids", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    await strike();
    const msg = await fails(
      "select community_post_save($1,null,null,'x','[]'::jsonb)",
      [AUTHOR],
      /author_restricted/,
    );
    expect(msg).not.toMatch(/Motivo|2026|level|[0-9a-f]{8}-[0-9a-f]{4}/);
  });
  it("the authoritative read exposes only approved fields", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    await strike();
    const r = await one<Obj>("select community_author_restriction($1) r", [AUTHOR]);
    expect(Object.keys(r).sort()).toEqual([
      "endsAt",
      "level",
      "permanent",
      "reason",
      "restricted",
      "serverNow",
    ]);
    expect(JSON.stringify(r)).not.toContain(MOD);
  });
});

describe("other surfaces stay allowed (behavioral + static)", () => {
  it("a sanctioned user can still REPORT another author's post", async () => {
    await setupClock("2026-03-01T00:00:00Z");
    await strike();
    const post = uid(2000 + ++seq);
    await db.query(
      "insert into community_posts(id,author_user_id,text,version) values($1,$2,'ajeno',2)",
      [post, OTHER],
    );
    await db.query("insert into auth.users values($1) on conflict do nothing", [AUTHOR]);
    const r = await one<Obj>("select community_post_report_submit($1,$2,'spam',null) r", [
      AUTHOR,
      post,
    ]);
    expect(r).toBeTruthy();
  });
  it("the migration touches only the four publishing writers plus its helper", () => {
    const names = [
      ...R5C.matchAll(/create (?:or replace )?function public\.([a-z_]+)\(/g),
    ]
      .map((m) => m[1])
      .sort();
    expect(names).toEqual([
      "community_assert_author_may_write",
      "community_post_detach_media",
      "community_post_reorder_media",
      "community_post_save",
      "community_post_save_atomic",
    ]);
    const exec = R5C.replace(/--.*$/gm, "");
    for (const forbidden of [
      "community_post_set_like",
      "community_post_report_submit",
      "community_post_delete",
      "community_purge_due_posts",
      "community_asset_gc",
      "community_media_purge_tick",
      "community_moderation_case_decide",
      "community_moderation_cycle_read",
      "cosplay_admin_",
      "update public.profiles",
    ])
      expect(exec).not.toContain(forbidden);
  });
  it("likes, reports, profile and Cosplay writers carry no guard", () => {
    const likes = migration("20261005120000_community_post_likes.sql");
    const cosplay = migration("20261002120000_cosplay_editor_foundation.sql");
    const reports = migration("20261011120000_community_report_submission.sql");
    for (const m of [likes, cosplay, reports])
      expect(m).not.toMatch(/author_restricted|community_assert_author_may_write/);
    expect(readFileSync("api/profile.ts", "utf8")).not.toMatch(/restriction|strike/i);
  });
});

describe("migration structure and canonical lock order", () => {
  const body = (src: string, name: string) =>
    src.match(
      new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`),
    )![0];
  const GUARD_BLOCK =
    /[ ]{2}-- R5-C:[^\n]*\n(?:[ ]{2}--[^\n]*\n)*[ ]{2}perform public\.community_assert_author_may_write\(p_actor_user_id\);\n\n?/;
  it.each([
    "community_post_save",
    "community_post_save_atomic",
    "community_post_reorder_media",
    "community_post_detach_media",
  ])("%s equals its 20261015 definition plus ONLY the guard", (name) => {
    const patched = body(R5C, name);
    expect(patched.match(GUARD_BLOCK)).toHaveLength(1);
    expect(patched.replace(GUARD_BLOCK, "")).toBe(body(R4, name));
  });
  it.each([
    [
      "community_post_save",
      "if not exists (select 1 from public.profiles where user_id = p_actor_user_id)",
    ],
    [
      "community_post_save_atomic",
      "from public.community_posts where id = p_post_id for update",
    ],
    [
      "community_post_reorder_media",
      "from public.community_posts where id = p_post_id for update",
    ],
    [
      "community_post_detach_media",
      "from public.community_posts where id = p_post_id for update",
    ],
  ])(
    "%s takes the profile lock/guard BEFORE any post lock or mutation",
    (name, later) => {
      const f = body(R5C, name);
      const g = f.indexOf("perform public.community_assert_author_may_write");
      expect(g).toBeGreaterThan(-1);
      expect(g).toBeLessThan(f.indexOf(later));
      for (const mutation of [
        "insert into public.community_posts",
        "update public.community_posts",
        "delete from public.community_post_media",
        "update public.community_post_media",
        "insert into public.community_post_media",
        "update public.media_assets",
      ])
        if (f.includes(mutation)) expect(g).toBeLessThan(f.indexOf(mutation));
      expect(f.indexOf("for update")).toBeGreaterThan(g); // the first row lock of the function comes after the guard
    },
  );
  it("the helper locks profiles FOR SHARE first and reads the R5-B restriction after the lock", () => {
    const h = body(
      R5C.replace("create function", "create or replace function"),
      "community_assert_author_may_write",
    );
    expect(
      h.indexOf("from public.profiles where user_id = p_user_id for share"),
    ).toBeLessThan(h.indexOf("community_author_restriction"));
    expect(h).toContain("raise exception 'author_restricted'");
  });
  it("R5-B lock mode (NO KEY UPDATE) conflicts with the writers' FOR SHARE: apply/revoke serialize with writes", () => {
    expect(R5B).toMatch(/profiles where user_id = v_author for no key update/);
    expect(R5B).toMatch(/profiles where user_id = v_user for no key update/);
    expect(R5C).toMatch(/profiles where user_id = p_user_id for share/);
  });
  it("ACL: helper is not executable by API roles; writers keep EXECUTE for service_role only", async () => {
    for (const role of ["anon", "authenticated", "service_role"])
      expect(
        (
          await db.query<{ ok: boolean }>(
            "select has_function_privilege($1,'public.community_assert_author_may_write(uuid)','execute') ok",
            [role],
          )
        ).rows[0].ok,
      ).toBe(false);
    for (const sig of [
      "community_post_save(uuid,uuid,integer,text,jsonb)",
      "community_post_save_atomic(uuid,uuid,integer,text,jsonb,uuid[])",
      "community_post_reorder_media(uuid,uuid,integer,jsonb)",
      "community_post_detach_media(uuid,uuid,integer,uuid)",
    ]) {
      expect(
        (
          await db.query<{ ok: boolean }>(
            "select has_function_privilege('service_role',$1,'execute') ok",
            [`public.${sig}`],
          )
        ).rows[0].ok,
      ).toBe(true);
      for (const role of ["anon", "authenticated"])
        expect(
          (
            await db.query<{ ok: boolean }>(
              "select has_function_privilege($1,$2,'execute') ok",
              [role, `public.${sig}`],
            )
          ).rows[0].ok,
        ).toBe(false);
    }
  });
  it("PGlite is single-session: real concurrency belongs to the Testing smoke (R5-F)", () => {
    // Documented limitation: apply/create, apply/edit, revoke/create and two writes straddling the
    // strike transition need real connections. The lock acquisition order is asserted above.
    expect(true).toBe(true);
  });
});
