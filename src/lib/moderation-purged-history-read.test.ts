// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR,
  ASSETS,
  POST,
  createAtomicTestDatabase,
  type TestDatabase,
} from "./community-atomic-save-test-db";
import { parseModerationCase } from "./moderation-case-parser";

// R4-E4: el read model de moderación después del purge. SQL REAL (migraciones hasta 20261022) sobre
// PGlite; la salida de la RPC pasa por el parser REAL. El reloj de la lectura se sustituye por un
// seam SOLO dentro de la transacción de prueba (la migración no tiene parámetro "now").

const migration = (n: string) => readFileSync(`supabase/migrations/${n}`, "utf8");
const E1 = migration("20261020120000_community_media_purge_lifecycle.sql");
const E4 = migration("20261022120000_moderation_purged_history_read.sql");
const reporters = [1, 2, 3].map(
  (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`,
);
const SECRET_TEXT = "post-body-that-must-not-survive-the-window";
const SECRET_MESSAGE = "mensaje-del-moderador-que-se-conserva";
let db: TestDatabase;

interface Audit {
  id: string;
  action: string;
  actorKind: string;
  createdAt: string;
  states: Record<string, unknown>;
}
interface CaseRead {
  post: { text: string | null; status: string } | null;
  media: unknown[];
  decision: { resolutionMessage: string | null; result: string } | null;
  reports: unknown[];
  audit: Audit[];
  caseStatus: string;
  cycleStatus: string;
}
const one = async <T>(sql: string, params: unknown[] = []) =>
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
  ])
    await db.exec(migration(n));
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
  try {
    await db.exec("reset role");
  } catch {
    /* aborted transaction */
  }
  await db.exec("rollback");
});

async function decide(result: "content_actioned" | "reports_not_valid") {
  let ctx!: Record<string, unknown>;
  for (const r of reporters)
    ctx = await one(`select community_post_report_submit($1,$2,'spam',null) r`, [
      r,
      POST,
    ]);
  await db.query("select community_moderation_case_decide($1,$2,$3,$4,$5,$6,$7)", [
    ACTOR,
    ctx.caseId,
    ctx.cycleId,
    ctx.caseVersion,
    ctx.postVersion,
    result,
    result === "content_actioned" ? SECRET_MESSAGE : null,
  ]);
  return { caseId: ctx.caseId as string, cycleId: ctx.cycleId as string };
}
const deadline = async () =>
  (
    await db.query<{ t: string }>(
      "select purge_after::text t from community_posts where id=$1",
      [POST],
    )
  ).rows[0].t;
const setNow = (iso: string, offsetMs: number) =>
  db.query(
    "select set_config('upmina.test_now',($1::timestamptz+$2*interval '1 millisecond')::text,true)",
    [iso, offsetMs],
  );
/** Production definition of the reader with ONLY the clock replaced (rolled back with the test). */
async function readerSeam() {
  const fn = E4.slice(
    E4.indexOf("create or replace function public.community_moderation_cycle_read"),
    E4.indexOf("alter function public.community_moderation_cycle_read"),
  );
  expect(fn).toContain("clock_timestamp()");
  await db.exec(
    fn.replaceAll("clock_timestamp()", "current_setting('upmina.test_now')::timestamptz"),
  );
}
async function purgeAt(offsetMs: number, base?: string) {
  const src = E1.match(
    /create function public\.community_purge_due_posts\([\s\S]*?\n\$\$;/,
  )![0]
    .replace(
      "v_now timestamptz := clock_timestamp();",
      "v_now timestamptz := current_setting('upmina.test_now')::timestamptz;",
    )
    .replace("create function", "create or replace function");
  await db.exec(src);
  await setNow(base ?? (await deadline()), offsetMs);
  return one<{ purged: number }>("select community_purge_due_posts(50) r");
}
const read = (cycleId: string, detail = true) =>
  one<CaseRead>("select community_moderation_cycle_read($1,$2) r", [cycleId, detail]);

describe("A. Procede, window still open", () => {
  it("moderator sees text and media references; the resolution is the moderator message", async () => {
    const { cycleId } = await decide("content_actioned");
    await readerSeam();
    await setNow(await deadline(), -1);
    const r = await read(cycleId);
    expect(r.post).toMatchObject({ status: "removed_pending_purge", text: SECRET_TEXT });
    expect(r.media.length).toBeGreaterThan(0);
    expect(r.decision).toMatchObject({
      result: "content_actioned",
      resolutionMessage: SECRET_MESSAGE,
    });
    expect(r.audit.map((a) => a.action)).not.toContain("post_purged");
    parseModerationCase({ ...r, media: [] }); // real parser accepts the real projection
  });
});

describe("B/C. Boundary and expired-but-row-still-exists", () => {
  it.each([[0], [1], [3_600_000]])(
    "offset %i ms: no text, no media; history intact and parsable",
    async (offset) => {
      const { cycleId } = await decide("content_actioned");
      await readerSeam();
      await setNow(await deadline(), offset);
      for (const detail of [true, false]) {
        const r = await read(cycleId, detail);
        expect(r.post).toMatchObject({ status: "removed_pending_purge", text: null });
        expect(r.media).toEqual([]);
        expect(r.decision!.resolutionMessage).toBe(SECRET_MESSAGE);
        if (detail) expect(r.reports).toHaveLength(3);
        const parsed = parseModerationCase({ ...r, media: [] });
        expect(parsed.post!.text).toBeNull();
        expect(JSON.stringify(parsed)).not.toContain(SECRET_TEXT);
      }
    },
  );
});

describe("D. Physically purged", () => {
  async function purged() {
    const { cycleId, caseId } = await decide("content_actioned");
    const before = (
      await db.query<{ n: string }>(
        "select (select count(*) from community_moderation_cases)||'/'||(select count(*) from community_moderation_cycles) n",
      )
    ).rows[0].n;
    expect(await purgeAt(1)).toMatchObject({ purged: 1 });
    const after = (
      await db.query<{ n: string }>(
        "select (select count(*) from community_moderation_cases)||'/'||(select count(*) from community_moderation_cycles) n",
      )
    ).rows[0].n;
    expect(after).toBe(before); // the purge opens no new case/cycle
    return { cycleId, caseId };
  }
  it("post is null; decision, reports and audit remain; post_purged is listed and parsed", async () => {
    const { cycleId } = await purged();
    const r = await read(cycleId);
    expect(r.post).toBeNull();
    expect(r.media).toEqual([]);
    expect(r.decision).toMatchObject({ resolutionMessage: SECRET_MESSAGE });
    expect(r.reports).toHaveLength(3);
    const purge = r.audit.find((a) => a.action === "post_purged")!;
    expect(purge).toBeTruthy();
    expect(purge.actorKind).toBe("system");
    // only the projected keys; never the raw metadata (post id, decision id, asset counts)
    expect(Object.keys(purge).sort()).toEqual(
      ["actorKind", "action", "createdAt", "id", "states"].sort(),
    );
    expect(Object.values(purge.states).every((v) => v === null)).toBe(true);
    const parsed = parseModerationCase({ ...r, media: [] });
    expect(parsed.post).toBeNull();
    expect(parsed.audit.some((a) => a.action === "post_purged")).toBe(true);
    expect(parsed.decision?.resolutionMessage).toBe(SECRET_MESSAGE);
  });
  it("never resurrects the post text and never exposes reporter identity", async () => {
    const { cycleId } = await purged();
    const json = JSON.stringify(await read(cycleId));
    expect(json).not.toContain(SECRET_TEXT);
    for (const id of reporters) expect(json).not.toContain(id);
    expect(json).not.toMatch(
      /removal_decision_id|assets_marked|assets_retained|purged_at/,
    );
  });
  it("the closed cycle stays in History and never reappears in Active", async () => {
    const { cycleId } = await purged();
    const list = (scope: string) =>
      one<{ cases: { cycleId: string; post: unknown }[] }>(
        "select community_moderation_cases_read($1,$2) r",
        [ACTOR, scope],
      );
    expect((await list("active")).cases.map((c) => c.cycleId)).not.toContain(cycleId);
    const closed = (await list("closed")).cases.find((c) => c.cycleId === cycleId)!;
    expect(closed).toBeTruthy();
    expect(closed.post).toBeNull();
    const direct = await one<{ item: { cycleId: string } }>(
      "select community_moderation_cases_read($1,'closed',null,null,$2) r",
      [ACTOR, cycleId],
    );
    expect(direct.item.cycleId).toBe(cycleId);
  });
});

describe("E/F. Unaffected cases", () => {
  it("No procede: the post stays published, text visible, nothing to purge", async () => {
    const { cycleId } = await decide("reports_not_valid");
    const r = await read(cycleId);
    expect(r.post).toMatchObject({ status: "published", text: SECRET_TEXT });
    expect(r.decision).toMatchObject({
      result: "reports_not_valid",
      resolutionMessage: null,
    });
    expect(r.audit.map((a) => a.action)).not.toContain("post_purged");
    expect(parseModerationCase({ ...r, media: [] }).post!.status).toBe("published");
    expect(await purgeAt(1, "2100-01-01T00:00:00Z")).toMatchObject({ purged: 0 });
  });
  it("a historically hidden post keeps its text for moderators and is never purged", async () => {
    for (const r of reporters)
      await db.query("select community_post_report_submit($1,$2,'spam',null)", [r, POST]);
    const cycleId = (
      await db.query<{ id: string }>("select id from community_moderation_cycles limit 1")
    ).rows[0].id;
    await db.query(
      "update community_posts set status='hidden',quarantine_cycle_id=null where id=$1",
      [POST],
    );
    const r = await read(cycleId);
    expect(r.post).toMatchObject({ status: "hidden", text: SECRET_TEXT });
    expect(await purgeAt(1, "2100-01-01T00:00:00Z")).toMatchObject({ purged: 0 });
  });
});

describe("migration 20261022 source", () => {
  it("differs from the E1 reader only by the post_purged exclusion", () => {
    const def = (s: string) =>
      s
        .slice(
          s.indexOf("create or replace function public.community_moderation_cycle_read"),
          s.indexOf("revoke all on function public.community_moderation_cycle_read"),
        )
        .replace(/\r\n/g, "\n");
    expect(def(E1).replace("where a.action <> 'post_purged' and", "where")).toBe(def(E4));
    expect(E4).not.toMatch(
      /\b(alter table|create table|drop |insert into|delete from)\b/i,
    );
  });
});

describe("Author surface (owner)", () => {
  const AUTHOR_FN = readFileSync(
    "supabase/migrations/20261018120000_community_author_resolved_notice_flag.sql",
    "utf8",
  );
  async function ownerRead() {
    return one<{ items: { id: string; status: string; moderation: { kind: string } }[] }>(
      "select community_author_posts_read($1,$2,false) r",
      [ACTOR, POST],
    );
  }
  async function authorSeam() {
    const fn = AUTHOR_FN.slice(
      AUTHOR_FN.indexOf("create or replace function public.community_author_posts_read"),
      AUTHOR_FN.indexOf("alter function public.community_author_posts_read"),
    );
    expect(fn).toContain("clock_timestamp()");
    await db.exec(
      fn.replaceAll(
        "clock_timestamp()",
        "current_setting('upmina.test_now')::timestamptz",
      ),
    );
  }
  it("before purge_after the owner still sees the withdrawn post", async () => {
    await decide("content_actioned");
    await authorSeam();
    await setNow(await deadline(), -1);
    const r = await ownerRead();
    expect(r.items).toHaveLength(1);
    expect(r.items[0].moderation.kind).toBe("withdrawn");
  });
  it("at/after purge_after (row still present) and after the physical purge: same product result, no error", async () => {
    await decide("content_actioned");
    await authorSeam();
    for (const offset of [0, 1, 3_600_000]) {
      await setNow(await deadline(), offset);
      expect((await ownerRead()).items).toEqual([]);
    }
    expect(await purgeAt(1)).toMatchObject({ purged: 1 });
    expect((await ownerRead()).items).toEqual([]);
  });
});
